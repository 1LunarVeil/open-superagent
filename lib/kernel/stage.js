/** Ticket stage classification and retry eligibility (docs/003). */
import { latestAssignment, waitsForPerson } from "./model.js";
/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
export function ticketStage(ticket) {
    if (ticket.ended)
        return { stage: 'ended' };
    if (ticket.delivery)
        return { stage: 'person', action: 'delivery' };
    if (ticket.attention)
        return { stage: 'person', action: 'answer' };
    const assignment = latestAssignment(ticket);
    const report = assignment?.report?.state;
    if (report === 'ready')
        return { stage: 'person', action: 'review' };
    // A human follow-up after a blocked or failed report returns the ticket to the executor.
    if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket))
        return { stage: 'person', action: report };
    if (!assignment || assignment.state === 'pending')
        return { stage: 'working', action: 'queued' };
    if (report === 'waiting' || assignment.state === 'ended')
        return { stage: 'idle' };
    return { stage: 'working' };
}
/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
export function canRetry(ticket) {
    return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery);
}
