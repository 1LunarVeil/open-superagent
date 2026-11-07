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
    private readonly releaseLock?;
    private readonly stopped;
    private readonly log;
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
     * Creates the runtime: makes the state directory private to the user, locks it against a second daemon, and opens the
     * SQLite Store. The lock has no periodic `update` refresh here — the type has no `null` for it and omitting it behaves
     * the same, refreshing at half the stale interval while this process lives.
     * @throws StateLocked when another daemon instance holds the state directory.
     */
    static open(options: RuntimeOptions): Promise<Runtime>;
    /** Wires the domain and its ports; called once, before the MCP server connects and before `passes.start()`. */
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
