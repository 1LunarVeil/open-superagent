/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export const record = (key) => key;
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export function family(prefix, format = (...name) => name.join(':')) {
    return Object.assign((...name) => `${prefix}${format(...name)}`, { prefix });
}
export const KV = {
    /** Store: current database schema version. */
    store: { schema: record('schema') },
    /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
    settings: { revision: record('settings-revision'),
        block: family('settings-block-revision:'),
        version: family('settings-version:') },
    /** Prompts: current revision and saved prompt versions. */
    prompts: { revision: record('prompt-revision'), version: family('prompt-version:'),
        /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
        builtIn: family('prompt-built-in:') },
    /** Runtime: the main Session's ID. */
    runtime: { masterId: record('master-id') },
    /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
    sessions: { prompts: family('session-prompts:') },
    /** Per-Source resolved display names mapping a named ID (such as a chat ID) to its display name. */
    sources: { labels: family('source-labels:') },
    /** Manual Source: per-thread synthetic cursors, if any are ever needed; reserved for phase-3+ Source state. */
    manual: { state: family('manual-state:') },
};
