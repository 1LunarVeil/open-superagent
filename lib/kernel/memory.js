/** In-memory repository implementation for testing and ephemeral engine instances. */
import { latestAssignment } from "./model.js";
const clone = (value) => structuredClone(value);
/**
 * In-memory implementation of the Repositories port backed by cloned Map entries so caller mutations do not affect stored state.
 * Provides snapshot-based atomic rollback and matches the ordering semantics of the SQLite store for Engine tests.
 */
export class MemoryRepositories {
    triggerRows = new Map();
    dispositions = new Map();
    threadRows = new Map();
    ticketRows = new Map();
    decisionRows = new Map();
    atomic(work) {
        const maps = [this.triggerRows, this.dispositions, this.threadRows, this.ticketRows, this.decisionRows];
        const snapshot = maps.map(map => new Map(map));
        try {
            return work();
        }
        catch (error) {
            maps.forEach((map, index) => { map.clear(); for (const [id, value] of snapshot[index])
                map.set(id, value); });
            throw error;
        }
    }
    triggers = {
        get: (id) => clone(this.triggerRows.get(id)),
        save: (trigger) => { this.triggerRows.set(trigger.id, clone(trigger)); },
        disposition: (id) => clone(this.dispositions.get(id)),
        saveDisposition: (id, value) => { this.dispositions.set(id, clone(value)); },
    };
    threads = {
        get: (key) => clone(this.threadRows.get(key)),
        save: (thread) => { this.threadRows.set(thread.key, clone(thread)); },
        list: () => [...this.threadRows.values()].map(clone),
        active: () => this.threads.list().filter(thread => thread.pending.length > 0 || thread.evaluating !== undefined),
    };
    tickets = {
        get: (id) => clone(this.ticketRows.get(id)),
        save: (ticket) => { this.ticketRows.set(ticket.id, clone(ticket)); },
        /** Newest first, matching the SQLite Store's order. */
        list: () => [...this.ticketRows.values()].reverse().map(clone),
        open: () => this.tickets.list().filter(ticket => !ticket.ended),
        active: () => this.tickets.list().filter(ticket => ticket.undelivered.length > 0 || ['pending', 'running'].includes(latestAssignment(ticket)?.state ?? '')),
    };
    decisions = {
        get: (id) => clone(this.decisionRows.get(id)),
        save: (decision) => { this.decisionRows.set(decision.id, clone(decision)); },
        byThread: (key) => [...this.decisionRows.values()].filter(decision => decision.threadKey === key).map(clone),
    };
}
