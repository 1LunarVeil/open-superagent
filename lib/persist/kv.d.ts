/**
 * Typed key-value store keys and key families grouped by the single component that owns and writes each family.
 * Readers and writers refer to a record by its entry here so each key is spelled once with its value type.
 * Port note: the `queues` legacy-migration family and the `github`/`feishu` Source families return with those phases.
 */
import type { SettingsSave } from '../kernel/policy.ts';
import type { SettingsVersion } from './store.ts';
/** Key of a KV record whose value has type `V`; a plain string represents an untyped key. */
export type Key<V> = string & {
    readonly __value?: V;
};
/** Family of KV records sharing a prefix: callable to build a key from its name parts, and exposing `prefix` for listing. */
export type Family<V, A extends unknown[]> = ((...name: A) => Key<V>) & {
    readonly prefix: string;
};
/** Define a single typed KV key; external Source plugins use `record` and `family` to type their own keys. */
export declare const record: <V>(key: string) => Key<V>;
/** Define a KV key family whose keys join `prefix` and name parts with `:` (or a custom `format`). */
export declare function family<V, A extends unknown[] = [string]>(prefix: string, format?: (...name: A) => string): Family<V, A>;
/** A saved prompt configuration version (see the daemon's prompts module). */
export interface PromptVersion {
    revision: number;
    current: string;
    parts: Record<string, string>;
}
export declare const KV: {
    /** Store: current database schema version. */
    store: {
        schema: Key<number>;
    };
    /** Settings: current revision, per-block revision, and saved settings snapshots (including the current one). */
    settings: {
        revision: Key<number>;
        block: Family<number, [block: SettingsSave]>;
        version: Family<SettingsVersion, [revision: number]>;
    };
    /** Prompts: current revision and saved prompt versions. */
    prompts: {
        revision: Key<number>;
        version: Family<PromptVersion, [revision: number]>;
        /** The built-in text of a prompt part an override was edited from, by its `base`, which shows what an upgrade changed. */
        builtIn: Family<string, [base: string]>;
    };
    /** Runtime: the main Session's ID. */
    runtime: {
        masterId: Key<string>;
    };
    /** Sessions: prompt revisions each Session has worked under, ordered oldest first; the last entry (`.at(-1)`) is its active revision. */
    sessions: {
        prompts: Family<number[], [session: string]>;
    };
    /** Per-Source resolved display names mapping a named ID (such as a chat ID) to its display name. */
    sources: {
        labels: Family<Record<string, string>, [source: string]>;
    };
    /** Manual Source: per-thread synthetic cursors, if any are ever needed; reserved for phase-3+ Source state. */
    manual: {
        state: Family<Record<string, unknown>, [key: string]>;
    };
};
