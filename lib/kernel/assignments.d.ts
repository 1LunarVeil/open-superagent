import type { ReportState, Ticket } from './model.ts';
import { EnginePart, type EngineOptions } from './part.ts';
import type { Replies } from './replies.ts';
import { type Tickets } from './tickets.ts';
/** What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error). */
export interface WorkerReport {
    state: ReportState;
    summary: string;
    /** Open question for a person: a string asks it, `null` clears an open one, and `undefined` keeps the current one. */
    question?: string | null;
    /** The person's message whose request raised the question; routes the question to the channel where it was written. */
    askedBy?: string;
    /** The person's question this report answers, which the worker thereby takes up; authorizes the main Session to send an answer reply. */
    answers?: string;
}
/**
 * Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
 * reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
 * interrupted it, and a worker's report with its question for a person. It depends on
 * Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
 * Executor's lifecycle callbacks and its workers' reports here.
 */
export declare class Assignments extends EnginePart {
    private readonly tickets;
    private readonly replies;
    constructor(options: EngineOptions, tickets: Tickets, replies: Replies);
    /** Marks a non-ended assignment running, queues delivery of waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
    started(ticketId: string, assignmentId: string): void;
    /**
     * Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
     * longer running. Its worker reads each once its Session takes it into a step (see `read`).
     */
    delivered(ticketId: string, assignmentId: string, inputIds: string[]): void;
    /** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
    read(ticketId: string, inputIds: string[]): void;
    turnEnded(ticketId: string, assignmentId: string): void;
    /**
     * Records that a worker took the assignment up, `worker-<assignmentId>` style evidence that it is really running.
     * Idempotent: the first claim wins, so a second read of the same ticket does not move the timestamp.
     */
    claimed(ticketId: string, assignmentId: string): void;
    deliveryFailed(ticketId: string, assignmentId: string, error: string): void;
    /**
     * Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
     * `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case it keeps its
     * session and flushes any waiting undelivered inputs.
     */
    interrupted(ticketId: string, assignmentId: string): void;
    /**
     * Records a worker status report on an open ticket's current assignment, updating `attention`, `answers`, held automated
     * inputs, and ending the ticket when `dropped` or when `ready` and not waiting on followed threads (`followsDone`).
     * @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
     * or a question/answer referencing a non-human or unreached trigger.
     */
    report(ticketId: string, report: WorkerReport): Ticket;
    /** The ticket, while it is open and `assignmentId` runs it. */
    private running;
}
