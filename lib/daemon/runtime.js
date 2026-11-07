/**
 * Composition root and lifecycle owner of the open-superagent daemon: it locks the state directory, opens the Store, and
 * wires Engine, Sources scope, Assessor, Executor, Outbox, Settings, Actions, Effects, and Passes. Port note: upstream
 * locks its state directory the same way before opening SQLite, so concurrent processes cannot corrupt or double-migrate
 * state. Wiring is two-phase — `open` builds the storage parts, `initialize` builds the Engine and installs its ports —
 * because the Assessor, Executor, and Outbox all register their effect handlers on an Effects that must exist first, while
 * the Engine that calls those ports needs them in hand at its own construction.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { Engine } from "../kernel/index.js";
import { policyVersion, SettingsSchema, settingsPolicy } from "../kernel/policy.js";
import { Actions } from "./actions.js";
import { MasterAssessor } from "./assessor.js";
import { ZcodeExecutor } from "./executor.js";
import { HealthBoard } from "../persist/health.js";
import { Effects } from "../persist/effects.js";
import { Outbox } from "../persist/outbox.js";
import { Passes } from "../persist/passes.js";
import { Settings } from "../persist/settings.js";
import { Store } from "../persist/store.js";
/** The state directory is held by another daemon instance; the entry point exits with code 3. */
export class StateLocked extends Error {
    constructor() {
        super('open-superagent state directory is locked by another daemon instance');
    }
}
/**
 * How often a follower retries the state-directory lock. When the owning session closes, one follower takes over so
 * effects keep being dispatched without the person noticing.
 */
const TAKEOVER_MS = 5_000;
export class Runtime {
    stateDir;
    projectDir;
    store;
    effects;
    actions;
    board;
    releaseLock;
    stopped = new AbortController();
    log;
    lead;
    takeover;
    stoppingFlag = false;
    stopPromise;
    /** Built by `initialize`, which runs before any Engine command or MCP tool can run. */
    engine;
    settings;
    assessor;
    executor;
    outbox;
    passesRef;
    constructor(parts) {
        this.stateDir = parts.stateDir;
        this.projectDir = parts.projectDir;
        this.store = parts.store;
        this.board = parts.board;
        this.effects = parts.effects;
        this.actions = parts.actions;
        this.releaseLock = parts.release;
        this.lead = parts.leader;
        this.log = parts.log;
    }
    /**
     * Creates the runtime and opens the Store. The state directory lock is not a gate: ZCode starts one MCP server per
     * session, so several daemons legitimately share one project's database. The first one becomes the leader — the only
     * process that dispatches effects and runs passes — and the rest serve tools against the same SQLite file, taking over
     * the leadership if it closes. Refusing to start instead would leave every second session with no tools at all.
     */
    static async open(options) {
        const { stateDir, projectDir } = options;
        const log = options.log ?? ((message) => { process.stderr.write('open-superagent: ' + message + '\n'); });
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
        const release = await lock(stateDir, { stale: 30_000, realpath: false }).catch(() => undefined);
        try {
            const store = new Store(join(stateDir, 'open-superagent.sqlite'), error => log(String(error)));
            const board = new HealthBoard();
            const effects = new Effects(store, board);
            const actions = new Actions(store);
            return new Runtime({ stateDir, projectDir, store, board, effects, actions, ...(release ? { release } : {}), leader: !!release, log });
        }
        catch (error) {
            await release?.().catch(() => { });
            throw error;
        }
    }
    /** Whether this process owns scheduling (passes and effects) for the state directory. */
    get isLeader() { return this.lead; }
    /** Wires the domain and its ports; called once, before the MCP server connects and before scheduling starts. */
    async initialize() {
        const assessor = this.assessor = new MasterAssessor();
        const executor = this.executor = new ZcodeExecutor();
        const outbox = this.outbox = new Outbox({
            store: this.store,
            effects: this.effects,
            sources: this.manualSenders(),
            paused: () => this.settingsRef()?.get().paused ?? false,
        });
        // The v1 Sources scope: one manual Source that listens to and observes everything.
        const scope = { scope: input => this.scopeFor(input) };
        const engine = this.engine = new Engine({
            repo: this.store,
            scope,
            // Lazy because Settings is built after the Engine; until then the Store's current settings are the same value.
            policy: () => settingsPolicy(this.settingsRef()?.get() ?? this.store.settings(), scope),
            assessor,
            executor,
            outbox,
            // The Executor owns the ticket's physical workspace, so it fills `execution` before the Engine saves the ticket.
            prepareTicket: (ticket, outcome) => this.prepareTicket(ticket, outcome),
            emit: event => this.onEvent(event),
        });
        const settings = this.settings = new Settings(this.store, engine, () => scope);
        assessor.install({
            effects: this.effects,
            actions: this.actions,
            engine,
            store: this.store,
            paused: () => settings.get().paused,
        });
        executor.install({
            effects: this.effects,
            actions: this.actions,
            engine,
            store: this.store,
            slots: () => settings.get().executor.maxWorkers,
            paused: () => settings.get().paused,
            workRoot: () => settings.get().executor.directory || join(this.stateDir, 'work'),
            projectDir: () => this.projectDir,
            worktree: () => settings.get().executor.worktree,
            prepareTimeoutMs: () => settings.get().executor.prepareTimeoutSeconds * 1000,
            baseRef: () => 'HEAD',
            log: this.log,
        });
        this.passesRef = new Passes({
            engine,
            effects: this.effects,
            health: this.board.claim('runtime', { state: 'starting', detail: 'Opening state' }),
            lifetime: this.stopped.signal,
            configured: () => true,
            closing: () => this.stoppingFlag,
        });
        // Queue rows written by an earlier run wait until a dispatcher starts. Only the leader dispatches: a follower shares
        // the same database and must not run a second copy of every effect.
        if (this.lead)
            this.effects.start();
        // A lease in the database belongs to a session that no longer exists (one daemon owns a state directory), so release
        // them all: otherwise the first tick in the new session answers "No pending actions" while work waits out the lease.
        const released = this.actions.releaseAllLeases();
        if (released)
            this.log('Released ' + String(released) + ' lease(s) held by a previous session');
        this.seedLocalOperator();
    }
    /**
     * Seeds the local operator into the manual Source's allowlist on first run. Without it the person at the keyboard is an
     * unlisted sender, so their explicit requests are gate-ignored and the plugin appears inert. The guard is "the policy
     * block was never saved", not "no settings were ever saved": pausing or changing the executor first must not block the
     * seed, and a policy the operator later edits is never overwritten.
     */
    seedLocalOperator() {
        const settings = this.store.settings();
        if (this.store.blockRevision('policy') > 0)
            return;
        const manual = settings.policy.sources.manual;
        if (manual?.allowed?.length)
            return;
        const seeded = SettingsSchema.parse({
            ...settings,
            policy: { ...settings.policy, sources: { ...settings.policy.sources, manual: { ...manual, allowed: [{ id: 'operator', name: 'Operator' }] } } },
        });
        this.store.saveSettings(seeded, { source: 'internal', block: 'policy', policyVersion: policyVersion(seeded), policyChanged: true, notified: [] });
    }
    /** The orchestration passes; the daemon starts them once the MCP server is connected. */
    get passes() {
        if (!this.passesRef)
            throw new Error('The runtime is not initialized');
        return this.passesRef;
    }
    /** All health entries, for status and health tools. */
    healthSnapshot() { return this.board.all; }
    /** Idempotent stop; concurrent or repeated calls share one shutdown. */
    stop() {
        this.stoppingFlag = true;
        return this.stopPromise ??= this.shutdown();
    }
    /**
     * Starts scheduling when this process leads: passes and effect dispatch. A follower does nothing here, because another
     * process already dispatches for the same database and running two dispatchers would duplicate effects.
     */
    /**
     * Starts scheduling when this process leads, and otherwise keeps trying to take leadership over from whichever session
     * currently has it. A follower still serves every tool against the shared database; taking over only matters for effects,
     * which must have exactly one dispatcher.
     */
    startScheduling() {
        if (this.stoppingFlag)
            return;
        if (this.lead) {
            this.effects.start();
            this.passesRef?.start();
        }
        else
            this.watchForLeadership();
    }
    /** True once this runtime either leads or is polling to take over from the session that does. */
    get scheduling() { return this.lead || !!this.takeover; }
    /**
     * Joins the running effects and passes, so a tool call that depends on them observes their outcome. A follower has no
     * dispatcher of its own; it waits on the leader indirectly by re-reading the database in the caller.
     */
    async settle() {
        if (this.lead)
            await this.passesRef?.idle();
    }
    /**
     * Keeps trying to become the leader while another session owns scheduling. When it succeeds, effects that piled up
     * while nobody dispatched start moving again, which is what makes closing the original session harmless.
     */
    watchForLeadership() {
        if (this.lead || this.takeover)
            return;
        this.takeover = setInterval(() => {
            if (this.lead || this.stoppingFlag)
                return;
            void lock(this.stateDir, { stale: 30_000, realpath: false }).then(release => {
                if (!release)
                    return;
                this.releaseLock = release;
                this.lead = true;
                this.log('Took over scheduling for ' + this.stateDir);
                this.effects.start();
                this.passesRef?.start();
            }, () => undefined);
        }, TAKEOVER_MS);
        // Do not keep the process alive just to poll for leadership.
        this.takeover.unref?.();
    }
    /** Stops the passes, drains the effect queue, then closes the Store before releasing the lock, so another process cannot open the database mid-write. */
    async shutdown() {
        if (this.takeover) {
            clearInterval(this.takeover);
            this.takeover = undefined;
        }
        await this.passesRef?.stop();
        try {
            // Only the leader dispatches effects, so only it has to drain them; a follower closing must not wait for the
            // leader's queue.
            if (this.lead)
                await this.effects.drain();
        }
        finally {
            try {
                this.store.close();
            }
            finally {
                try {
                    await this.releaseLock?.();
                }
                finally {
                    this.stopped.abort();
                }
            }
        }
    }
    /** The Settings instance, once built; the Engine's policy reads it lazily because Settings is wired after the Engine. */
    settingsRef() { return this.settings; }
    /**
     * Fills a new ticket's `execution` from the Executor settings, so the launch handler and the worker prompt share one
     * decision about the directory and short name. Upstream did the same in `DshExecutor.prepare`.
     */
    prepareTicket(ticket, outcome) {
        const settings = this.settingsRef()?.get() ?? this.store.settings();
        const root = settings.executor.directory || join(this.stateDir, 'work');
        const name = outcome.name?.trim() || ticket.id.slice(0, 12);
        return { ...ticket, execution: { name, directory: join(root, ticket.id.slice(0, 12)), assignment: ticket.title } };
    }
    /** Turns domain events into orchestrator notices for the few facts a person must see before the next tick. */
    onEvent(event) {
        // `decision.recorded` carries `{decisionId, kind, threadKey}` in `data`. An unavailable assessment is the one a person
        // must hear about: the trigger is stored and can be requeued, but nothing else will surface the failure.
        if (event.type !== 'decision.recorded')
            return;
        if (event.data?.kind !== 'unavailable')
            return;
        this.store.atomic(() => this.actions.add({
            kind: 'notice',
            summary: 'An evaluation could not be assessed and became unavailable; the trigger is stored and can be requeued.',
            value: { event: event.type, ...event.data },
        }, new Date().toISOString()));
    }
    /**
     * The v1 manual Source scope: every trigger is listened to and observed, and the receiving scope row is the
     * conversation key from the trigger's `meta.threadId` (or the default row when a Source sends none).
     */
    scopeFor(input) {
        return { listened: true, observed: true, row: String(input.meta?.threadId ?? 'default') };
    }
    /**
     * The manual ReplySenders for the Outbox: v1 has no channel adapters, so `instance` knows only the manual Source, every
     * channel is allowed, and a send is recorded as a `reply_recorded` action the orchestrator acts on from its tick. The
     * manual channel is the session's own conversation, so the orchestrator delivers that text verbatim rather than
     * paraphrasing it.
     */
    manualSenders() {
        return {
            instance: source => source === 'manual' ? { enabled: true } : undefined,
            channelAllowed: () => true,
            send: async (receipt) => {
                this.store.atomic(() => this.actions.add({
                    kind: 'reply_recorded',
                    messageId: receipt.id,
                    channel: receipt.channel,
                    text: receipt.text,
                    messageKind: receipt.kind,
                    ...(receipt.ticketId !== undefined ? { ticketId: receipt.ticketId } : {}),
                }, new Date().toISOString()));
                return 'sent';
            },
        };
    }
}
