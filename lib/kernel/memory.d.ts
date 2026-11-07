/** In-memory repository implementation for testing and ephemeral engine instances. */
import { type Decision, type Thread, type Ticket, type Trigger, type TriggerDisposition } from './model.ts';
import type { Repositories } from './ports.ts';
/**
 * In-memory implementation of the Repositories port backed by cloned Map entries so caller mutations do not affect stored state.
 * Provides snapshot-based atomic rollback and matches the ordering semantics of the SQLite store for Engine tests.
 */
export declare class MemoryRepositories implements Repositories {
    private readonly triggerRows;
    private readonly dispositions;
    private readonly threadRows;
    private readonly ticketRows;
    private readonly decisionRows;
    atomic<T>(work: () => T): T;
    readonly triggers: {
        get: (id: string) => Trigger | undefined;
        save: (trigger: Trigger) => void;
        disposition: (id: string) => TriggerDisposition | undefined;
        saveDisposition: (id: string, value: TriggerDisposition) => void;
    };
    readonly threads: {
        get: (key: string) => Thread | undefined;
        save: (thread: Thread) => void;
        list: () => Thread[];
        active: () => Thread[];
    };
    readonly tickets: {
        get: (id: string) => Ticket | undefined;
        save: (ticket: Ticket) => void;
        /** Newest first, matching the SQLite Store's order. */
        list: () => Ticket[];
        open: () => Ticket[];
        active: () => Ticket[];
    };
    readonly decisions: {
        get: (id: string) => Decision | undefined;
        save: (decision: Decision) => void;
        byThread: (key: string) => Decision[];
    };
}
