import type { Candidate, ChannelRef, ThreadRef, TicketStage, Trigger } from '../kernel/index.ts';
import type { Store } from '../persist/store.ts';
/** How long a handed-out action stays leased before it can be handed out again. */
export declare const LEASE_MS: number;
/** How long a delivered action is kept, so a status read can explain what the orchestrator already did. */
export declare const RETENTION_MS: number;
/** A candidate card: the bounded facts an assessor judges, rendered without authority. */
export interface CandidateCard {
    evalId: string;
    threadKey: string;
    strength: 'explicit' | 'inferred';
    /** The batch, oldest first; `text` is cut at 2000 characters. */
    triggers: {
        id: string;
        at: string;
        actor: {
            source: string;
            id: string;
        };
        human: boolean;
        addressed?: string;
        text: string;
        url?: string;
    }[];
    /** Tickets already on the thread, for duplicate judgement, each with its stage (docs/003). */
    tickets: {
        id: string;
        title: string;
        ended: boolean;
        stage: string;
    }[];
    /** Bounded thread context around the batch: the newest triggers outside the batch, `text` cut at 500 characters, at most 10 kept. */
    context: {
        id: string;
        at: string;
        actor: {
            source: string;
            id: string;
        };
        human: boolean;
        text: string;
    }[];
}
/** One unit of work the main session reads on its next tick and acts on through the open-superagent skill. */
export type PendingAction = {
    kind: 'assess_candidate';
    evalId: string;
    card: CandidateCard;
} | {
    kind: 'spawn_worker';
    ticketId: string;
    assignmentId: string;
    title: string;
    prompt: string;
    directory: string;
} | {
    kind: 'deliver_inputs';
    ticketId: string;
    assignmentId: string;
    inputIds: string[];
    text: string;
    directory?: string;
} | {
    kind: 'relay';
    text: string;
    ticketId?: string;
} | {
    kind: 'notice';
    summary: string;
    value: Record<string, unknown>;
} | {
    kind: 'reply_recorded';
    messageId: string;
    channel: ChannelRef;
    text: string;
    messageKind: string;
    ticketId?: string;
};
/** A handed-out action: the protocol payload plus the row id that `ack` retires. */
export type HandedAction = PendingAction & {
    /** The queue row identity; the orchestrator passes it back with `superagent_tick_ack`. */
    actionId: string;
    /** Whether this handout is a retry after an earlier lease lapsed. */
    retry?: boolean;
};
/** Compact stage label for cards and status views, with the upstream ticket-card states (docs/003): person actions and the queued marker read like the upstream ticket cards. */
export declare function stageLabel(stage: TicketStage): string;
/**
 * Builds a candidate card for an Eval's assessor: the batch triggers, the tickets already on the thread, and the newest
 * thread context outside the batch. Facts only, no authority: the card never carries the Policy, which the main session
 * reads from its own settings.
 */
export declare function candidateCard(candidate: Candidate, context: Trigger[]): CandidateCard;
/** Builds the ThreadRef of the manual Source, whose thread ids are the main session's conversation keys. */
export declare const threadRefOf: (source: string, id: string) => ThreadRef;
/**
 * Durable pending-action queue over the Store's SQLite database.
 * Rows are written with their content hash as the id, so a retried writer or a replayed effect handler cannot queue an
 * action twice. `take` leases rows for a bounded time instead of retiring them, and `ack` retires exactly the rows the
 * orchestrator finished, so a lost session costs one lease rather than the work.
 */
export declare class Actions {
    private readonly store;
    private readonly now;
    constructor(store: Store, now?: () => number);
    /** Reconciles databases created before leases existed: the columns are added and every old row counts as delivered. */
    private addLeaseColumn;
    /** Records `action` idempotently (equal content keeps its first row); call inside the writer's transaction. */
    add(action: PendingAction, at: string): void;
    /**
     * Drops the ticket's undelivered actions, so the main session never acts on work the Engine has already ended or
     * replaced, and drops a pending candidate assessment whose card names this ticket: the work it would judge is gone.
     * Nothing is lost — an Eval whose card was dropped still holds its triggers and requeues on expiry with a fresh card,
     * and `notice` actions (which name no ticket) always stay.
     */
    cancelForTicket(ticketId: string): void;
    /** Every action that is waiting (never handed out) or whose lease lapsed, oldest first, as raw rows. */
    pending(): PendingAction[];
    /**
     * Leases every action that is waiting or whose lease lapsed and returns it with its row id, in queue order.
     * A row already leased to a live session is skipped, so two ticks in the same session never duplicate work.
     */
    take(): HandedAction[];
    /** Retires the actions the orchestrator finished; ids not in the queue are ignored, so a repeated ack is harmless. */
    ack(ids: readonly string[]): number;
    /**
     * Releases every lease held by a previous process. Only one daemon may own the state directory, so a lease found at
     * startup belongs to a session that is gone: keeping it would hide its actions for the whole lease window and `tick`
     * would answer "No pending actions" while work waits. Called once by the runtime before the MCP server accepts calls.
     */
    releaseAllLeases(): number;
    /** Drops the handed-out actions whose Eval no longer holds their trigger, so a decided candidate is not re-assessed. */
    dropStaleAssessments(holds: (triggerId: string) => boolean): number;
    /** Drops one handed-out action, for a step the domain shows is already served. */
    discard(id: string): void;
    /** Drops a handed-out action without acting on it (a spawn the domain already served), keeping the queue clean. */
    drop(id: string): void;
    /** Deletes delivered rows past the retention window so the queue does not grow without bound. */
    prune(): number;
    /** Count of rows still waiting (unleased or lease-lapsed), for status surfaces. */
    count(): number;
    /** How many actions are leased to the current session right now, and when the earliest lease lapses. */
    leased(): {
        count: number;
        until?: string;
    };
}
