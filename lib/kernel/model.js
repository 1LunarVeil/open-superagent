/** Stable key of a thread across the whole domain. */
export const threadKey = (ref) => `${ref.source}:${ref.id}`;
/**
 * Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
 * values that do not parse as a timestamp are returned unchanged.
 */
export function isoTime(value) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : value;
}
/**
 * The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
 * and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
 * while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
 * an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
 * main Session may only stop the work on it.
 */
export function followupOwners(trigger, records) {
    if (!trigger.human)
        return [];
    const disposition = records.triggers.disposition(trigger.id);
    if (!disposition || disposition.requeued)
        return [];
    // The disposition alone rules most messages out, so a Thread or a ticket is read only for one that may have an owner.
    const returned = new Set(disposition.handbacks?.map(item => item.ticketId));
    const reached = disposition.fanout.filter(id => !returned.has(id) && !disposition.context?.includes(id));
    if (!reached.length || records.threads.get(threadKey(trigger.threads[0]))?.evaluating?.triggerIds.includes(trigger.id))
        return [];
    return reached.filter(id => {
        const ticket = records.tickets.get(id);
        return !!ticket && (liveTicket(ticket) || (ticket.ended?.by !== 'human'
            && ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id && ticket.undelivered.includes(input.id))));
    });
}
/**
 * Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
 * work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
 */
export const settled = (decision) => !['stop', 'unavailable'].includes(decision.kind)
    && !decision.reason.some(reason => ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code));
/** Whether a ticket is open: it has not ended. */
export const liveTicket = (ticket) => !ticket.ended;
/** How a ticket ended. */
export const ticketOutcome = (ticket) => ticket.ended?.outcome;
export const runningAssignment = (ticket) => ticket.assignments.find(assignment => assignment.state === 'running');
/**
 * Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
 * to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
 */
export function reached(ticket, trigger, thread, context = true) {
    if (ticket.origin.triggerId === trigger.id)
        return true;
    const input = ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === trigger.id);
    return trigger.threads.some(ref => {
        const current = thread(threadKey(ref));
        return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id));
    }) || (input && (context || !trigger.threads.every(ref => thread(threadKey(ref))?.context?.includes(ticket.id))));
}
export const latestAssignment = (ticket) => ticket.assignments.at(-1);
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
export const latestReport = (ticket) => ticket.assignments.findLast(assignment => assignment.report)?.report;
/**
 * Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
 * is false, or the end of its latest turn, whichever is later.
 */
export function readUntil(ticket, progress = true) {
    const report = ticket.assignments.findLast(assignment => assignment.report && (progress || assignment.report.state !== 'progress'))?.report;
    return [report?.at ?? '', ...ticket.assignments.map(assignment => assignment.idleAt ?? '')].reduce((a, b) => a > b ? a : b);
}
/**
 * Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
 * since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
 */
export function waitsForPerson(ticket) {
    const report = latestAssignment(ticket)?.report;
    if (report?.state !== 'blocked' && report?.state !== 'failed')
        return false;
    return !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > report.at);
}
