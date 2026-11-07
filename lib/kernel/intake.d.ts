import type { Trigger } from './model.ts';
import { EnginePart, type EngineOptions } from './part.ts';
import type { Tickets } from './tickets.ts';
export type ReceiveResult = 'stored' | 'duplicate' | 'filtered';
/**
 * Ingests incoming triggers from Sources, deduplicating and filtering them against SourceScope before recording thread correlations.
 * Fans listened triggers out to subscribed tickets via Tickets and queues for Eval, on its primary thread, every trigger no
 * ticket's worker decides (see `followupOwners`).
 * Engine delegates trigger reception to this part.
 */
export declare class Intake extends EnginePart {
    private readonly tickets;
    constructor(options: EngineOptions, tickets: Tickets);
    receive(received: Trigger): ReceiveResult;
}
