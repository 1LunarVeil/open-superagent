import type { Thread, ThreadRef, Ticket, Trigger } from './model.ts';
import type { Assessor, AssessmentOutcome, DomainEvent, DomainEvents, Executor, Outbox, Policy, Repositories, SourceScope } from './ports.ts';
export interface EngineOptions {
    repo: Repositories;
    policy: () => Policy;
    /** Decides whether a Source listens to a trigger; one it does not listen to is stored with a `filtered` disposition. */
    scope: SourceScope;
    assessor: Assessor;
    executor: Executor;
    outbox: Outbox;
    prepareTicket?: (ticket: Ticket, outcome: Extract<AssessmentOutcome, {
        kind: 'accept';
    }>) => Ticket;
    now?: () => string;
    emit?: (event: DomainEvent) => void;
}
/**
 * Base class for Intake, Evals, Tickets, Assignments, and Replies providing shared access to repositories, policy, clock, and event emission.
 * Each subclass mutates its own domain aggregates and delegates cross-aggregate changes to sibling parts within the transaction opened by Engine.
 */
export declare abstract class EnginePart {
    protected readonly options: EngineOptions;
    protected readonly repo: Repositories;
    constructor(options: EngineOptions);
    protected now(): string;
    protected policy(): Policy;
    /** The tickets whose worker decides a person's follow-up: see `followupOwners`. */
    protected owners(trigger: Trigger): string[];
    /** Refuse a main-Session routing of a follow-up a ticket's worker still decides. */
    protected leftToWorkers(trigger: Trigger): void;
    /**
     * Record that a ticket's worker hands back a Trigger that reached the ticket, with why, and queue it for Eval when the
     * ticket decided it and no other ticket still does. One the ticket did not decide, such as a bot's, one a person sent to
     * Eval or one on a Thread it follows for context, went to Eval without it.
     * @returns whether it was queued.
     */
    protected handBack(ticketId: string, trigger: Trigger, reason: string): boolean;
    /** Record that a ticket's worker took a person's message up as within the ticket, by acknowledging or answering it. */
    protected takeUp(ticketId: string, triggerId: string): void;
    /** Queue a Trigger on its primary Thread for the next Eval, unless it waits there already or an Eval holds it. */
    protected queueForEval(trigger: Trigger): boolean;
    protected emit<K extends keyof DomainEvents>(type: K, data: DomainEvents[K]): void;
    protected require(ticketId: string): Ticket;
    /** Returns the stored Thread or an unsaved empty Thread aggregate. */
    protected thread(ref: ThreadRef): Thread;
    protected ticketsOnThread(thread: Thread): Ticket[];
    protected source(ticket: Ticket): Trigger | undefined;
    protected reaches(ticket: Ticket, trigger: Trigger, context?: boolean): boolean;
}
