import type { Trigger } from './model.ts';
import type { ReplyStatus } from './ports.ts';
import { EnginePart } from './part.ts';
/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest = {
    purpose: 'acknowledgement';
    ticketId: string;
    triggerId: string;
    text: string;
} | {
    purpose: 'answer' | 'result' | 'attention';
    ticketId?: string;
    triggerId?: string;
    question?: string;
    text: string;
};
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply {
    id: string;
    status: ReplyStatus;
    reused: boolean;
}
/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it, under a deterministic id
 * that keeps it from going out twice (idempotent). The Engine routes `reply` here; Tickets asks it for the acknowledgement
 * an accept carries, and Assignments asks it to withdraw a question a report replaced.
 */
export declare class Replies extends EnginePart {
    /**
     * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
     * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
     * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
     * `merged`, or `dropped`). Each message is queued at most once (idempotent). An acknowledgement, even one already queued,
     * records that the ticket's worker took the message up.
     * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
     * that is not ready, completed, merged, or dropped.
     */
    reply(request: ReplyRequest): Reply;
    /**
     * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
     * and a person wrote it.
     */
    acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void;
    /** Withdraw a ticket's question for a person from the outbox, unless it went out already. */
    withdrawAttention(attentionId: string): void;
    private acknowledge;
    private answer;
    /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
    private sourceChannel;
}
