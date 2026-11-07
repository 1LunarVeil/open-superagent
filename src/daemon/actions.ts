/**
 * The orchestrator's pending-action queue: durable records of what the ZCode main session (the Orchestrator) must do next,
 * written inside the Engine's transactions with the same transactional-outbox discipline as `Effects`, and handed out by
 * the `superagent_tick` tool. Port note: upstream steered its in-process main Session (agent steer, followup, inject), which
 * a ZCode host cannot do — the main session instead reads its work from this queue and acts through the open-superagent skill.
 */
import { key, ticketStage } from '../kernel/index.ts'
import type { Candidate, ChannelRef, ThreadRef, TicketStage, Trigger } from '../kernel/index.ts'
import type { Store } from '../persist/store.ts'

/** A candidate card: the bounded facts an assessor judges, rendered without authority. */
export interface CandidateCard {
  evalId: string
  threadKey: string
  strength: 'explicit' | 'inferred'
  /** The batch, oldest first; `text` is cut at 2000 characters. */
  triggers: { id: string; at: string; actor: { source: string; id: string }; human: boolean; addressed?: string; text: string; url?: string }[]
  /** Tickets already on the thread, for duplicate judgement, each with its stage (docs/003). */
  tickets: { id: string; title: string; ended: boolean; stage: string }[]
  /** Bounded thread context around the batch: the newest triggers outside the batch, `text` cut at 500 characters, at most 10 kept. */
  context: { id: string; at: string; actor: { source: string; id: string }; human: boolean; text: string }[]
}

/** One unit of work the main session reads on its next tick and acts on through the open-superagent skill. */
export type PendingAction =
  | { kind: 'assess_candidate'; evalId: string; card: CandidateCard }
  | { kind: 'spawn_worker'; ticketId: string; assignmentId: string; title: string; prompt: string; directory: string }
  | { kind: 'deliver_inputs'; ticketId: string; assignmentId: string; inputIds: string[]; text: string }
  | { kind: 'relay'; text: string; ticketId?: string }
  | { kind: 'notice'; summary: string; value: Record<string, unknown> }
  | { kind: 'reply_recorded'; messageId: string; channel: ChannelRef; text: string; messageKind: string; ticketId?: string }

/** The action table. Plain single-quoted statement constants run through prepared statements, never a script runner. */
const CREATE_ACTION = 'CREATE TABLE IF NOT EXISTS action (id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)'
const CREATE_ACTION_INDEX = 'CREATE INDEX IF NOT EXISTS action_undelivered ON action(delivered, at) WHERE delivered = 0'

/** Compact stage label for cards and status views, with the upstream ticket-card states (docs/003): person actions and the queued marker read like the upstream ticket cards. */
export function stageLabel(stage: TicketStage): string {
  if (stage.stage === 'person') return 'person/' + stage.action
  if (stage.stage === 'working' && stage.action) return 'working/queued'
  return stage.stage
}

/**
 * Builds a candidate card for an Eval's assessor: the batch triggers, the tickets already on the thread, and the newest
 * thread context outside the batch. Facts only, no authority: the card never carries the Policy, which the main session
 * reads from its own settings.
 */
export function candidateCard(candidate: Candidate, context: Trigger[]): CandidateCard {
  return {
    evalId: candidate.evalId,
    threadKey: candidate.thread.key,
    strength: candidate.strength,
    triggers: candidate.triggers.map(trigger => ({
      id: trigger.id,
      at: trigger.at,
      actor: { source: trigger.actor.source, id: trigger.actor.id },
      human: trigger.human,
      ...(trigger.addressed ? { addressed: trigger.addressed } : {}),
      text: trigger.text.slice(0, 2000),
      ...(trigger.url ? { url: trigger.url } : {}),
    })),
    tickets: candidate.tickets.map(ticket => ({ id: ticket.id, title: ticket.title, ended: !!ticket.ended, stage: stageLabel(ticketStage(ticket)) })),
    context: context.slice(-10).map(trigger => ({
      id: trigger.id,
      at: trigger.at,
      actor: { source: trigger.actor.source, id: trigger.actor.id },
      human: trigger.human,
      text: trigger.text.slice(0, 500),
    })),
  }
}

/** Builds the ThreadRef of the manual Source, whose thread ids are the main session's conversation keys. */
export const threadRefOf = (source: string, id: string): ThreadRef => ({ source, id })

/**
 * Durable pending-action queue over the Store's SQLite database.
 * Rows are written with their content hash as the id, so a retried writer or a replayed effect handler cannot queue an
 * action twice, and every write happens inside the caller's transaction (or a savepoint of one); `take` hands out and
 * retires the queue in one transaction, so an action is acted on at most once even across restarts.
 */
export class Actions {
  constructor(private readonly store: Store) {
    this.store.db.prepare(CREATE_ACTION).run()
    this.store.db.prepare(CREATE_ACTION_INDEX).run()
  }

  /** Records `action` idempotently (equal content keeps its first row); call inside the writer's transaction. */
  add(action: PendingAction, at: string): void {
    this.store.db.prepare('INSERT OR IGNORE INTO action (id, kind, value, at) VALUES (?, ?, ?, ?)')
      .run(key('action', JSON.stringify(action)), action.kind, JSON.stringify(action), at)
  }

  /**
   * Drops the ticket's undelivered spawn, deliver, and relay actions, so the main session never acts on work the Engine has
   * already ended or replaced, and drops a pending candidate assessment whose card names this ticket: the work it would
   * judge is gone. Nothing is lost — an Eval whose card was dropped still holds its triggers and requeues on expiry with a
   * fresh card, and `notice` actions (which name no ticket) always stay.
   */
  cancelForTicket(ticketId: string): void {
    this.store.atomic(() => {
      const rows = this.store.db.prepare('SELECT id, value FROM action WHERE delivered = 0').all()
      const drop = rows.flatMap(row => {
        const action = JSON.parse(String(row.value)) as PendingAction
        const matched = action.kind === 'spawn_worker' || action.kind === 'deliver_inputs' || action.kind === 'relay'
          ? action.ticketId === ticketId
          : action.kind === 'assess_candidate' ? action.card.tickets.some(item => item.id === ticketId)
          : false
        return matched ? [String(row.id)] : []
      })
      const remove = this.store.db.prepare('DELETE FROM action WHERE id = ?')
      for (const id of drop) remove.run(id)
    })
  }

  /** Undelivered actions oldest first; the order a `take` caller acts in. */
  pending(): PendingAction[] {
    return this.store.db.prepare('SELECT value FROM action WHERE delivered = 0 ORDER BY at, rowid').all()
      .map(row => JSON.parse(String(row.value)) as PendingAction)
  }

  /** Returns every undelivered action in queue order and marks them all delivered, in one transaction. */
  take(): PendingAction[] {
    return this.store.atomic(() => {
      const actions = this.pending()
      if (actions.length) this.store.db.prepare('UPDATE action SET delivered = 1 WHERE delivered = 0').run()
      return actions
    })
  }
}
