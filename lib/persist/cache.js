/**
 * In-memory LRU cache bounded by total UTF-16 code units, always retaining the most recently inserted entry.
 * The daemon uses separate instances to cache paginated resource snapshots for `superagent_read` and resolved message links.
 */
export class TextCache {
    limit;
    texts = new Map();
    size = 0;
    constructor(limit) {
        this.limit = limit;
    }
    get(key) {
        const text = this.texts.get(key);
        if (text !== undefined) {
            this.texts.delete(key);
            this.texts.set(key, text);
        }
        return text;
    }
    set(key, text) {
        this.size -= this.texts.get(key)?.length ?? 0;
        this.texts.delete(key);
        this.texts.set(key, text);
        this.size += text.length;
        for (const [oldest, value] of this.texts) {
            if (this.size <= this.limit || oldest === key)
                break;
            this.texts.delete(oldest);
            this.size -= value.length;
        }
    }
    /** Entries ordered from least to most recently used. */
    entries() { return this.texts.entries(); }
}
