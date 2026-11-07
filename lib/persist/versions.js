/**
 * Manages numbered snapshots of a versioned record in the `Store` key-value table with a pointer key tracking the active revision.
 * Each save writes a new snapshot and advances the pointer atomically, keeping full history without duplicating the active record.
 * Used by `Store` for settings history and by the daemon's prompts module for versioned prompt configuration.
 */
export class Versions {
    store;
    pointer;
    family;
    constructor(store, pointer, family) {
        this.store = store;
        this.pointer = pointer;
        this.family = family;
    }
    /** Current revision number, or `0` before the first save. */
    revision() { return this.store.get(this.pointer) ?? 0; }
    /** Current snapshot, or `undefined` before the first save. */
    current() {
        const revision = this.store.get(this.pointer);
        return revision === undefined ? undefined : this.get(revision);
    }
    get(revision) { return this.store.get(this.family(revision)); }
    save(make) {
        return this.store.atomic(() => {
            const version = make(this.revision() + 1);
            this.store.set(this.family(version.revision), version);
            this.store.set(this.pointer, version.revision);
            return version;
        });
    }
    /** Stores a snapshot without advancing the current revision pointer (e.g., to record an initial built-in baseline). */
    keep(version) { this.store.set(this.family(version.revision), version); }
    list(limit = Infinity) {
        return this.store.keys(this.family).flatMap(name => this.store.get(name) ?? []).sort((a, b) => b.revision - a.revision).slice(0, limit);
    }
}
