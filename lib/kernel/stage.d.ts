/** Ticket stage classification and retry eligibility (docs/003). */
import { type Ticket } from './model.ts';
/** High-level execution stage of a ticket: waiting on a person, actively working or queued, idle between turns, or ended. */
export type TicketStage = {
    stage: 'person';
    action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed';
} | {
    stage: 'working';
    action?: 'queued';
} | {
    stage: 'idle';
} | {
    stage: 'ended';
};
/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
export declare function ticketStage(ticket: Ticket): TicketStage;
/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
export declare function canRetry(ticket: Ticket): boolean;
