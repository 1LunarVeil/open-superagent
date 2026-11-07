/**
 * Implements the Engine's `Executor` port for the ZCode host: workers are subagent runs the orchestrator spawns, so the
 * Executor's job is to queue the orchestrator's work (spawn a worker, hand it waiting inputs) and retract it when the
 * domain ends it. Port discipline: `start`, `deliver`, and `stop` are called inside Engine command transactions, so they
 * only enqueue durable effects or cancel pending actions — never an Engine call, never IO. The launch and delivery
 * handlers registered by `install` run after commit, where reading the Store, creating directories, and calling the
 * Engine back are allowed.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Later } from '../persist/effects.ts'
import type { Effects } from '../persist/effects.ts'
import type { Assignment, EngineForExecutor, Executor, Ticket, Trigger } from '../kernel/index.ts'
import type { Store } from '../persist/store.ts'
import type { Actions } from './actions.ts'

/** Host dependencies the executor needs, narrowed to what it uses. */
export interface ExecutorDeps {
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly actions: Actions
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead'>
  readonly store: Store
  /** How many tickets may have a running worker at once; a launch beyond it waits (`Later`). */
  slots(): number
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  /** Root of the per-ticket working directories, such as `<stateDir>/work`. */
  workRoot(): string
}

/**
 * The bounded limits of a proactively accepted ticket, with upstream's `mandateInstructions` semantics: work stays a
 * small, cohesive change inside one module within the accepted rule scope; anything beyond it is reported dropped rather
 * than expanded, and a message beyond the ticket is handed back instead of acted on.
 */
const INFERRED_LIMIT = 'Proactive tickets carry limited authorization: the work must stay a small, cohesive change inside'
  + ' one module within the accepted rule scope. If it would need public-interface or behavior changes, new interaction,'
  + ' or product decisions, report dropped rather than expanding scope; if a message that reaches the ticket asks for work'
  + ' beyond it, hand it back instead of acting on it.'

/** Renders one ticket Input for the worker: triggers with author and bounded text, text and notes verbatim. */
function renderInput(ticket: Ticket, inputId: string, trigger: (triggerId: string) => Trigger | undefined): Record<string, unknown> {
  const input = ticket.inputs.find(item => item.id === inputId)
  if (!input) return { inputId }
  if (input.kind === 'trigger') {
    const source = trigger(input.triggerId)
    return { kind: 'trigger', inputId, triggerId: input.triggerId, at: input.at,
      ...(source ? { actor: source.actor, human: source.human, text: source.text.slice(0, 2000) } : {}) }
  }
  if (input.kind === 'text' || input.kind === 'note') return { kind: input.kind, inputId, at: input.at, text: input.text }
  // policy-changed, reopen, and resumed inputs are rare; their details live on the ticket record the worker reads.
  return { kind: input.kind, inputId, at: input.at }
}

/**
 * Builds the prompt the orchestrator gives the worker subagent it spawns for a ticket: a JSON card of the bounded facts
 * (identity, mandate, origin trigger text, waiting inputs) followed by the reporting protocol. Previews are truncated on
 * purpose; the protocol points the worker at the full record reads. The trigger resolver is optional so a caller holding
 * only the ticket can still build a card; the launch handler always passes the Store lookup.
 */
export function buildAssignmentPrompt(ticket: Ticket, trigger: (triggerId: string) => Trigger | undefined = () => undefined): string {
  const mandate = ticket.mandate
  const origin = trigger(ticket.origin.triggerId)
  const card = {
    ticketId: ticket.id,
    title: ticket.title,
    mandate: { strength: mandate.strength, scope: mandate.scope, basis: mandate.basis, policyVersion: mandate.policyVersion },
    originTriggerId: ticket.origin.triggerId,
    ...(origin ? { originText: origin.text.slice(0, 2000) } : {}),
    undelivered: ticket.undelivered.map(id => renderInput(ticket, id, trigger)),
  }
  const lines = [
    'You are the worker subagent for one open-superagent ticket. Work only inside the working directory given with your'
      + ' task, and only within the mandate below. The ticket card is your assignment:',
    '',
    JSON.stringify(card, null, 2),
  ]
  if (mandate.strength === 'inferred') lines.push('', INFERRED_LIMIT)
  lines.push('',
    'PROTOCOL',
    '- The card truncates texts. Before acting on a preview, read the full ticket record and its thread with'
      + ' superagent_worker_read; it also serves the origin trigger and every input in full.',
    '- Report with superagent_worker_report. The states: progress - work continues (internal, wakes nobody); waiting - you wait'
      + ' for input or a person with nothing left to run; ready - a verified result exists; blocked - a person must act to'
      + ' unblock the work; failed - a person must act to recover it; dropped - nothing is left to do, which closes the'
      + ' ticket without a message.',
    '- A report with question asks a person one concrete question, and askedBy names the person\'s message that raised it,'
      + ' so the question is asked where that person wrote. answers names the person\'s question this report answers, which'
      + ' takes the message up as within the ticket.',
    '- Your report ends this assignment: after superagent_worker_report returns, stop and finish your run.')
  return lines.join('\n')
}

/**
 * Queues launches and input deliveries as orchestrator actions and reports their outcome back to the Engine.
 * The deps arrive through `install` rather than the constructor because the Engine is built with the executor in hand
 * (two-phase wiring breaks the Engine-executor cycle), so the effect handlers can only register afterwards.
 */
export class ZcodeExecutor implements Executor {
  private deps?: ExecutorDeps

  install(deps: ExecutorDeps): void {
    if (this.deps) throw new Error('The executor is already installed')
    this.deps = deps
    deps.effects.handle('launch', async ({ ticketId, assignmentId }) => { this.launch(ticketId, assignmentId) },
      { limit: () => deps.paused() ? 0 : deps.slots(), retry: [5000, 60_000] })
    deps.effects.handle('delivery', async ({ ticketId, assignmentId }) => { this.deliverWaiting(ticketId, assignmentId) },
      { limit: () => deps.paused() ? 0 : 4, retry: [5000, 60_000] })
  }

  /** Queues the assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.requireDeps().effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /** Queues delivery of the ticket's waiting Inputs; reports back through `Engine.inputsDelivered`. */
  deliver(ticket: Ticket, assignment: Assignment): void {
    this.requireDeps().effects.enqueue('delivery', ticket.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /**
   * Retracts the ticket's undelivered actions; the Engine calls this after the ticket or assignment has already ended in
   * the domain, and a ZCode host has no live worker session to cancel.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.requireDeps().actions.cancelForTicket(ticket.id)
  }

  private requireDeps(): ExecutorDeps {
    if (!this.deps) throw new Error('The executor is not installed; the runtime wires it before any ticket is created')
    return this.deps
  }

  /** Turns a queued launch into a `spawn_worker` action and tells the Engine the assignment runs, in one transaction. */
  private launch(ticketId: string, assignmentId: string): void {
    const deps = this.requireDeps()
    const ticket = deps.store.tickets.get(ticketId)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    // The ticket or the assignment ended while the launch waited: the Engine has spoken, and a retry cannot revive it.
    if (!ticket || !assignment || ticket.ended || assignment.state === 'ended') return
    if (assignment.state === 'running') return // the Engine already knows this assignment runs
    // Concurrency gate over the Engine's own working set, so a restart re-derives it instead of keeping local counters.
    const busy = deps.store.tickets.active().filter(item => !item.ended && item.assignments.some(running => running.state === 'running')).length
    if (busy >= deps.slots()) throw new Later('All worker slots are busy')
    const directory = join(deps.workRoot(), ticketId.slice(0, 12))
    mkdirSync(directory, { recursive: true })
    const prompt = buildAssignmentPrompt(ticket, id => deps.store.triggers.get(id))
    deps.store.atomic(() => {
      deps.actions.add({ kind: 'spawn_worker', ticketId, assignmentId, title: ticket.execution?.name ?? ticket.title, prompt, directory },
        new Date().toISOString())
      deps.engine.assignmentStarted(ticketId, assignmentId)
    })
  }

  /** Queues the ticket's waiting Inputs as a `deliver_inputs` action and records them delivered and read, in one transaction. */
  private deliverWaiting(ticketId: string, assignmentId: string): void {
    const deps = this.requireDeps()
    const ticket = deps.store.tickets.get(ticketId)
    const assignment = ticket?.assignments.find(item => item.id === assignmentId)
    if (!ticket || !assignment || assignment.state !== 'running') return
    if (!ticket.undelivered.length) return
    const inputIds = [...ticket.undelivered]
    const text = JSON.stringify(inputIds.map(id => renderInput(ticket, id, id2 => deps.store.triggers.get(id2))))
    deps.store.atomic(() => {
      deps.actions.add({ kind: 'deliver_inputs', ticketId, assignmentId, inputIds, text }, new Date().toISOString())
      deps.engine.inputsDelivered(ticketId, assignmentId, inputIds)
      // R2 port decision: deliver implies read. Upstream records `readAt` when the worker's Session takes a message into
      // a step; a ZCode subagent has no step events to reconcile against, and the action queue is the delivery channel,
      // so the Engine's read bookkeeping is brought in line with delivery here.
      deps.engine.inputsRead(ticketId, inputIds)
    })
  }
}
