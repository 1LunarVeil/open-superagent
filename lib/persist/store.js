/** SQLite persistence for domain aggregates, key-value state, settings history, and the channel outbox. */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { key, threadKey } from "../kernel/index.js";
import { KV } from "./kv.js";
import { SettingsSchema } from "../kernel/policy.js";
import { Versions } from "./versions.js";
import { storeReads } from "./store-read.js";
/**
 * Generated columns and partial indexes defining active working sets so passes scan only active rows.
 * Older databases missing a column get it added on open and populated by SQLite from stored JSON rows.
 */
const SETS = {
    ticket: {
        open: "INTEGER AS (CASE WHEN value -> '$.ended' IS NULL THEN 1 END)",
        // Only the latest assignment can be pending or running because the Engine closes one before adding the next.
        active: `INTEGER AS (CASE WHEN json_array_length(value, '$.undelivered') > 0
      OR value ->> '$.assignments[#-1].state' IN ('pending', 'running') THEN 1 END)`,
    },
    thread: {
        active: "INTEGER AS (CASE WHEN json_array_length(value, '$.pending') > 0 OR value -> '$.evaluating' IS NOT NULL THEN 1 END)",
        subscribed: "TEXT AS (CASE WHEN json_array_length(value, '$.subscriptions') > 0 THEN value ->> '$.ref.source' END)",
    },
    // Composite key (ticketId + thread) used to preserve per-conversation reply order.
    outbox: { dropped: "TEXT AS (value ->> '$.dropped.at')", pending: `TEXT AS (CASE WHEN value ->> '$.status' = 'pending'
    AND value ->> '$.ticketId' IS NOT NULL THEN (value ->> '$.ticketId') || ' ' || (value ->> '$.channel.thread') END)` },
};
/** The only schema version this build creates or opens; databases below it predate the port and are refused. */
export const SCHEMA_VERSION = 11;
/**
 * SQLite backing store implementing domain `Repositories`, view read queries, versioned settings, outbox receipts, and key-value state.
 * The daemon opens it after locking the state directory; this build creates schema 11 only and refuses anything older.
 * The Engine mutates domain aggregates inside `atomic` transactions while Sources, views, and the Outbox read state or update their own records.
 */
export class Store {
    report;
    db;
    /**
     * Opens or creates the SQLite database at `path`; this build only creates or opens schema 11 and does not port the schema 10 to 11 migration.
     * @param report - Receives errors thrown by `afterCommit` callbacks without failing the committed transaction.
     * @throws When the database schema is not `SCHEMA_VERSION` (11); in that case the database file is left unchanged and the SQLite handle is closed so a later attempt in the same process can open it.
     */
    constructor(path, report = () => { }) {
        this.report = report;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path);
        this.read = storeReads(this.db);
        try {
            chmodSync(path, 0o600);
            this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
            const version = this.get(KV.store.schema);
            if (version !== undefined && version !== SCHEMA_VERSION)
                throw new Error('Unsupported open-superagent database version ' + version + '; this build opens schema ' + SCHEMA_VERSION + ' only');
            this.atomic(() => {
                this.db.exec(`
          CREATE TABLE IF NOT EXISTS trigger (id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS disposition (id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS decision (id TEXT PRIMARY KEY, thread TEXT NOT NULL, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS trigger_thread (thread TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, human INTEGER NOT NULL,
            PRIMARY KEY (thread, id));
          CREATE TABLE IF NOT EXISTS effect (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
            generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL,
            since TEXT NOT NULL, PRIMARY KEY (kind, key));
          CREATE INDEX IF NOT EXISTS trigger_at ON trigger(at);
          CREATE INDEX IF NOT EXISTS trigger_thread_at ON trigger_thread(thread, at);
          CREATE INDEX IF NOT EXISTS decision_thread ON decision(thread);
          CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
        `);
                this.addColumns();
                if (version !== SCHEMA_VERSION)
                    this.set(KV.store.schema, SCHEMA_VERSION);
            });
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    /** Reconciles generated working-set columns and indexes when opening databases created by earlier versions. */
    addColumns() {
        const columns = (table) => new Set(this.db.prepare('SELECT name FROM pragma_table_xinfo(?)').all(table).map(row => String(row.name)));
        for (const [table, definitions] of Object.entries(SETS)) {
            // Drop generated columns whose definition changed or that were removed, along with their index, before adding current ones.
            const sql = String(this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? '');
            const generated = this.db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)').all(table).map(row => String(row.name));
            for (const name of generated) {
                if (definitions[name] && sql.includes(name + ' ' + definitions[name]))
                    continue;
                this.db.exec(['DROP INDEX IF EXISTS ' + table + '_' + name + ';', 'ALTER TABLE', table, 'DROP COLUMN', name].join(' '));
            }
            const existing = columns(table);
            for (const [name, definition] of Object.entries(definitions)) {
                if (!existing.has(name))
                    this.db.exec(['ALTER TABLE', table, 'ADD COLUMN', name, definition].join(' '));
                this.db.exec(['CREATE INDEX IF NOT EXISTS ' + table + '_' + name, 'ON', table + '(' + name + ')', 'WHERE', name, 'IS NOT NULL'].join(' '));
            }
        }
        if (!columns('effect').has('generation'))
            this.db.exec('ALTER TABLE effect ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    }
    /** Closes the underlying SQLite database connection. */
    close() { this.db.close(); }
    /** Parses JSON `value` columns returned by `sql`. */
    values(sql, ...parameters) {
        return this.db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)));
    }
    /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
    indexThreads(trigger) {
        this.db.prepare('DELETE FROM trigger_thread WHERE id=?').run(trigger.id);
        const insert = this.db.prepare('INSERT OR IGNORE INTO trigger_thread VALUES (?,?,?,?)');
        for (const ref of trigger.threads)
            insert.run(threadKey(ref), trigger.id, trigger.at, trigger.human ? 1 : 0);
    }
    depth = 0;
    /** Callbacks queued to run once the outermost transaction commits, indexed by savepoint level; rolling back a level discards its callbacks. */
    committed = [];
    /**
     * Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
     * Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
     */
    atomic(operation) {
        const level = this.depth++;
        const name = 'open_superagent_atomic_' + level;
        this.committed[level] = [];
        this.db.exec('SAVEPOINT ' + name);
        let value;
        try {
            value = operation();
            this.db.exec('RELEASE ' + name);
        }
        catch (error) {
            this.db.exec('ROLLBACK TO ' + name);
            this.db.exec('RELEASE ' + name);
            throw error;
        }
        finally {
            this.depth--;
        }
        const actions = this.committed.splice(level)[0];
        if (level)
            this.committed[level - 1].push(...actions);
        else
            for (const action of actions) {
                try {
                    action();
                }
                catch (error) {
                    this.report(error);
                }
            }
        return value;
    }
    /**
     * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
     * callbacks queued inside a transaction that rolls back are discarded and never run.
     * Use `afterCommit` for immediate in-memory follow-ups to a committed write (such as refreshing health or cancelling an in-memory turn) that cannot wait for the effect queue and need not survive a restart; use `Effects` for durable side effects that must survive a crash.
     */
    afterCommit(action) {
        if (this.depth)
            this.committed[this.depth - 1].push(action);
        else
            action();
    }
    /** Reads a typed KV record by its key in `KV`. */
    get(name) {
        const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(name);
        return row === undefined ? undefined : JSON.parse(String(row.value));
    }
    /** Writes a typed KV record under `name`. */
    set(name, value) {
        this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, JSON.stringify(value));
    }
    /** Deletes the KV record at `name`. */
    delete(name) { this.db.prepare('DELETE FROM kv WHERE key=?').run(name); }
    keys(family) {
        const prefix = typeof family === 'string' ? family : family.prefix;
        const pattern = `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`;
        return this.db.prepare("SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'").all(pattern).map(row => String(row.key));
    }
    /** Versioned settings snapshots; the current settings are the snapshot of the latest revision. */
    settingsVersions = new Versions(this, KV.settings.revision, KV.settings.version);
    /** Current validated settings. */
    settings() { return SettingsSchema.parse(this.settingsVersions.current()?.settings ?? {}); }
    /** Revision of one settings block; each configuration page saves against its own block for optimistic concurrency. */
    blockRevision(block) { return this.get(KV.settings.block(block)) ?? 0; }
    /** Saves settings as the next revision (making it current) and increments `record.block`'s revision counter when present. */
    saveSettings(value, record = { source: 'internal', policyVersion: '', policyChanged: false, notified: [] }) {
        const settings = SettingsSchema.parse(value);
        return this.atomic(() => {
            this.settingsVersions.save(revision => ({ ...record, revision, savedAt: new Date().toISOString(), settings }));
            if (record.block)
                this.set(KV.settings.block(record.block), this.blockRevision(record.block) + 1);
            return settings;
        });
    }
    /** Saved settings revisions, newest first; revisions predating settings history are absent. */
    settingsHistory(limit = 20) { return this.settingsVersions.list(limit); }
    triggers = {
        get: (id) => { const row = this.db.prepare('SELECT value FROM trigger WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) : undefined; },
        save: (trigger) => this.atomic(() => {
            this.db.prepare('INSERT INTO trigger VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, at=excluded.at').run(trigger.id, JSON.stringify(trigger), trigger.at);
            this.indexThreads(trigger);
        }),
        disposition: (id) => { const row = this.db.prepare('SELECT value FROM disposition WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) : undefined; },
        saveDisposition: (id, value) => { this.db.prepare('INSERT INTO disposition VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)); },
    };
    threads = {
        get: (keyValue) => { const row = this.db.prepare('SELECT value FROM thread WHERE key=?').get(keyValue); return row ? JSON.parse(String(row.value)) : undefined; },
        save: (thread) => { this.db.prepare('INSERT INTO thread VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(thread.key, JSON.stringify(thread)); },
        list: () => this.db.prepare('SELECT value FROM thread ORDER BY rowid').all().map(row => JSON.parse(String(row.value))),
        active: () => this.values('SELECT value FROM thread WHERE active = 1 ORDER BY rowid'),
        /** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
        describe: (keyValue, patch) => {
            const thread = this.threads.get(keyValue);
            if (!thread)
                return;
            const facts = { ...thread.meta.facts };
            for (const [id, fact] of Object.entries(patch.facts ?? {})) {
                if (fact)
                    facts[id] = fact;
                else
                    delete facts[id];
            }
            const meta = { ...thread.meta, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.url === undefined ? {} : { url: patch.url }), facts };
            if (JSON.stringify(meta) !== JSON.stringify(thread.meta))
                this.threads.save({ ...thread, meta });
        },
        /** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
        patchMeta: (keyValue, patch) => this.atomic(() => {
            const thread = this.threads.get(keyValue);
            if (!thread)
                return;
            const meta = { ...thread.meta };
            for (const [name, value] of Object.entries(patch)) {
                if (value === undefined)
                    delete meta[name];
                else
                    meta[name] = value;
            }
            if (JSON.stringify(meta) !== JSON.stringify(thread.meta))
                this.threads.save({ ...thread, meta });
        }),
    };
    tickets = {
        get: (id) => { const row = this.db.prepare('SELECT value FROM ticket WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) : undefined; },
        save: (ticket) => { this.db.prepare('INSERT INTO ticket VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(ticket.id, JSON.stringify(ticket)); },
        /** Newest first. */
        list: () => this.values('SELECT value FROM ticket ORDER BY rowid DESC'),
        /** Newest first. */
        open: () => this.values('SELECT value FROM ticket WHERE open = 1 ORDER BY rowid DESC'),
        /** Newest first. */
        active: () => this.values('SELECT value FROM ticket WHERE active = 1 ORDER BY rowid DESC'),
    };
    decisions = {
        get: (id) => { const row = this.db.prepare('SELECT value FROM decision WHERE id=?').get(id); return row ? JSON.parse(String(row.value)) : undefined; },
        save: (decision) => { this.db.prepare('INSERT INTO decision VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, thread=excluded.thread').run(decision.id, decision.threadKey, JSON.stringify(decision)); },
        byThread: (threadKeyValue) => this.db.prepare('SELECT value FROM decision WHERE thread=? ORDER BY rowid').all(threadKeyValue).map(row => JSON.parse(String(row.value))),
    };
    /** Read-only queries for management views, orchestrator tools, and source polling (see `storeReads`). */
    read;
    /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
    replyStatus(id) { return this.receipts.get(id)?.status; }
    /** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
    receipts = {
        get: (id) => this.values('SELECT value FROM outbox WHERE id = ?', id)[0],
        /** Pending message receipts, oldest first. */
        waiting: () => this.values("SELECT value FROM outbox WHERE value ->> '$.status' = 'pending' ORDER BY rowid"),
        /** True if an earlier message for the same ticket and conversation is still pending with fewer than `failures` consecutive failed `reply` effect attempts. */
        behind: (id, failures) => !!this.db.prepare(`SELECT 1 FROM outbox earlier
      JOIN outbox message ON message.id = ? LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid AND IFNULL(effect.attempts, 0) < ? LIMIT 1`).get(id, failures),
        /**
         * Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
         * @returns Whether the message ID was newly recorded.
         */
        add: (message) => {
            const receipt = { ...message, status: 'pending' };
            return Number(this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)').run(message.id, JSON.stringify(receipt)).changes) > 0;
        },
        /**
         * Marks a pending receipt as sent or dropped (with drop reason and timestamp), recreating the receipt if the message
         * was withdrawn while being sent so its ID cannot be queued again.
         */
        settle: (message, outcome) => {
            const settled = outcome === 'sent' ? { status: 'sent' } : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } };
            const { id, channel, text, kind, ticketId } = message;
            const updated = this.db.prepare("UPDATE outbox SET value = json_patch(value, ?) WHERE id = ? AND value ->> '$.status' = 'pending'")
                .run(JSON.stringify(settled), id);
            if (!Number(updated.changes))
                this.db.prepare('INSERT OR IGNORE INTO outbox (id, value) VALUES (?, ?)')
                    .run(id, JSON.stringify({ id, channel, text, kind, ...ticketId ? { ticketId } : {}, ...settled }));
        },
        /**
         * Withdraws a pending message that has not yet been sent.
         * @returns Whether a pending message with `id` was waiting and removed.
         */
        withdraw: (id) => Number(this.db.prepare("DELETE FROM outbox WHERE id = ? AND value ->> '$.status' = 'pending'").run(id).changes) > 0,
    };
}
export { key, threadKey };
