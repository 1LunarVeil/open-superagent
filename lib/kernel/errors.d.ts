/** User-facing error codes mapped to their category ('missing' or 'refused') and English message template. */
export declare const USER_ERRORS: {
    readonly unknownTicket: readonly ["missing", "Unknown ticket"];
    readonly unknownThread: readonly ["missing", "Unknown thread {thread}"];
    readonly unknownProblem: readonly ["missing", "Unavailable Eval not found"];
    readonly unknownTrigger: readonly ["missing", "Unknown trigger"];
    readonly unknownAssignment: readonly ["missing", "Unknown assignment"];
    readonly revisionConflict: readonly ["refused", "Settings block {block} changed since revision {revision} was read; read it again before saving"];
    readonly noCandidate: readonly ["missing", "No in-flight evaluation holds trigger {trigger}; it was decided already or its thread is between evaluations"];
    readonly unknownResource: readonly ["missing", "Unknown resource {resource}; expected trigger/<id>, thread/<source>:<id>, ticket/<id>, tickets, threads, or decisions"];
    readonly assessmentInvalid: readonly ["refused", "{reason}"];
    readonly unknownBlock: readonly ["missing", "Unknown settings block: {block}"];
    readonly unknownPromptRevision: readonly ["missing", "Unknown prompt revision {revision}"];
    readonly unknownPromptPart: readonly ["refused", "Unknown built-in prompt part {part}"];
    readonly ticketEnded: readonly ["refused", "Ticket has ended"];
    readonly assignmentEnded: readonly ["refused", "Assignment has ended; a newer assignment owns this ticket"];
    readonly evalFinished: readonly ["refused", "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval"];
    readonly notAdmissible: readonly ["refused", "Trigger is not admissible: {reason}"];
    readonly notExplicit: readonly ["refused", "An accept through superagent_route is for explicit requests from allowed senders; assess proactive candidates with superagent_eval_read and superagent_eval_decide"];
    readonly ticketStopped: readonly ["refused", "A person stopped this ticket; new work needs an accept through superagent_route"];
    readonly mandateRevoked: readonly ["refused", "The current policy no longer holds this ticket's mandate; new work needs an accept through superagent_route"];
    readonly notRetryable: readonly ["refused", "Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed"];
    readonly sourceThread: readonly ["refused", "This is the thread the ticket started on; it stays subscribed"];
    readonly followedThread: readonly ["refused", "This thread is the ticket's own, such as its pull request's; it stays subscribed"];
    readonly notFollowing: readonly ["refused", "This ticket does not follow that thread"];
    readonly questionWithResult: readonly ["refused", "A question for a person cannot also be a ready result or an answer; report it separately"];
    readonly askerWithoutQuestion: readonly ["refused", "The message that raised a question needs the question it raised"];
    readonly notAsker: readonly ["refused", "A question must name the person's message that raised it, which reached this ticket"];
    readonly notAnswerable: readonly ["refused", "An answer must name the person's question it answers, which reached this ticket"];
    readonly ackEnded: readonly ["refused", "Ticket ended; do not acknowledge historical requests"];
    readonly notReached: readonly ["refused", "Trigger does not belong to this worker"];
    readonly handedBack: readonly ["refused", "This ticket handed that trigger back already"];
    readonly handedBackHere: readonly ["refused", "The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it"];
    readonly workerDecides: readonly ["refused", "This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through superagent_route, with kind stop"];
    readonly ackNoChannel: readonly ["refused", "Acknowledgement requires an assigned human source message"];
    readonly ackNotPerson: readonly ["refused", "Use the original human trigger, not a bot, CI or worker report"];
    readonly notReady: readonly ["refused", "Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel."];
    readonly notAttention: readonly ["refused", "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal."];
    readonly notQuestion: readonly ["refused", "An answer must target the original human question, not a worker report or automated trigger"];
    readonly noAnswer: readonly ["refused", "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with superagent_ticket_status (requestStatus: true), which asks only a worker that reported waiting; ordinary progress cannot be relabelled as an answer."];
    readonly noChannel: readonly ["refused", "No reply channel for this ticket or trigger"];
    readonly panelOnlyEnvironment: readonly ["refused", "The execution environment (ticket directory, worktree mode, timeout) is set through superagent_settings_save on the executor block"];
    readonly panelOnlyAccounts: readonly ["refused", "Source fields that setup reads, such as account CLIs, can only be changed in the management panel"];
    readonly setupComplete: readonly ["refused", "Setup is complete"];
    readonly modelUnavailable: readonly ["refused", "The {block} model is not available: {error}"];
    readonly promptTooLong: readonly ["refused", "Prompt configuration exceeds {limit} characters"];
    readonly promptPlaceholders: readonly ["refused", "The “{part}” template must keep {placeholders}, which the system fills in"];
    readonly promptPartEmpty: readonly ["refused", "The “{part}” part cannot be empty; reset it to follow its built-in text"];
    readonly sourceNotInstalled: readonly ["refused", "The {source} Source kind is not installed"];
    readonly noLabels: readonly ["refused", "This Source has no names to refresh"];
    readonly nothingToSync: readonly ["refused", "The {source} Source's part of the Policy has nothing to sync from, or the Source is off or waiting for setup"];
};
export type UserErrorCode = keyof typeof USER_ERRORS;
/**
 * Structured error thrown by Engine parts and application services when a caller request is invalid or references missing state.
 * Tool handlers and MCP tool results inspect its code and missing flag to return appropriate error responses.
 */
export declare class UserError extends Error {
    readonly code: UserErrorCode;
    readonly values: Record<string, string>;
    readonly missing: boolean;
    constructor(code: UserErrorCode, values?: Record<string, string>);
}
