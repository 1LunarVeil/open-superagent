/**
 * Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
 * Policy gates and source scopes may also emit their own literal reason codes.
 */
export declare const REASONS: {
    readonly said: "{text}";
    readonly timeout: "Assessment timed out";
    readonly policyChanged: "Policy changed during assessment";
    readonly noAdmissible: "No admissible trigger";
    readonly startedTicket: "Already started ticket {ticket}";
    readonly acceptedBefore: "Trigger {trigger} was accepted before";
    readonly routed: "Routed to ticket {ticket}";
    readonly explicitRouted: "Explicit request from an allowed sender routed by the orchestrator";
    readonly humanStop: "Human asked to stop";
    readonly legacyImport: "Imported from the pre-domain-model task record";
    readonly forwarded: "Forwarded to the worker of the Ticket already on this Thread";
    readonly senderNotMember: "The sender is not on the Source's list";
    readonly retried: "Retried by a person";
    readonly hostRestarted: "dsh-superagent restarted";
    readonly stopUnknown: "Stop target is unknown or already ended";
    readonly stopNotExplicit: "A stop needs an explicit request from a sender on the list";
    readonly directionUnsettled: "Implementation intent or target direction is not established, or a product/design decision is still required";
    readonly noRuleMatched: "No enabled admission rule matched";
    readonly ignoredFromCard: "Ignored from its card, without a rule assessment";
    readonly observed: "Observe mode: would accept ({text})";
};
export type ReasonCode = keyof typeof REASONS;
/** Reason code and template values; `triggerId` identifies the trigger in a batch that the reason applies to. */
export interface Reason {
    code: ReasonCode | (string & {});
    values?: Record<string, string>;
    triggerId?: string;
}
export declare const said: (text: string) => Reason;
/** Formats reasons in English (prefixed by `triggerId` when present) for agent consumption. */
export declare function reasonText(reasons: readonly Reason[] | Reason | undefined): string;
