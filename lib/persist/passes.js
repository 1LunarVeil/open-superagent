const now = () => new Date().toISOString();
/**
 * Schedules and serializes orchestration passes that kick due `Effects` and advance `Engine` evaluations.
 * The daemon manages its lifecycle, while sources, tools, `Settings`, and tools trigger immediate passes when new work arrives or state changes.
 * Updates the runtime `HealthEntry` when a pass fails and clears the error once a subsequent pass succeeds.
 */
export class Passes {
    host;
    timer;
    stopped = false;
    pumping;
    pumpAgain;
    constructor(host) {
        this.host = host;
    }
    /** Starts the periodic pump and runs one pass at once, so a fresh daemon reports `ready` instead of `starting`. */
    start() {
        if (this.stopped)
            return;
        this.timer = setInterval(() => { this.request(); }, 2000);
        this.request();
    }
    stop() {
        this.stopped = true;
        clearInterval(this.timer);
        return Promise.allSettled([this.pumping, this.pumpAgain]);
    }
    receive(trigger) {
        if (this.host.closing())
            throw new Error('open-superagent is stopping');
        const result = this.host.engine.receive(trigger);
        if (result === 'stored')
            this.request();
        return result;
    }
    /**
     * Runs a pass and reports the runtime's health: the first successful pass turns `starting` into `ready`, and every later
     * failure turns it into `error` until a pass succeeds again.
     */
    request() {
        const { health } = this.host;
        this.pump().then(() => {
            if (this.host.lifetime.aborted)
                return;
            const current = health.get();
            if (current?.state === 'ready')
                return;
            health.set({ state: 'ready', detail: 'open-superagent is ready', at: now() });
        }, (error) => { health.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() }); });
    }
    /** Wait until no pass or effect that can start now is running. */
    async idle() {
        for (;;) {
            await Promise.allSettled([this.pumping, this.pumpAgain]);
            await this.host.effects.idle();
            if (!this.pumping && !this.pumpAgain)
                return;
        }
    }
    /** Run one pass, coalescing concurrent callers into a single follow-up pass. */
    async pump() {
        // Do not assess, dispatch, or send while waiting for setup; queued work waits for the restart that completes setup.
        if (!this.host.configured() || this.host.closing())
            return;
        if (!this.pumping)
            return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined; });
        const next = () => { this.pumpAgain = undefined; return this.pump(); };
        return this.pumpAgain ??= this.pumping.then(next, next);
    }
    async pumpOnce() {
        this.host.effects.kick();
        if (this.host.closing())
            return;
        // While processing is paused, the Engine only records the pause on active Evals so they do not expire.
        this.host.engine.evaluateDue();
    }
}
