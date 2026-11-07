import type { Actions } from './actions.ts';
import type { Assessor, Candidate, EngineForMainSession } from '../kernel/index.ts';
import type { Effects } from '../persist/effects.ts';
import type { Store } from '../persist/store.ts';
/** Host dependencies the assessor needs, narrowed to what it uses. */
export interface AssessorDeps {
    readonly effects: Pick<Effects, 'enqueue' | 'handle'>;
    readonly actions: Actions;
    /** Only the candidate reads: the assessor never decides; the orchestrator does, through `Engine.decide`. */
    readonly engine: Pick<EngineForMainSession, 'candidate' | 'candidateDelivered'>;
    readonly store: Pick<Store, 'read' | 'atomic'>;
    /** Whether processing is paused, which holds candidate card deliveries. */
    paused(): boolean;
}
/**
 * Queues each Eval's candidate card for the orchestrator and marks the Eval delivered once the card is queued.
 * The deps arrive through `install` rather than the constructor because the Engine is built with the assessor in hand
 * (two-phase wiring breaks the Engine-assessor cycle), so the `assessment` effect handler can only register afterwards.
 */
export declare class MasterAssessor implements Assessor {
    /** Candidates this assessor requested, keyed by Eval ID; `release` drops them as the Evals end. */
    private readonly candidates;
    private deps?;
    install(deps: AssessorDeps): void;
    /** Enqueues an `assessment` effect for the Eval's candidate, caching the candidate for the handler to render. */
    request(candidate: Candidate): void;
    /** Called whenever an Eval ends, decided or not, so the assessor drops what it kept for it. */
    release(evalId: string): void;
    /**
     * Renders the Eval's candidate card into the action queue and starts the assessment deadline.
     * The card is built from the cached candidate (or, if that is gone, the Eval that still holds the trigger) and bounded
     * thread context: the newest triggers on the thread outside the batch. A candidate that no longer matches the Eval is
     * dropped — the Eval was decided, expired, or replaced while the effect waited.
     */
    private deliver;
}
