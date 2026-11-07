import { z } from 'zod';
import { type AdmissionRow } from './admission.ts';
import { type AssessmentOutcome, type Policy, type PolicyEffect, type SourceScope, type Strength, type Ticket, type ActorRef } from './index.ts';
export declare const RuleIdSchema: z.ZodString;
export declare const RuleMatchSchema: z.ZodObject<{
    rule_id: z.ZodString;
    reason: z.ZodString;
}, z.core.$strict>;
export type RuleMatch = z.infer<typeof RuleMatchSchema>;
export declare const RuleAssessmentSchema: z.ZodObject<{
    rule_id: z.ZodString;
    reason: z.ZodString;
    matched: z.ZodBoolean;
}, z.core.$strict>;
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>;
export declare const AdmissionDirectionSchema: z.ZodObject<{
    implementation_requested: z.ZodBoolean;
    target_basis: z.ZodEnum<{
        specified: "specified";
        "existing-standard": "existing-standard";
        undetermined: "undetermined";
    }>;
    requires_design_decision: z.ZodBoolean;
    evidence: z.ZodString;
}, z.core.$strict>;
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>;
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
export declare function directionAllowed(value: unknown): value is AdmissionDirection;
export interface Assessment {
    decision: 'accept' | 'ignore' | 'unavailable';
    rule_assessments: RuleAssessment[];
    direction: unknown;
    title: string;
    scope: string;
    reason: string;
    intent_evidence?: string | null;
    acknowledgement?: string | null;
    worktree_name?: string;
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
 */
export declare function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome;
/** An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. */
export declare const RuleSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    enabled: z.ZodBoolean;
    instruction: z.ZodString;
}, z.core.$strict>;
export type Rule = z.infer<typeof RuleSchema>;
export declare const RoleModelSchema: z.ZodObject<{
    provider: z.ZodString;
    model: z.ZodString;
    reasoningEffort: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type RoleModel = z.infer<typeof RoleModelSchema>;
export declare const AllowedSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const AdmissionRowSchema: z.ZodType<AdmissionRow>;
export declare const AdmissionTableSchema: z.ZodRecord<z.ZodString, z.ZodType<AdmissionRow, unknown, z.core.$ZodTypeInternals<AdmissionRow, unknown>>>;
export declare const SourcePolicySchema: z.ZodObject<{
    allowed: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    admission: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodType<AdmissionRow, unknown, z.core.$ZodTypeInternals<AdmissionRow, unknown>>>>;
}, z.core.$catchall<z.ZodUnknown>>;
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;
export declare const PolicyConfigSchema: z.ZodObject<{
    rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        enabled: z.ZodBoolean;
        instruction: z.ZodString;
    }, z.core.$strict>>>;
    sources: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        allowed: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        admission: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodType<AdmissionRow, unknown, z.core.$ZodTypeInternals<AdmissionRow, unknown>>>>;
    }, z.core.$catchall<z.ZodUnknown>>>>;
}, z.core.$strict>;
export declare const EvalConfigSchema: z.ZodObject<{
    mode: z.ZodDefault<z.ZodEnum<{
        off: "off";
        observe: "observe";
        auto: "auto";
    }>>;
    timeoutSeconds: z.ZodDefault<z.ZodNumber>;
    model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        reasoningEffort: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
/** Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/work`), `prepare` command, and blocked commands. */
export declare const ExecutorConfigSchema: z.ZodObject<{
    model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        reasoningEffort: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>>;
    maxWorkers: z.ZodDefault<z.ZodNumber>;
    directory: z.ZodDefault<z.ZodString>;
    prepare: z.ZodDefault<z.ZodString>;
    worktree: z.ZodDefault<z.ZodBoolean>;
    prepareTimeoutSeconds: z.ZodDefault<z.ZodNumber>;
    blockedCommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const SourceInstanceSchema: z.ZodObject<{
    enabled: z.ZodDefault<z.ZodBoolean>;
    config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strict>;
export declare const SettingsSchema: z.ZodObject<{
    paused: z.ZodDefault<z.ZodBoolean>;
    sources: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        config: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strict>>>;
    policy: z.ZodDefault<z.ZodObject<{
        rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            name: z.ZodString;
            enabled: z.ZodBoolean;
            instruction: z.ZodString;
        }, z.core.$strict>>>;
        sources: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodObject<{
            allowed: z.ZodDefault<z.ZodArray<z.ZodObject<{
                id: z.ZodString;
                name: z.ZodOptional<z.ZodString>;
            }, z.core.$strict>>>;
            admission: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodType<AdmissionRow, unknown, z.core.$ZodTypeInternals<AdmissionRow, unknown>>>>;
        }, z.core.$catchall<z.ZodUnknown>>>>;
    }, z.core.$strict>>;
    eval: z.ZodDefault<z.ZodObject<{
        mode: z.ZodDefault<z.ZodEnum<{
            off: "off";
            observe: "observe";
            auto: "auto";
        }>>;
        timeoutSeconds: z.ZodDefault<z.ZodNumber>;
        model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
            reasoningEffort: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
    executor: z.ZodDefault<z.ZodObject<{
        model: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            provider: z.ZodString;
            model: z.ZodString;
            reasoningEffort: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>>;
        maxWorkers: z.ZodDefault<z.ZodNumber>;
        directory: z.ZodDefault<z.ZodString>;
        prepare: z.ZodDefault<z.ZodString>;
        worktree: z.ZodDefault<z.ZodBoolean>;
        prepareTimeoutSeconds: z.ZodDefault<z.ZodNumber>;
        blockedCommands: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Settings = z.infer<typeof SettingsSchema>;
export type SettingsBlock = 'policy' | 'eval' | 'executor' | `source:${string}`;
export type SettingsSave = SettingsBlock | 'pause';
export type SettingsOrigin = 'panel' | 'tool' | 'sync';
export declare const POLICY_REVISION = "mandate-v3";
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
export declare function policyVersion(settings: Settings): string;
export declare function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined;
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
export declare function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined;
export declare const anyoneAllowed: (settings: Settings) => boolean;
/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export declare function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope): Map<string, PolicyEffect>;
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export declare function settingsPolicy(settings: Settings, sources: SourceScope): Policy;
