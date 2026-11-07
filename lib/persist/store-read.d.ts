/** Read-only Store queries for views, tools, and Source polling. */
import type { DatabaseSync } from 'node:sqlite';
import type { Decision, Thread, Trigger } from '../kernel/index.ts';
import type { Dropped, Receipt, TimelinePlace } from './store.ts';
export declare function storeReads(db: DatabaseSync): {
    /** Newest first by arrival (`rowid`) order rather than trigger timestamp. */
    recentTriggers: (offset?: number, limit?: number) => Trigger[];
    /** Per-source trigger counts since `since`, plus the latest arrival timestamp across all time. */
    triggerStats: (since: string) => Record<string, {
        received: number;
        filtered: number;
        lastAt: string;
    }>;
    /**
     * Counts triggers arriving at or after `since` that passed source filtering and reached a decision,
     * and how many accept/reopen decisions those same arrivals produced.
     */
    flow: (since: string) => {
        judged: number;
        accepted: number;
    };
    triggers: (options: {
        source?: string;
        filtered?: boolean;
    }, offset?: number, limit?: number) => {
        items: Trigger[];
        more: boolean;
    };
    /** Latest `limit` triggers on a thread returned oldest-first, optionally bounded before (or through) `before`. */
    threadTriggers: (threadKeyValue: string, limit?: number, before?: TimelinePlace, through?: boolean) => Trigger[];
    threadPage: (threadKeyValue: string, offset: number, limit: number) => Trigger[];
    /** Nearest non-CI triggers on a thread immediately before and after `(at, id)`. */
    neighbours: (threadKeyValue: string, at: string, id: string) => {
        before?: Trigger;
        after?: Trigger;
    };
    /** Oldest trigger on a thread, used to title the thread in listings. */
    firstTrigger: (threadKeyValue: string, humanOnly?: boolean) => Trigger | undefined;
    search: (query: string, limit?: number) => Trigger[];
    recentDecisions: (offset?: number, limit?: number) => Decision[];
    /** Decisions matching `kinds` whose triggers arrived at or after `since`, aligned with `flow` window counts. */
    decisions: (options: {
        kinds: string[];
        since: string;
    }, offset: number, limit: number) => {
        items: Decision[];
        more: boolean;
    };
    /** Newest decisions of the given kinds, for surfaces that must surface rare outcomes among many ignores. */
    decisionsOfKinds: (kinds: string[], limit?: number) => Decision[];
    /** Messages whose `reply` effect failed, with consecutive failure count and last error, oldest first. */
    failingReplies: () => (Receipt & {
        attempts: number;
        error: string;
    })[];
    droppedReplies: (limit?: number) => Dropped[];
    droppedSince: (since: string) => number;
    subscribedThreads: (source?: string) => Thread[];
};
