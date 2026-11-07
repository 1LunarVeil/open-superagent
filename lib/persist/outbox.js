import { FAILURES_BEFORE_ERROR, Later } from "./effects.js";
/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and the Source senders.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 * Port note: the upstream Feishu IM length check moves to the Feishu sender in its phase; this file is sender-agnostic.
 */
export class Outbox {
    host;
    constructor(host) {
        this.host = host;
        host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] });
    }
    /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
    send(message) {
        const { store, effects } = this.host;
        store.atomic(() => { if (store.receipts.add(message))
            effects.enqueue('reply', message.id, {}); });
    }
    status(id) { return this.host.store.receipts.get(id)?.status; }
    withdraw(id) {
        const { store, effects } = this.host;
        store.atomic(() => { if (store.receipts.withdraw(id))
            effects.cancel('reply', id); });
    }
    sent() { return this.host.effects.idle('reply'); }
    async deliver(id) {
        const { store, sources } = this.host;
        const receipt = store.receipts.get(id);
        if (receipt?.status !== 'pending')
            return;
        if (!sources.instance(receipt.channel.source)?.enabled)
            throw new Later('The Source is off or not installed');
        // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
        if (store.receipts.behind(id, FAILURES_BEFORE_ERROR))
            throw new Later('An earlier message of this ticket to this conversation waits');
        if (!sources.channelAllowed(receipt.channel)) {
            store.receipts.settle(receipt, 'channelIgnored');
            return;
        }
        // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
        const result = await sources.send(receipt);
        if (result === 'waiting')
            throw new Later('The Source is not installed');
        store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent');
    }
}
