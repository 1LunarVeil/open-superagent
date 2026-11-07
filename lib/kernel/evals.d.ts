import type { Decision, Thread, Trigger } from './model.ts';
import type { AssessmentOutcome, Candidate, Policy } from './ports.ts';
import { EnginePart, type EngineOptions } from './part.ts';
import type { Tickets } from './tickets.ts';
/** An outcome for the Eval that holds a Trigger; `evalId` names the Eval it was judged for, so a later Eval refuses it. */
export type Outcome = AssessmentOutcome & {
    evalId?: string;
};
/**
 * Evals runs the Evals of Threads: it batches a Thread's queued Triggers into one Eval, takes its strength, actor, and basis
 * from the gate, asks the assessor, keeps its deadline through a pause, and records the Decision it ends with: accept, stop,
 * ignore, or unavailable. It depends on Tickets to create the ticket an accept decides and to end the one a stop names; the
 * Engine routes the main Session's decisions, people's replays, worker handbacks, and the pass's Eval work here.
 */
export declare class Evals extends EnginePart {
    private readonly tickets;
    constructor(options: EngineOptions, tickets: Tickets);
    /**
     * Expire a Thread's Eval past its deadline (see `expire`), unless processing is paused: then the Eval notes when the
     * processing pause began, and once processing resumes its deadline moves forward by the pause's length. An Eval whose
     * candidate has not reached the assessor does not count against its delivery deadline, but cannot stall forever either:
     * past `UNDELIVERED_STALL_MS` since it started it expires through the same requeue path.
     */
    due(thread: Thread, policy: Policy): void;
    /** An Eval's candidate reached the assessor: its deadline counts from now. */
    delivered(evalId: string, policy: Policy): void;
    /**
     * An Eval past its deadline queues its Triggers again for a fresh Eval, up to `REQUEUES` times in a row, so a busy
     * assessor does not drop requests; after that it is recorded unavailable.
     */
    private expire;
    /** Start one Eval of the Triggers queued on a Thread, judged by the gate, and ask the assessor for it. */
    start(threadKeyValue: string, policy: Policy): void;
    /** The candidate of the Eval that holds `triggerId`, or undefined while no Eval holds it. */
    candidate(triggerId: string): Candidate | undefined;
    /**
     * Decide a Trigger: the Eval that holds it, or a direct Eval of it alone when none does.
     * @throws UserError when the Trigger is unknown or not admissible, `outcome.evalId` names an Eval that has finished, a
     * ticket's worker still decides the Trigger and the outcome is not a stop, or an inferred candidate is accepted outside `auto`
     * mode or without enabled matching rules.
     */
    decide(triggerId: string, outcome: Outcome): Decision;
    /**
     * Queue a stored Trigger for a fresh Eval on its primary Thread and emit `trigger.requeued`; returns false while an Eval holds it.
     * @throws UserError when the Trigger is unknown.
     */
    reevaluate(triggerId: string): boolean;
    /** Queue a Trigger for a fresh Eval on its primary Thread; false while an Eval holds it. */
    private requeue;
    /**
     * Record that a ticket's Executor hands back a Trigger that reached it as beyond the ticket, and queue it for a fresh Eval
     * when the ticket decided it and no other ticket still does (see `handBack`): the gate judges it as any message on its
     * Thread, and its candidate carries the reasons, so no requeue notice comes before it. The ticket keeps its Subscription,
     * and hands a Trigger back once.
     * @returns whether it was queued: false while another ticket decides it, and for one the ticket did not decide.
     */
    handback(ticketId: string, triggerId: string, reason: string): boolean;
    /**
     * Marks an `unavailable` Decision dismissed so the overview lists it no more.
     * @throws UserError when the Decision is unknown or not `unavailable`.
     */
    dismiss(decisionId: string): Decision;
    /** Take a Trigger out of its Thread's queue because it was routed by hand. */
    withdraw(trigger: Trigger): void;
    /**
     * End the Eval that holds a Trigger routed to a ticket, since the ticket has it now: one that holds other Triggers too
     * queues them again for a fresh Eval without it.
     */
    routed(triggerId: string, ticketId: string): void;
    /** Start the Evals in progress again under the new Policy version, and say that it changed. */
    policyChanged(from: string, to: string): void;
    /** End a Thread's Eval as unavailable for `reason` and queue its Triggers, except `without`, for a new Eval ahead of the others. */
    private reassess;
    /** The Thread whose Eval holds a Trigger: an Eval runs on the primary Thread of each Trigger it holds. */
    private holding;
    private candidateOf;
    /**
     * Record that the queued Triggers `ids` of a Thread start no Eval, for `reason`, and take them out of its queue. Its id
     * differs from an Eval's, so it never replaces the Decision of an earlier Eval of the same Triggers.
     */
    private ignore;
    /**
     * The accept Decisions of the Triggers whose primary Thread is `threadKey`, by Trigger: what each one started. An Eval and
     * its Decision run on its Triggers' primary Thread, so the Thread's Decisions, read by their index, hold them all.
     */
    private accepted;
    /**
     * A gate-only Eval of one Trigger, for an outcome decided without a queued Eval, such as on a follow-up that reached a
     * ticket. It is decided at once, beside an Eval its Thread may have in progress, and takes the Trigger out of the queue.
     * Its id names the outcome's kind, so a stop and an accept of one message at the same moment are two Decisions.
     */
    private directEval;
    /** Apply an outcome to an Eval of a Thread: the one in progress, or a gate-only one. */
    private decideEval;
    /** Record an accept with the Mandate the Eval gives, and have Tickets create its ticket. */
    private accept;
    /** Record an Eval's Decision; the Thread's own Eval ends with it, while a gate-only one leaves the Thread's Eval going. */
    private finish;
    private record;
}
