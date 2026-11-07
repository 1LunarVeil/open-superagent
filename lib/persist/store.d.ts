/** SQLite persistence for domain aggregates, key-value state, settings history, and the channel outbox. */
import { DatabaseSync } from 'node:sqlite';
import { key, threadKey, type ChannelRef, type Decision, type OutboundMessage, type ReplyStatus, type Repositories, type Thread, type ThreadFact, type Ticket, type Trigger, type TriggerDisposition } from '../kernel/index.ts';
import { type Family, type Key } from './kv.ts';
import { type Settings, type SettingsOrigin, type SettingsSave } from '../kernel/policy.ts';
import { storeReads } from './store-read.ts';
/** A Trigger's position on its thread timeline, ordered by timestamp and then `id` as tie-breaker. */
export interface TimelinePlace {
    at: string;
    id: string;
}
/** Why a message was dropped: its conversation can never receive it (`channelGone`), or its Source no longer listens to it (`channelIgnored`). */
export type DropReason = 'channelGone' | 'channelIgnored';
/** Outbound message receipt tracked in the outbox from the moment it is queued (`pending`, `sent`, or `dropped`); delivery attempt counts live on its `reply` effect. */
export interface Receipt extends OutboundMessage {
    status: ReplyStatus;
    dropped?: {
        at: string;
        reason: DropReason;
    };
}
/** A dropped outbound message receipt, with the timestamp and reason it was dropped. */
export type Dropped = Receipt & {
    dropped: {
        at: string;
        reason: DropReason;
    };
};
/** Saved settings snapshot with the policy version and ticket notifications it produced (`internal` saves have no origin). */
export interface SettingsVersion {
    revision: number;
    savedAt: string;
    source: SettingsOrigin | 'internal';
    block?: SettingsSave;
    policyVersion: string;
    policyChanged: boolean;
    notified: string[];
    settings: Settings;
}
/** The only schema version this build creates or opens; databases below it predate the port and are refused. */
export declare const SCHEMA_VERSION = 11;
/**
 * SQLite backing store implementing domain `Repositories`, view read queries, versioned settings, outbox receipts, and key-value state.
 * The daemon opens it after locking the state directory; this build creates schema 11 only and refuses anything older.
 * The Engine mutates domain aggregates inside `atomic` transactions while Sources, views, and the Outbox read state or update their own records.
 */
export declare class Store implements Repositories {
    private readonly report;
    readonly db: DatabaseSync;
    /**
     * Opens or creates the SQLite database at `path`; this build only creates or opens schema 11 and does not port the schema 10 to 11 migration.
     * @param report - Receives errors thrown by `afterCommit` callbacks without failing the committed transaction.
     * @throws When the database schema is not `SCHEMA_VERSION` (11); in that case the database file is left unchanged and the SQLite handle is closed so a later attempt in the same process can open it.
     */
    constructor(path: string, report?: (error: unknown) => void);
    /** Reconciles generated working-set columns and indexes when opening databases created by earlier versions. */
    private addColumns;
    /** Closes the underlying SQLite database connection. */
    close(): void;
    /** Parses JSON `value` columns returned by `sql`. */
    private values;
    /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
    private indexThreads;
    private depth;
    /** Callbacks queued to run once the outermost transaction commits, indexed by savepoint level; rolling back a level discards its callbacks. */
    private readonly committed;
    /**
     * Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
     * Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
     */
    atomic<T>(operation: () => T): T;
    /**
     * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
     * callbacks queued inside a transaction that rolls back are discarded and never run.
     * Use `afterCommit` for immediate in-memory follow-ups to a committed write (such as refreshing health or cancelling an in-memory turn) that cannot wait for the effect queue and need not survive a restart; use `Effects` for durable side effects that must survive a crash.
     */
    afterCommit(action: () => void): void;
    /** Reads a typed KV record by its key in `KV`. */
    get<V>(name: Key<V>): V | undefined;
    /** Writes a typed KV record under `name`. */
    set<V>(name: Key<V>, value: V): void;
    /** Deletes the KV record at `name`. */
    delete(name: string): void;
    /** Returns all KV keys belonging to `family` or starting with `prefix`. */
    keys<V>(family: Family<V, never>): Key<V>[];
    keys(prefix: string): string[];
    /** Versioned settings snapshots; the current settings are the snapshot of the latest revision. */
    private readonly settingsVersions;
    /** Current validated settings. */
    settings(): Settings;
    /** Revision of one settings block; each configuration page saves against its own block for optimistic concurrency. */
    blockRevision(block: SettingsSave): number;
    /** Saves settings as the next revision (making it current) and increments `record.block`'s revision counter when present. */
    saveSettings(value: unknown, record?: Omit<SettingsVersion, 'revision' | 'savedAt' | 'settings'>): Settings;
    /** Saved settings revisions, newest first; revisions predating settings history are absent. */
    settingsHistory(limit?: number): SettingsVersion[];
    readonly triggers: {
        get: (id: string) => Trigger | undefined;
        save: (trigger: Trigger) => void;
        disposition: (id: string) => TriggerDisposition | undefined;
        saveDisposition: (id: string, value: TriggerDisposition) => void;
    };
    readonly threads: {
        get: (keyValue: string) => Thread | undefined;
        save: (thread: Thread) => void;
        list: () => Thread[];
        active: () => Thread[];
        /** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
        describe: (keyValue: string, patch: {
            label?: string;
            url?: string;
            facts?: Record<string, ThreadFact | null>;
        }) => void;
        /** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
        patchMeta: (keyValue: string, patch: Record<string, unknown>) => void;
    };
    readonly tickets: {
        get: (id: string) => Ticket | undefined;
        save: (ticket: Ticket) => void;
        /** Newest first. */
        list: () => Ticket[];
        /** Newest first. */
        open: () => Ticket[];
        /** Newest first. */
        active: () => Ticket[];
    };
    readonly decisions: {
        get: (id: string) => Decision | undefined;
        save: (decision: Decision) => void;
        byThread: (threadKeyValue: string) => Decision[];
    };
    /** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
    readonly read: ReturnType<typeof storeReads>;
    /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
    replyStatus(id: string): ReplyStatus | undefined;
    /** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
    readonly receipts: {
        get: (id: string) => Receipt | undefined;
        /** Pending message receipts, oldest first. */
        waiting: () => Receipt[];
        /** True if an earlier message for the same ticket and conversation is still pending with fewer than `failures` consecutive failed `reply` effect attempts. */
        behind: (id: string, failures: number) => boolean;
        /**
         * Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
         * @returns Whether the message ID was newly recorded.
         */
        add: (message: OutboundMessage) => boolean;
        /**
         * Marks a pending receipt as sent or dropped (with drop reason and timestamp), recreating the receipt if the message
         * was withdrawn while being sent so its ID cannot be queued again.
         */
        settle: (message: OutboundMessage, outcome: "sent" | DropReason) => void;
        /**
         * Withdraws a pending message that has not yet been sent.
         * @returns Whether a pending message with `id` was waiting and removed.
         */
        withdraw: (id: string) => boolean;
    };
}
export { key, threadKey };
export type { ChannelRef };
