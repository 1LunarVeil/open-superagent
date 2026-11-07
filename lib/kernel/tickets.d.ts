import type { Assignment, Evaluation, Follow, Mandate, PolicyEffect, ThreadRef, Ticket, TicketEndBy, TicketInput, TicketOutcome, Trigger } from './model.ts';
import type { AssessmentOutcome } from './ports.ts';
import { EnginePart, type EngineOptions } from './part.ts';
import type { Replies } from './replies.ts';
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
export declare const automatic: (input: TicketInput | undefined) => boolean;
/**
 * Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
 * Assignment, binds and attaches Threads, adds Inputs, resumes, retries, restarts, and ends tickets, and drops Subscriptions.
 * Coordinates with Replies for the acknowledgement an accept carries and with Executor to start, deliver to, and stop assignments.
 * Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
 */
export declare class Tickets extends EnginePart {
    private readonly replies;
    constructor(options: EngineOptions, replies: Replies);
    /**
     * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
     * Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
     * gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed.
     */
    create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>, outcome: Extract<AssessmentOutcome, {
        kind: 'accept';
    }>, at: string): void;
    /**
     * Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
     * @throws UserError when the ticket is unknown or has ended.
     */
    bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket;
    /**
     * Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
     * work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
     */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void;
    /**
     * How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
     * once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
     */
    followsDone(ticket: Ticket): Follow['closed'];
    /**
     * The Trigger to attach to a ticket, once the ticket may take it.
     * @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or an ended ticket's Mandate no longer revalidates.
     */
    attachable(ticketId: string, triggerId: string): Trigger;
    /**
     * Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
     * then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
     * message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
     */
    attach(ticketId: string, trigger: Trigger, note?: string): void;
    /**
     * Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
     * @returns whether the status request input was queued.
     * @throws UserError when the ticket is unknown.
     */
    requestStatus(ticketId: string): boolean;
    /**
     * Stops a ticket on behalf of a human, ending any active assignments.
     * @throws UserError when the ticket is unknown.
     */
    stop(ticketId: string, reason?: string): Ticket;
    /**
     * Ends the stalled assignment of a retryable open ticket (`failed`, `blocked`, or failed input delivery) and starts a new one.
     * @throws UserError when the ticket is unknown or not retryable.
     */
    retry(ticketId: string): Ticket;
    /**
     * Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
     * @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
     */
    markUnrelated(ticketId: string, thread: string, reason: string): void;
    /**
     * Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
     * were accepted; the others are left alone.
     */
    policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void;
    /**
     * Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
     * followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
     * it received from the Thread.
     */
    dropSubscriptions(thread: string, by: 'person' | 'executor', ticketId?: string, reason?: string): boolean;
    /** Record that the ticket's workspace is ready, so a retry never repeats a preparation that succeeded. */
    markPrepared(ticketId: string, at: string): void;
    /**
     * Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
     * failed once no person is waited for: a Policy change alone does not launch it again.
     */
    addInput(ticket: Ticket, input: TicketInput): void;
    /**
     * Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
     * and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
     * takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
     * the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
     */
    wake(ticketId: string): void;
    /** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
    private triggersOf;
    /**
     * Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
     * acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
     */
    private takenUp;
    /** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
    private untaken;
    /**
     * A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the person's
     * messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
     * that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
     * up, a Decision settled it, or it is the message a stop ended this ticket on.
     */
    private letGo;
    /** An ended ticket that cannot resume takes none of the messages that waited for it (see `letGo`). */
    private refuse;
    /** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
    restart(ticket: Ticket, running: Assignment, reason: string, note: string): void;
    /**
     * Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
     * have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
     * in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
     */
    private requeueUntaken;
    /**
     * End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
     * why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
     * the person's messages it decides that its worker did not read before its latest report or turn end, the report that
     * ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
     * the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
     */
    end(ticketId: string, by: TicketEndBy, outcome: TicketOutcome, at?: string, reason?: string): void;
    /**
     * Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
     * has not reported other than progress, or ended a turn, since its Session took that message into a step, or work resumed
     * after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
     * change asks for no work.
     */
    private unfinished;
    /** Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket. */
    private newAssignment;
    private endAssignment;
    /**
     * Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
     * @throws UserError when the ticket is unknown or has ended.
     */
    note(ticketId: string, text: string): Ticket;
    /**
     * Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
     * @returns false when the ticket follows the Thread already.
     * @throws UserError when the ticket is unknown or has ended.
     */
    followForContext(ticketId: string, ref: ThreadRef): boolean;
    /** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
    private subscribe;
}
