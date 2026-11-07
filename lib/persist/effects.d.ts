/**
 * Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
 * Effects reschedules the row after the initial retry delay without incrementing its failure count, and the Executor throws it from launch and delivery handlers.
 */
export declare class Later extends Error {
}
/** Consecutive failures before an effect kind reports an error, matching the Sources poll failure threshold. */
export declare const FAILURES_BEFORE_ERROR = 3;
import type { HealthBoard } from './health.ts';
import type { Store } from './store.ts';
export interface EffectPayloads {
    /** Build an Eval's candidate card and hand it to the orchestrator; the key is the Eval ID. */
    assessment: {
        triggerId: string;
    };
    /** Launch a pending Assignment; the key is the Assignment ID. */
    launch: {
        ticketId: string;
        assignmentId: string;
    };
    /** Hand a ticket's waiting Inputs to its running Assignment; the key is the Ticket ID. */
    delivery: {
        ticketId: string;
        assignmentId: string;
    };
    /** Steer a report or a candidate to the orchestrator; the key is the request ID. */
    relay: {
        text: string;
    };
    /** Record a notice for the orchestrator without waking it; the key names what it reports, such as `prompts`. */
    notice: {
        value: Record<string, unknown>;
        summary: string;
    };
    /** Send a message for a Channel through its Source; the key is the message ID, whose receipt the Outbox keeps. */
    reply: Record<string, never>;
}
export type EffectKind = keyof EffectPayloads;
interface Handler<K extends EffectKind> {
    run: (payload: EffectPayloads[K], key: string) => Promise<void>;
    /** How many may run at once now; 0 holds the kind, such as while processing is paused. */
    limit: () => number;
    /** Initial and maximum retry backoff delays, in milliseconds. */
    retry: readonly [number, number];
    /** Effects run one at a time in queue order, and a failed one holds back later rows of the same kind. */
    ordered: boolean;
    /** When true, repeated failures do not mark the effect kind's health entry as `error` (used when failures are already surfaced on a ticket). */
    quiet: boolean;
}
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>;
/**
 * Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
 * Coordinates per-kind handlers, concurrency limits, exponential backoff, and health reporting for the Assessor, Executor, Sessions, and Outbox.
 */
export declare class Effects {
    private readonly store;
    private readonly board;
    private readonly now;
    private readonly handlers;
    private readonly health;
    private readonly tasks;
    /** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
    private readonly broken;
    private seq;
    private scheduled;
    /** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
    private started;
    private stopped;
    constructor(store: Store, board: Pick<HealthBoard, 'claim'>, now?: () => number);
    /** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
    enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void;
    handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options?: Options<K>): void;
    pending(kind: EffectKind, key?: string): boolean;
    /** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
    cancel(kind: EffectKind, key: string): void;
    start(): void;
    kick(): void;
    /** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
    idle(kind?: EffectKind): Promise<void>;
    /** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
    drain(): Promise<void>;
    private dispatch;
    private run;
    private attempt;
    private failed;
    private report;
}
export {};
