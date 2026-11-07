/** Versioned record storage backed by numbered snapshots and a current-revision pointer in the Store KV table. */
import type { Family, Key } from './kv.ts';
import type { Store } from './store.ts';
/**
 * Manages numbered snapshots of a versioned record in the `Store` key-value table with a pointer key tracking the active revision.
 * Each save writes a new snapshot and advances the pointer atomically, keeping full history without duplicating the active record.
 * Used by `Store` for settings history and by the daemon's prompts module for versioned prompt configuration.
 */
export declare class Versions<V extends {
    revision: number;
}> {
    private readonly store;
    private readonly pointer;
    private readonly family;
    constructor(store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>, pointer: Key<number>, family: Family<V, [revision: number]>);
    /** Current revision number, or `0` before the first save. */
    revision(): number;
    /** Current snapshot, or `undefined` before the first save. */
    current(): V | undefined;
    get(revision: number): V | undefined;
    save(make: (revision: number) => V): V;
    /** Stores a snapshot without advancing the current revision pointer (e.g., to record an initial built-in baseline). */
    keep(version: V): void;
    list(limit?: number): V[];
}
