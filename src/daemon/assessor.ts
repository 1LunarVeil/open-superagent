/**
 * Implements the Engine's `Assessor` port for the ZCode main session (the Orchestrator).
 * Port note: upstream's `MasterAssessor` steered its in-process main Session directly, so "delivered" meant the Session
 * received a message. A ZCode host cannot steer its session, so delivery here means the candidate card entered the durable
 * pending-action queue, where `superagent_tick` hands it to the orchestrator — and the Eval's assessment deadline counts
 * from that enqueue (`Engine.candidateDelivered`), so a busy or away orchestrator still gets a fair clock.
 */
import { candidateCard } from './actions.ts'
import type { Actions } from './actions.ts'
import type { Assessor, Candidate, EngineForMainSession } from '../kernel/index.ts'
import type { Effects } from '../persist/effects.ts'
import type { Store } from '../persist/store.ts'

/** Host dependencies the assessor needs, narrowed to what it uses. */
export interface AssessorDeps {
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly actions: Actions
  /** Only the candidate reads: the assessor never decides; the orchestrator does, through `Engine.decide`. */
  readonly engine: Pick<EngineForMainSession, 'candidate' | 'candidateDelivered'>
  readonly store: Pick<Store, 'read' | 'atomic'>
  /** Whether processing is paused, which holds candidate card deliveries. */
  paused(): boolean
}

/**
 * Queues each Eval's candidate card for the orchestrator and marks the Eval delivered once the card is queued.
 * The deps arrive through `install` rather than the constructor because the Engine is built with the assessor in hand
 * (two-phase wiring breaks the Engine-assessor cycle), so the `assessment` effect handler can only register afterwards.
 */
export class MasterAssessor implements Assessor {
  /** Candidates this assessor requested, keyed by Eval ID; `release` drops them as the Evals end. */
  private readonly candidates = new Map<string, Candidate>()
  private deps?: AssessorDeps

  install(deps: AssessorDeps): void {
    if (this.deps) throw new Error('The assessor is already installed')
    this.deps = deps
    deps.effects.handle('assessment', async (payload, evalId) => { this.deliver(payload.triggerId, evalId) },
      { limit: () => deps.paused() ? 0 : 4, retry: [5000, 60_000] })
  }

  /** Enqueues an `assessment` effect for the Eval's candidate, caching the candidate for the handler to render. */
  request(candidate: Candidate): void {
    // Wiring invariant: install() runs before any Engine command can start an Eval, so deps are always set here.
    if (!this.deps) throw new Error('The assessor is not installed; the runtime wires it before any trigger arrives')
    this.candidates.set(candidate.evalId, candidate)
    this.deps.effects.enqueue('assessment', candidate.evalId, { triggerId: candidate.triggers[0]?.id ?? '' })
  }

  /** Called whenever an Eval ends, decided or not, so the assessor drops what it kept for it. */
  release(evalId: string): void { this.candidates.delete(evalId) }

  /**
   * Renders the Eval's candidate card into the action queue and starts the assessment deadline.
   * The card is built from the cached candidate (or, if that is gone, the Eval that still holds the trigger) and bounded
   * thread context: the newest triggers on the thread outside the batch. A candidate that no longer matches the Eval is
   * dropped — the Eval was decided, expired, or replaced while the effect waited.
   */
  private deliver(triggerId: string, evalId: string): void {
    const deps = this.deps
    if (!deps) throw new Error('The assessor is not installed')
    const candidate = this.candidates.get(evalId) ?? deps.engine.candidate(triggerId)
    if (!candidate || candidate.evalId !== evalId) return
    const batch = new Set(candidate.triggers.map(item => item.id))
    const context = deps.store.read.threadTriggers(candidate.thread.key, 20).filter(item => !batch.has(item.id)).slice(-10)
    // One transaction: the card enters the queue exactly when the Eval's deadline starts counting from it.
    deps.store.atomic(() => {
      deps.actions.add({ kind: 'assess_candidate', evalId: candidate.evalId, card: candidateCard(candidate, context) }, new Date().toISOString())
      deps.engine.candidateDelivered(evalId)
    })
  }
}
