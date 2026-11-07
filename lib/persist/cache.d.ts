/**
 * In-memory LRU cache bounded by total UTF-16 code units, always retaining the most recently inserted entry.
 * The daemon uses separate instances to cache paginated resource snapshots for `superagent_read` and resolved message links.
 */
export declare class TextCache {
    private readonly limit;
    private readonly texts;
    private size;
    constructor(limit: number);
    get(key: string): string | undefined;
    set(key: string, text: string): void;
    /** Entries ordered from least to most recently used. */
    entries(): IterableIterator<[string, string]>;
}
