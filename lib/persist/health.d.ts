/** Component health registry displayed in status views. */
export type Health = {
    state: 'starting' | 'ready' | 'paused' | 'error';
    detail: string;
    at?: string;
    code?: string;
    values?: Record<string, string>;
};
export interface HealthEntry {
    get(): Health | undefined;
    set(health: Health): void;
    /** Unregisters the entry from the board (such as when a Source kind unregisters); subsequent `set` calls become no-ops. */
    release(): void;
}
/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by the daemon, Effects, the Executor, Settings, and SourceRegistry, and read by status tools.
 */
export declare class HealthBoard {
    private readonly entries;
    private readonly claimed;
    claim(name: string, initial?: Health): HealthEntry;
    get all(): Readonly<Record<string, Health>>;
}
