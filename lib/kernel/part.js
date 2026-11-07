/** Shared base class and configuration for Engine domain parts. */
import { UserError } from "./errors.js";
import { followupOwners, reached, threadKey } from "./model.js";
/**
 * Base class for Intake, Evals, Tickets, Assignments, and Replies providing shared access to repositories, policy, clock, and event emission.
 * Each subclass mutates its own domain aggregates and delegates cross-aggregate changes to sibling parts within the transaction opened by Engine.
 */
export class EnginePart {
    options;
    repo;
    constructor(options) {
        this.options = options;
        this.repo = options.repo;
    }
    now() { return this.options.now?.() ?? new Date().toISOString(); }
    policy() { return this.options.policy(); }
    /** The tickets whose worker decides a person's follow-up: see `followupOwners`. */
    owners(trigger) { return followupOwners(trigger, this.repo); }
    /** Refuse a main-Session routing of a follow-up a ticket's worker still decides. */
    leftToWorkers(trigger) {
        const owners = this.owners(trigger);
        if (owners.length)
            throw new UserError('workerDecides', { tickets: owners.join(', ') });
    }
    /**
     * Record that a ticket's worker hands back a Trigger that reached the ticket, with why, and queue it for Eval when the
     * ticket decided it and no other ticket still does. One the ticket did not decide, such as a bot's, one a person sent to
     * Eval or one on a Thread it follows for context, went to Eval without it.
     * @returns whether it was queued.
     */
    handBack(ticketId, trigger, reason) {
        const decided = this.owners(trigger).includes(ticketId);
        const disposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() };
        const handbacks = [...disposition.handbacks ?? [], { ticketId, reason, at: this.now() }];
        this.repo.triggers.saveDisposition(trigger.id, { ...disposition, handbacks });
        return decided && !this.owners(trigger).length && this.queueForEval(trigger);
    }
    /** Record that a ticket's worker took a person's message up as within the ticket, by acknowledging or answering it. */
    takeUp(ticketId, triggerId) {
        const disposition = this.repo.triggers.disposition(triggerId);
        if (disposition && !disposition.acked?.includes(ticketId)) {
            this.repo.triggers.saveDisposition(triggerId, { ...disposition, acked: [...disposition.acked ?? [], ticketId] });
        }
    }
    /** Queue a Trigger on its primary Thread for the next Eval, unless it waits there already or an Eval holds it. */
    queueForEval(trigger) {
        const primary = this.thread(trigger.threads[0]);
        if (primary.pending.includes(trigger.id) || primary.evaluating?.triggerIds.includes(trigger.id))
            return false;
        primary.pending.push(trigger.id);
        this.repo.threads.save(primary);
        return true;
    }
    emit(type, data) {
        this.options.emit?.({ type, at: this.now(), data });
    }
    require(ticketId) { const ticket = this.repo.tickets.get(ticketId); if (!ticket)
        throw new UserError('unknownTicket'); return ticket; }
    /** Returns the stored Thread or an unsaved empty Thread aggregate. */
    thread(ref) {
        const k = threadKey(ref);
        return this.repo.threads.get(k) ?? { key: k, ref: { source: ref.source, id: ref.id }, createdAt: this.now(), subscriptions: [], correlated: [], pending: [], meta: {} };
    }
    ticketsOnThread(thread) {
        return thread.subscriptions.flatMap(id => { const ticket = this.repo.tickets.get(id); return ticket ? [ticket] : []; });
    }
    source(ticket) { return this.repo.triggers.get(ticket.origin.triggerId); }
    reaches(ticket, trigger, context = true) {
        return reached(ticket, trigger, k => this.repo.threads.get(k), context);
    }
}
