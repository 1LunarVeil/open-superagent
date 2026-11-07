/**
 * The orchestrator's pending-action queue: durable records of what the ZCode main session (the Orchestrator) must do next,
 * written inside the Engine's transactions with the same transactional-outbox discipline as `Effects`, and handed out by
 * the `superagent_tick` tool. Port note: upstream steered its in-process main Session (agent steer, followup, inject), which
 * a ZCode host cannot do — the main session instead reads its work from this queue and acts through the open-superagent skill.
 *
 * Handout is a lease, not a claim: `take` stamps every row it returns with an expiry and leaves it in the queue, so a
 * session that dies mid-protocol gets the work back after the lease lapses instead of losing it. Protocols that are not
 * idempotent (spawning a worker) are re-checked against the domain before they are handed out again.
 */
import { key, ticketStage } from "../kernel/index.js";
/** How long a handed-out action stays leased before it can be handed out again. */
export const LEASE_MS = 10 * 60_000;
/** How long a delivered action is kept, so a status read can explain what the orchestrator already did. */
export const RETENTION_MS = 7 * 24 * 60 * 60_000;
/** The action table. Plain single-quoted statement constants run through prepared statements, never a script runner. */
const CREATE_ACTION = 'CREATE TABLE IF NOT EXISTS action (id TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, lease TEXT, retries INTEGER NOT NULL DEFAULT 0)';
const CREATE_ACTION_INDEX = 'CREATE INDEX IF NOT EXISTS action_undelivered ON action(delivered, at) WHERE delivered = 0';
/** Compact stage label for cards and status views, with the upstream ticket-card states (docs/003): person actions and the queued marker read like the upstream ticket cards. */
export function stageLabel(stage) {
    if (stage.stage === 'person')
        return 'person/' + stage.action;
    if (stage.stage === 'working' && stage.action)
        return 'working/queued';
    return stage.stage;
}
/**
 * Builds a candidate card for an Eval's assessor: the batch triggers, the tickets already on the thread, and the newest
 * thread context outside the batch. Facts only, no authority: the card never carries the Policy, which the main session
 * reads from its own settings.
 */
export function candidateCard(candidate, context) {
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
    };
}
/** Builds the ThreadRef of the manual Source, whose thread ids are the main session's conversation keys. */
export const threadRefOf = (source, id) => ({ source, id });
/**
 * Durable pending-action queue over the Store's SQLite database.
 * Rows are written with their content hash as the id, so a retried writer or a replayed effect handler cannot queue an
 * action twice. `take` leases rows for a bounded time instead of retiring them, and `ack` retires exactly the rows the
 * orchestrator finished, so a lost session costs one lease rather than the work.
 */
export class Actions {
    store;
    now;
    constructor(store, now = () => Date.now()) {
        this.store = store;
        this.now = now;
        this.store.db.prepare(CREATE_ACTION).run();
        this.store.db.prepare(CREATE_ACTION_INDEX).run();
        this.addLeaseColumn();
    }
    /** Reconciles databases created before leases existed: the columns are added and every old row counts as delivered. */
    addLeaseColumn() {
        const columns = this.store.db.prepare('PRAGMA table_info(action)').all().map(row => String(row.name));
        if (!columns.includes('lease'))
            this.store.db.prepare('ALTER TABLE action ADD COLUMN lease TEXT').run();
        if (!columns.includes('retries'))
            this.store.db.prepare('ALTER TABLE action ADD COLUMN retries INTEGER NOT NULL DEFAULT 0').run();
    }
    /** Records `action` idempotently (equal content keeps its first row); call inside the writer's transaction. */
    add(action, at) {
        this.store.db.prepare('INSERT OR IGNORE INTO action (id, kind, value, at) VALUES (?, ?, ?, ?)')
            .run(key('action', JSON.stringify(action)), action.kind, JSON.stringify(action), at);
    }
    /**
     * Drops the ticket's undelivered actions, so the main session never acts on work the Engine has already ended or
     * replaced, and drops a pending candidate assessment whose card names this ticket: the work it would judge is gone.
     * Nothing is lost — an Eval whose card was dropped still holds its triggers and requeues on expiry with a fresh card,
     * and `notice` actions (which name no ticket) always stay.
     */
    cancelForTicket(ticketId) {
        this.store.atomic(() => {
            const rows = this.store.db.prepare('SELECT id, value FROM action WHERE delivered = 0').all();
            const drop = rows.flatMap(row => {
                const action = JSON.parse(String(row.value));
                const matched = action.kind === 'spawn_worker' || action.kind === 'deliver_inputs' || action.kind === 'relay'
                    ? action.ticketId === ticketId
                    : action.kind === 'assess_candidate' ? action.card.tickets.some(item => item.id === ticketId)
                        : false;
                return matched ? [String(row.id)] : [];
            });
            const remove = this.store.db.prepare('DELETE FROM action WHERE id = ?');
            for (const id of drop)
                remove.run(id);
        });
    }
    /** Every action that is waiting (never handed out) or whose lease lapsed, oldest first, as raw rows. */
    pending() {
        return this.store.db.prepare('SELECT value FROM action WHERE delivered = 0 ORDER BY at, rowid').all()
            .map(row => JSON.parse(String(row.value)));
    }
    /**
     * Leases every action that is waiting or whose lease lapsed and returns it with its row id, in queue order.
     * A row already leased to a live session is skipped, so two ticks in the same session never duplicate work.
     */
    take() {
        return this.store.atomic(() => {
            const due = this.now();
            const rows = this.store.db.prepare('SELECT id, value, retries FROM action WHERE delivered = 0 AND (lease IS NULL OR lease <= ?) ORDER BY at, rowid')
                .all(new Date(due).toISOString());
            if (!rows.length)
                return [];
            const lease = new Date(due + LEASE_MS).toISOString();
            const stamp = this.store.db.prepare('UPDATE action SET lease = ?, retries = retries + 1 WHERE id = ?');
            const repeat = this.store.db.prepare('SELECT retries FROM action WHERE id = ?');
            return rows.map(row => {
                stamp.run(lease, row.id);
                const retries = Number(repeat.get(row.id)?.retries ?? row.retries) - 1;
                return { ...JSON.parse(row.value), actionId: String(row.id), ...(retries > 0 ? { retry: true } : {}) };
            });
        });
    }
    /** Retires the actions the orchestrator finished; ids not in the queue are ignored, so a repeated ack is harmless. */
    ack(ids) {
        if (!ids.length)
            return 0;
        return this.store.atomic(() => {
            // `delivered = 0` keeps a repeated ack out of the count: nothing changed, so nothing is reported as retired.
            const retire = this.store.db.prepare('UPDATE action SET delivered = 1, lease = NULL WHERE id = ? AND delivered = 0');
            let retired = 0;
            for (const id of ids)
                retired += Number(retire.run(id).changes);
            return retired;
        });
    }
    /**
     * Releases every lease held by a previous process. Only one daemon may own the state directory, so a lease found at
     * startup belongs to a session that is gone: keeping it would hide its actions for the whole lease window and `tick`
     * would answer "No pending actions" while work waits. Called once by the runtime before the MCP server accepts calls.
     */
    releaseAllLeases() {
        return Number(this.store.db.prepare('UPDATE action SET lease = NULL WHERE delivered = 0 AND lease IS NOT NULL').run().changes);
    }
    /** Drops the handed-out actions whose Eval no longer holds their trigger, so a decided candidate is not re-assessed. */
    dropStaleAssessments(holds) {
        return this.store.atomic(() => {
            const rows = this.store.db.prepare("SELECT id, value FROM action WHERE delivered = 0 AND kind = 'assess_candidate'").all();
            const remove = this.store.db.prepare('DELETE FROM action WHERE id = ?');
            let dropped = 0;
            for (const row of rows) {
                const action = JSON.parse(String(row.value));
                if (action.kind !== 'assess_candidate')
                    continue;
                const triggers = action.card.triggers;
                if (triggers.length && triggers.every(trigger => !holds(trigger.id))) {
                    remove.run(String(row.id));
                    dropped += 1;
                }
            }
            return dropped;
        });
    }
    /** Drops one handed-out action, for a step the domain shows is already served. */
    discard(id) { this.store.db.prepare('DELETE FROM action WHERE id = ?').run(id); }
    /** Drops a handed-out action without acting on it (a spawn the domain already served), keeping the queue clean. */
    drop(id) { this.store.db.prepare('DELETE FROM action WHERE id = ?').run(id); }
    /** Deletes delivered rows past the retention window so the queue does not grow without bound. */
    prune() {
        const cutoff = new Date(this.now() - RETENTION_MS).toISOString();
        return Number(this.store.db.prepare('DELETE FROM action WHERE delivered = 1 AND at < ?').run(cutoff).changes);
    }
    /** Count of rows still waiting (unleased or lease-lapsed), for status surfaces. */
    count() {
        return Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM action WHERE delivered = 0').get()?.n ?? 0);
    }
    /** How many actions are leased to the current session right now, and when the earliest lease lapses. */
    leased() {
        const row = this.store.db.prepare('SELECT COUNT(*) AS n, MIN(lease) AS until FROM action WHERE delivered = 0 AND lease > ?')
            .get(new Date(this.now()).toISOString());
        const count = Number(row?.n ?? 0);
        return count ? { count, ...(row?.until ? { until: String(row.until) } : {}) } : { count: 0 };
    }
}
