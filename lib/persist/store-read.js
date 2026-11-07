export function storeReads(db) {
    const values = (sql, ...parameters) => db.prepare(sql).all(...parameters).map(row => JSON.parse(String(row.value)));
    return {
        /** Newest first by arrival (`rowid`) order rather than trigger timestamp. */
        recentTriggers: (offset = 0, limit = 50) => db.prepare('SELECT value FROM trigger ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value))),
        /** Per-source trigger counts since `since`, plus the latest arrival timestamp across all time. */
        triggerStats: (since) => {
            const result = {};
            for (const row of db.prepare("SELECT json_extract(t.value, '$.source') AS source, MAX(t.at) AS last, SUM(t.at >= ?) AS received, SUM(t.at >= ? AND json_extract(d.value, '$.filtered') IS NOT NULL) AS filtered FROM trigger t LEFT JOIN disposition d ON d.id = t.id GROUP BY source").all(since, since))
                result[String(row.source)] = { received: Number(row.received ?? 0), filtered: Number(row.filtered ?? 0), lastAt: String(row.last ?? '') };
            return result;
        },
        /**
         * Counts triggers arriving at or after `since` that passed source filtering and reached a decision,
         * and how many accept/reopen decisions those same arrivals produced.
         */
        flow: (since) => {
            const passed = "t.at >= ? AND NOT EXISTS (SELECT 1 FROM disposition s WHERE s.id = t.id AND json_extract(s.value, '$.filtered') IS NOT NULL)";
            const judged = db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE ${passed}`).get(since);
            const accepted = db.prepare(`SELECT COUNT(DISTINCT d.id) AS n FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE json_extract(d.value, '$.kind') IN ('accept', 'reopen') AND t.at >= ?`).get(since);
            return { judged: Number(judged?.n ?? 0), accepted: Number(accepted?.n ?? 0) };
        },
        triggers: (options, offset = 0, limit = 50) => {
            const where = [...(options.source ? ["json_extract(t.value, '$.source') = ?"] : []), ...(options.filtered ? ["json_extract(d.value, '$.filtered') IS NOT NULL"] : [])];
            const rows = db.prepare(`SELECT t.value FROM trigger t LEFT JOIN disposition d ON d.id = t.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.at DESC LIMIT ? OFFSET ?`).all(...(options.source ? [options.source] : []), limit + 1, offset);
            return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value))), more: rows.length > limit };
        },
        /** Latest `limit` triggers on a thread returned oldest-first, optionally bounded before (or through) `before`. */
        threadTriggers: (threadKeyValue, limit = 50, before, through = false) => {
            const place = before ? `AND (x.at, x.id) ${through ? '<=' : '<'} (?, ?)` : '';
            return values(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${place}
      ORDER BY x.at DESC, x.id DESC LIMIT ?`, threadKeyValue, ...before ? [before.at, before.id] : [], limit).reverse();
        },
        threadPage: (threadKeyValue, offset, limit) => values(`SELECT t.value FROM trigger_thread x
    JOIN trigger t ON t.id = x.id WHERE x.thread = ? ORDER BY x.at DESC, t.rowid DESC LIMIT ? OFFSET ?`, threadKeyValue, limit, offset),
        /** Nearest non-CI triggers on a thread immediately before and after `(at, id)`. */
        neighbours: (threadKeyValue, at, id) => {
            const nearest = (side) => values(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id
      WHERE x.thread = ? AND (x.at, x.id) ${side} (?, ?) AND json_extract(t.value, '$.meta.ci') IS NULL
      ORDER BY x.at ${side === '<' ? 'DESC' : 'ASC'}, x.id ${side === '<' ? 'DESC' : 'ASC'} LIMIT 1`, threadKeyValue, at, id)[0];
            const before = nearest('<'), after = nearest('>');
            return { ...before ? { before } : {}, ...after ? { after } : {} };
        },
        /** Oldest trigger on a thread, used to title the thread in listings. */
        firstTrigger: (threadKeyValue, humanOnly = false) => {
            const row = db.prepare(`SELECT t.value FROM trigger_thread x JOIN trigger t ON t.id = x.id WHERE x.thread = ? ${humanOnly ? 'AND x.human = 1' : ''} ORDER BY x.at ASC, t.rowid ASC LIMIT 1`).get(threadKeyValue);
            return row ? JSON.parse(String(row.value)) : undefined;
        },
        search: (query, limit = 20) => {
            const pattern = `%${query.replace(/[\\%_]/g, match => `\\${match}`)}%`;
            return db.prepare("SELECT value FROM trigger WHERE id = ? OR json_extract(value, '$.url') LIKE ? ESCAPE '\\' OR json_extract(value, '$.meta.messageId') = ? OR json_extract(value, '$.text') LIKE ? ESCAPE '\\' ORDER BY at DESC LIMIT ?").all(query, `${query.replace(/[\\%_]/g, match => `\\${match}`)}%`, query, pattern, limit).map(row => JSON.parse(String(row.value)));
        },
        recentDecisions: (offset = 0, limit = 50) => db.prepare('SELECT value FROM decision ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => JSON.parse(String(row.value))),
        /** Decisions matching `kinds` whose triggers arrived at or after `since`, aligned with `flow` window counts. */
        decisions: (options, offset, limit) => {
            const where = [...(options.kinds.length ? [`json_extract(d.value, '$.kind') IN (${options.kinds.map(() => '?').join(',')})`] : []),
                ...(options.since ? ["EXISTS (SELECT 1 FROM json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value WHERE t.at >= ?)"] : [])];
            const rows = db.prepare(`SELECT d.value FROM decision d ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.rowid DESC LIMIT ? OFFSET ?`)
                .all(...options.kinds, ...(options.since ? [options.since] : []), limit + 1, offset);
            return { items: rows.slice(0, limit).map(row => JSON.parse(String(row.value))), more: rows.length > limit };
        },
        /** Newest decisions of the given kinds, for surfaces that must surface rare outcomes among many ignores. */
        decisionsOfKinds: (kinds, limit = 30) => db.prepare(`SELECT value FROM decision WHERE json_extract(value, '$.kind') IN (${kinds.map(() => '?').join(',')}) ORDER BY rowid DESC LIMIT ?`).all(...kinds, limit).map(row => JSON.parse(String(row.value))),
        /** Messages whose `reply` effect failed, with consecutive failure count and last error, oldest first. */
        failingReplies: () => db.prepare(`SELECT o.value, e.attempts, e.error FROM effect e
    JOIN outbox o ON o.id = e.key WHERE e.kind = 'reply' AND e.attempts > 0 ORDER BY e.seq`).all()
            .map(row => ({ ...JSON.parse(String(row.value)), attempts: Number(row.attempts), error: String(row.error) })),
        droppedReplies: (limit = 20) => values('SELECT value FROM outbox WHERE dropped IS NOT NULL ORDER BY dropped DESC LIMIT ?', limit),
        droppedSince: (since) => Number(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE dropped >= ?').get(since)?.n ?? 0),
        subscribedThreads: (source) => source
            ? values('SELECT value FROM thread WHERE subscribed = ? ORDER BY rowid', source)
            // Force the partial index so SQLite does not scan the entire table in rowid order.
            : values('SELECT value FROM thread INDEXED BY thread_subscribed WHERE subscribed IS NOT NULL ORDER BY rowid'),
    };
}
