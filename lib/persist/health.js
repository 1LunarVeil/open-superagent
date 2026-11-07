/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by the daemon, Effects, the Executor, Settings, and SourceRegistry, and read by status tools.
 */
export class HealthBoard {
    entries = {};
    claimed = new Set();
    claim(name, initial) {
        if (this.claimed.has(name))
            throw new Error(`The health entry ${name} is reported by another part`);
        this.claimed.add(name);
        if (initial)
            this.entries[name] = initial;
        let held = true;
        return {
            get: () => this.entries[name],
            set: health => { if (held)
                this.entries[name] = health; },
            release: () => {
                if (!held)
                    return;
                held = false;
                this.claimed.delete(name);
                delete this.entries[name];
            },
        };
    }
    get all() { return this.entries; }
}
