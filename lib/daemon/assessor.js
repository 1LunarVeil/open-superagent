/**
 * Implements the Engine's `Assessor` port for the ZCode main session (the Orchestrator).
 * Port note: upstream's `MasterAssessor` steered its in-process main Session directly, so "delivered" meant the Session
 * received a message. A ZCode host cannot steer its session, so delivery here means the candidate card entered the durable
 * pending-action queue, where `superagent_tick` hands it to the orchestrator — and the Eval's assessment deadline counts
 * from that enqueue (`Engine.candidateDelivered`), so a busy or away orchestrator still gets a fair clock.
 */
import { candidateCard } from "./actions.js";
/**
 * Queues each Eval's candidate card for the orchestrator and marks the Eval delivered once the card is queued.
 * The deps arrive through `install` rather than the constructor because the Engine is built with the assessor in hand
 * (two-phase wiring breaks the Engine-assessor cycle), so the `assessment` effect handler can only register afterwards.
 */
export class MasterAssessor {
    /** Candidates this assessor requested, keyed by Eval ID; `release` drops them as the Evals end. */
    candidates = new Map();
    deps;
    install(deps) {
        if (this.deps)
            throw new Error('The assessor is already installed');
        this.deps = deps;
        deps.effects.handle('assessment', async (payload, evalId) => { this.deliver(payload.triggerId, evalId); }, { limit: () => deps.paused() ? 0 : 4, retry: [5000, 60_000] });
    }
    /** Enqueues an `assessment` effect for the Eval's candidate, caching the candidate for the handler to render. */
    request(candidate) {
        // Wiring invariant: install() runs before any Engine command can start an Eval, so deps are always set here.
        if (!this.deps)
            throw new Error('The assessor is not installed; the runtime wires it before any trigger arrives');
        this.candidates.set(candidate.evalId, candidate);
        this.deps.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]?.id ?? '' });
    }
    /** Called whenever an Eval ends, decided or not, so the assessor drops what it kept for it. */
    release(evalId) { this.candidates.delete(evalId); }
    /**
     * Renders the Eval's candidate card into the action queue and starts the assessment deadline.
     * The card is built from the cached candidate (or, if that is gone, the Eval that still holds the trigger) and bounded
     * thread context: the newest triggers on the thread outside the batch. A candidate that no longer matches the Eval is
     * dropped — the Eval was decided, expired, or replaced while the effect waited.
     */
    deliver(triggerId, evalId) {
        const deps = this.deps;
        if (!deps)
            throw new Error('The assessor is not installed');
        const candidate = this.candidates.get(evalId) ?? deps.engine.candidate(triggerId);
        if (!candidate || candidate.evalId !== evalId)
            return;
        const batch = new Set(candidate.triggers.map(item => item.id));
        const context = deps.store.read.threadTriggers(candidate.thread.key, 20).filter(item => !batch.has(item.id)).slice(-10);
        // One transaction: the card enters the queue exactly when the Eval's deadline starts counting from it.
        deps.store.atomic(() => {
            deps.actions.add({ kind: 'assess_candidate', evalId: candidate.evalId, card: candidateCard(candidate, context) }, new Date().toISOString());
            deps.engine.candidateDelivered(evalId);
        });
    }
}
