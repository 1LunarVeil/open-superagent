/** Coordinates periodic and on-demand orchestration passes that drive due effects and Engine evaluations. */
import type { Engine, ReceiveResult, Trigger } from '../kernel/index.ts';
import type { HealthEntry } from './health.ts';
import type { Effects } from './effects.ts';
export interface PassesHost {
    readonly engine: Pick<Engine, 'receive' | 'evaluateDue'>;
    readonly effects: Pick<Effects, 'kick' | 'idle'>;
    readonly health: HealthEntry;
    readonly lifetime: AbortSignal;
    configured(): boolean;
    closing(): boolean;
}
/**
 * Schedules and serializes orchestration passes that kick due `Effects` and advance `Engine` evaluations.
 * The daemon manages its lifecycle, while sources, tools, `Settings`, and tools trigger immediate passes when new work arrives or state changes.
 * Updates the runtime `HealthEntry` when a pass fails and clears the error once a subsequent pass succeeds.
 */
export declare class Passes {
    private readonly host;
    private timer?;
    private stopped;
    private pumping?;
    private pumpAgain?;
    constructor(host: PassesHost);
    /** Starts the periodic pump and runs one pass at once, so a fresh daemon reports `ready` instead of `starting`. */
    start(): void;
    stop(): Promise<unknown>;
    receive(trigger: Trigger): ReceiveResult;
    /**
     * Runs a pass and reports the runtime's health: the first successful pass turns `starting` into `ready`, and every later
     * failure turns it into `error` until a pass succeeds again.
     */
    request(): void;
    /** Wait until no pass or effect that can start now is running. */
    idle(): Promise<void>;
    /** Run one pass, coalescing concurrent callers into a single follow-up pass. */
    pump(): Promise<void>;
    private pumpOnce;
}
