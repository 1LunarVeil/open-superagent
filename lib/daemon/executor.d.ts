import type { Effects } from '../persist/effects.ts';
import type { Assignment, EngineForExecutor, Executor, Ticket, Trigger } from '../kernel/index.ts';
import type { Store } from '../persist/store.ts';
import type { Actions } from './actions.ts';
/** Host dependencies the executor needs, narrowed to what it uses. */
export interface ExecutorDeps {
    readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'pending'>;
    readonly actions: Actions;
    readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'assignmentClaimed' | 'workspacePrepared' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'report' | 'assignmentInterrupted'>;
    readonly store: Store;
    /** How many tickets may have a running worker at once; a launch beyond it waits (`Later`). */
    slots(): number;
    /** Whether processing is paused, which holds launches and input deliveries. */
    paused(): boolean;
    /** Root of the per-ticket working directories, such as `<stateDir>/work`. */
    workRoot(): string;
    /** The project repository tickets are cut from, or undefined when the host supplied none. */
    projectDir(): string | undefined;
    /** Whether a ticket directory becomes a detached git worktree. */
    worktree(): boolean;
    /** How long workspace preparation may run, in milliseconds. */
    prepareTimeoutMs(): number;
    /** The base ref a worktree starts from. */
    baseRef(): string;
    /** Receives a one-line diagnostic, such as a workspace note or a recovery decision. */
    log(message: string): void;
}
/**
 * Builds the prompt the orchestrator gives the worker subagent it spawns for a ticket: a JSON card of the bounded facts
 * (identity, mandate, origin trigger text, waiting inputs) followed by the reporting protocol. Previews are truncated on
 * purpose; the protocol points the worker at the full record reads. The trigger resolver is optional so a caller holding
 * only the ticket can still build a card; the launch handler always passes the Store lookup.
 */
export declare function buildAssignmentPrompt(ticket: Ticket, trigger?: (triggerId: string) => Trigger | undefined): string;
/**
 * Builds the prompt for a worker that continues an existing ticket: the ticket id, the working directory, the inputs that
 * just arrived, and the protocol. A continuation worker has no assignment card, so without this it would not even know
 * which ticket to read.
 */
export declare function buildContinuationPrompt(ticket: Ticket, directory: string, inputs: Record<string, unknown>[]): string;
/**
 * Queues launches and input deliveries as orchestrator actions and reports their outcome back to the Engine.
 * The deps arrive through `install` rather than the constructor because the Engine is built with the executor in hand
 * (two-phase wiring breaks the Engine-executor cycle), so the effect handlers can only register afterwards.
 */
export declare class ZcodeExecutor implements Executor {
    private deps?;
    install(deps: ExecutorDeps): void;
    /** Queues the assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
    start(ticket: Ticket, assignment: Assignment): void;
    /** Queues delivery of the ticket's waiting Inputs; reports back through `Engine.inputsDelivered`. */
    deliver(ticket: Ticket, assignment: Assignment): void;
    /**
     * Retracts the ticket's undelivered actions and releases its workspace. The Engine calls this after the ticket or
     * assignment has already ended in the domain, and a ZCode host has no live worker session to cancel.
     *
     * `releaseWorkspace` only removes a worktree with no changes in it; one holding the worker's edits is left in place, which
     * is what makes the change reviewable after the ticket ends. It runs outside the Engine transaction for the same reason
     * the launch handlers do, and its failure never affects the domain.
     */
    stop(ticket: Ticket, assignment: Assignment, reason: string): void;
    /**
     * Reconciles the domain with what actually reached the orchestrator after a restart. A host has no live worker session to
     * inspect, so the durable action queue is the only evidence: an assignment marked `running` with no undelivered
     * `spawn_worker`/`deliver_inputs` action never reached a worker and must be resumed or restarted by the Engine, and a
     * pending assignment with no queued launch is queued again. Runs once at startup, after effects begin dispatching.
     */
    reconcile(): void;
    private requireDeps;
    /** Prepares the workspace and turns a queued launch into a `spawn_worker` action, all after the Engine committed. */
    private launch;
    /** Queues the ticket's waiting Inputs as a `deliver_inputs` action and records them delivered and read, in one transaction. */
    private deliverWaiting;
}
