/**
 * Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
 * Effects reschedules the row after the initial retry delay without incrementing its failure count, and the Executor throws it from launch and delivery handlers.
 */
export class Later extends Error {
}
/** Consecutive failures before an effect kind reports an error, matching the Sources poll failure threshold. */
export const FAILURES_BEFORE_ERROR = 3;
/**
 * Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
 * Coordinates per-kind handlers, concurrency limits, exponential backoff, and health reporting for the Assessor, Executor, Sessions, and Outbox.
 */
export class Effects {
    store;
    board;
    now;
    handlers = new Map();
    health = new Map();
    tasks = new Set();
    /** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
    broken = new Set();
    seq;
    scheduled = false;
    /** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
    started = false;
    stopped = false;
    constructor(store, board, now = () => Date.now()) {
        this.store = store;
        this.board = board;
        this.now = now;
        this.seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0);
    }
    /** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
    enqueue(kind, key, payload) {
        this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
            .run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString());
        this.kick();
    }
    handle(kind, run, options = {}) {
        if (this.handlers.has(kind))
            throw new Error(`The ${kind} effects already have a handler`);
        this.health.set(kind, this.board.claim(kind));
        const { limit = () => 1, retry = [2000, 60_000], ordered = false, quiet = false } = options;
        this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet });
        this.report(kind);
        this.kick();
    }
    pending(kind, key) {
        return key === undefined ? !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind) : !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key);
    }
    /** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
    cancel(kind, key) {
        this.store.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key);
        this.store.afterCommit(() => { this.report(kind); });
    }
    start() { this.started = true; this.kick(); }
    kick() {
        if (this.scheduled)
            return;
        this.scheduled = true;
        queueMicrotask(() => { this.scheduled = false; this.dispatch(); });
    }
    /** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
    async idle(kind) {
        for (;;) {
            this.dispatch();
            const running = [...this.tasks].filter(task => kind === undefined || task.kind === kind).map(task => task.done);
            if (!running.length)
                return;
            await Promise.allSettled(running);
        }
    }
    /** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
    async drain() {
        this.stopped = true;
        await Promise.allSettled([...this.tasks].map(task => task.done));
    }
    dispatch() {
        if (!this.started || this.stopped)
            return;
        for (const [kind, handler] of this.handlers) {
            try {
                const running = new Set([...this.tasks].filter(task => task.kind === kind).map(task => task.key));
                // Ordered kinds block behind their oldest row even when it is not yet due; limit() is queried only after ready rows exist.
                const rows = (handler.ordered
                    ? this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1').all(kind)
                    : this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?')
                        .all(kind, this.now(), 16 + running.size));
                const ready = handler.ordered && running.size ? [] : rows.filter(row => row.due <= this.now() && !running.has(row.key));
                let room = ready.length ? handler.limit() - running.size : 0;
                for (const row of ready) {
                    if (room-- <= 0)
                        break;
                    this.run(kind, handler, row);
                }
                if (this.broken.delete(kind))
                    this.report(kind);
            }
            catch (error) {
                this.failed(kind, error);
            }
        }
    }
    run(kind, handler, row) {
        const task = { kind, key: row.key, done: Promise.resolve() };
        task.done = this.attempt(kind, handler, row)
            .catch((error) => { this.failed(kind, error); })
            .finally(() => { this.tasks.delete(task); this.kick(); });
        this.tasks.add(task);
    }
    async attempt(kind, handler, row) {
        let failure;
        try {
            await handler.run(JSON.parse(row.value), row.key);
        }
        catch (error) {
            failure = { error };
        }
        // Match seq and generation so a row replaced or re-queued while running is not overwritten.
        const own = 'kind = ? AND key = ? AND seq = ? AND generation = ?', ownRow = [kind, row.key, row.seq, row.generation];
        if (!failure)
            this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow);
        // Leave running rows untouched on shutdown so they retry on the next start.
        else if (this.stopped)
            return;
        else if (failure.error instanceof Later) {
            this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow);
        }
        else {
            const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16));
            this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`)
                .run(String(failure.error).slice(0, 1000), this.now() + delay, ...ownRow);
        }
        if (!this.stopped)
            this.report(kind);
    }
    failed(kind, error) {
        this.broken.add(kind);
        this.health.get(kind)?.set({ state: 'error', detail: `The effect queue failed: ${String(error)}`, at: new Date(this.now()).toISOString() });
    }
    report(kind) {
        const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind);
        const waiting = Number(row?.waiting ?? 0);
        const failing = Number(row?.attempts ?? 0) >= FAILURES_BEFORE_ERROR && !this.handlers.get(kind)?.quiet;
        const detail = waiting ? `${waiting} waiting since ${String(row?.since)}` : 'Nothing waiting';
        this.health.get(kind)?.set(failing
            ? { state: 'error', detail: `${detail}; the last failure: ${String(row?.error)}`, at: new Date(this.now()).toISOString() }
            : { state: 'ready', detail, at: new Date(this.now()).toISOString() });
    }
}
