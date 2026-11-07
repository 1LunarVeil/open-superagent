/** Reliable outbound message delivery backed by persistent receipts and retried reply effects. */
import type { ChannelRef, OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../kernel/index.ts';
import { type Effects } from './effects.ts';
import type { Store } from './store.ts';
/**
 * What Outbox needs from the Source layer, narrowed from the upstream `SourceRegistry` so the port does not
 * depend on the full registry: whether a Source instance is on, whether it still receives a channel, and its sender.
 */
export interface ReplySenders {
    instance(source: string): {
        enabled: boolean;
    } | undefined;
    channelAllowed(channel: ChannelRef): boolean;
    send(receipt: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'>;
}
export interface OutboxHost {
    readonly store: Pick<Store, 'atomic' | 'receipts'>;
    readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>;
    readonly sources: ReplySenders;
    paused(): boolean;
}
/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and the Source senders.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * Messages wait while processing is paused or their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 * Port note: the upstream Feishu IM length check moves to the Feishu sender in its phase; this file is sender-agnostic.
 */
export declare class Outbox implements OutboxPort {
    private readonly host;
    constructor(host: OutboxHost);
    /** Record a message receipt and enqueue its delivery effect atomically; duplicate message IDs are ignored. */
    send(message: OutboundMessage): void;
    status(id: string): ReplyStatus | undefined;
    withdraw(id: string): void;
    sent(): Promise<void>;
    private deliver;
}
