import { Engine } from '../kernel/index.ts';
import { Actions } from './actions.ts';
import type { Health } from '../persist/health.ts';
import { Effects } from '../persist/effects.ts';
import { Passes } from '../persist/passes.ts';
import { Settings } from '../persist/settings.ts';
import { Store } from '../persist/store.ts';
/** Options for `Runtime.open`. */
export interface RuntimeOptions {
    stateDir: string;
    /** The project repository tickets are cut from; a host sets it to its workspace root. */
    projectDir?: string;
    /** Receives one-line diagnostics; defaults to stderr. */
    log?: (message: string) => void;
}
/** The state directory is held by another daemon instance; the entry point exits with code 3. */
export declare class StateLocked extends Error {
    constructor();
}
export declare class Runtime {
    readonly stateDir: string;
    readonly projectDir?: string;
    readonly store: Store;
    readonly effects: Effects;
    readonly actions: Actions;
    private readonly board;
    private releaseLock?;
    private readonly stopped;
    private readonly log;
    private lead;
    private takeover?;
    private stoppingFlag;
    private stopPromise?;
    /** Built by `initialize`, which runs before any Engine command or MCP tool can run. */
    engine: Engine;
    settings: Settings;
    private assessor;
    private executor;
    private outbox;
    private passesRef?;
    private constructor();
    /**
     * Creates the runtime and opens the Store. The state directory lock is not a gate: ZCode starts one MCP server per
     * session, so several daemons legitimately share one project's database. The first one becomes the leader — the only
     * process that dispatches effects and runs passes — and the rest serve tools against the same SQLite file, taking over
     * the leadership if it closes. Refusing to start instead would leave every second session with no tools at all.
     */
    static open(options: RuntimeOptions): Promise<Runtime>;
    /** Whether this process owns scheduling (passes and effects) for the state directory. */
    get isLeader(): boolean;
    /** Wires the domain and its ports; called once, before the MCP server connects and before scheduling starts. */
    initialize(): Promise<void>;
    /**
     * Seeds the local operator into the manual Source's allowlist on first run. Without it the person at the keyboard is an
     * unlisted sender, so their explicit requests are gate-ignored and the plugin appears inert. The guard is "the policy
     * block was never saved", not "no settings were ever saved": pausing or changing the executor first must not block the
     * seed, and a policy the operator later edits is never overwritten.
     */
    private seedLocalOperator;
    /** The orchestration passes; the daemon starts them once the MCP server is connected. */
    get passes(): Passes;
    /** All health entries, for status and health tools. */
    healthSnapshot(): Readonly<Record<string, Health>>;
    /** Idempotent stop; concurrent or repeated calls share one shutdown. */
    stop(): Promise<void>;
    /**
     * Starts scheduling when this process leads: passes and effect dispatch. A follower does nothing here, because another
     * process already dispatches for the same database and running two dispatchers would duplicate effects.
     */
    /**
     * Starts scheduling when this process leads, and otherwise keeps trying to take leadership over from whichever session
     * currently has it. A follower still serves every tool against the shared database; taking over only matters for effects,
     * which must have exactly one dispatcher.
     */
    startScheduling(): void;
    /** True once this runtime either leads or is polling to take over from the session that does. */
    get scheduling(): boolean;
    /**
     * Joins the running effects and passes, so a tool call that depends on them observes their outcome. A follower has no
     * dispatcher of its own; it waits on the leader indirectly by re-reading the database in the caller.
     */
    private settle;
    /**
     * Keeps trying to become the leader while another session owns scheduling. When it succeeds, effects that piled up
     * while nobody dispatched start moving again, which is what makes closing the original session harmless.
     */
    private watchForLeadership;
    /** Stops the passes, drains the effect queue, then closes the Store before releasing the lock, so another process cannot open the database mid-write. */
    private shutdown;
    /** The Settings instance, once built; the Engine's policy reads it lazily because Settings is wired after the Engine. */
    private settingsRef;
    /**
     * Fills a new ticket's `execution` from the Executor settings, so the launch handler and the worker prompt share one
     * decision about the directory and short name. Upstream did the same in `DshExecutor.prepare`.
     */
    private prepareTicket;
    /** Turns domain events into orchestrator notices for the few facts a person must see before the next tick. */
    private onEvent;
    /**
     * The v1 manual Source scope: every trigger is listened to and observed, and the receiving scope row is the
     * conversation key from the trigger's `meta.threadId` (or the default row when a Source sends none).
     */
    private scopeFor;
    /**
     * The manual ReplySenders for the Outbox: v1 has no channel adapters, so `instance` knows only the manual Source, every
     * channel is allowed, and a send is recorded as a `reply_recorded` action the orchestrator acts on from its tick. The
     * manual channel is the session's own conversation, so the orchestrator delivers that text verbatim rather than
     * paraphrasing it.
     */
    private manualSenders;
}
