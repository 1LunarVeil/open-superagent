/**
 * Implements the Engine's `Executor` port for the ZCode host: workers are subagent runs the orchestrator spawns, so the
 * Executor's job is to queue the orchestrator's work (spawn a worker, hand it waiting inputs) and retract it when the
 * domain ends it. Port discipline: `start`, `deliver`, and `stop` are called inside Engine command transactions, so they
 * only enqueue durable effects or cancel pending actions — never an Engine call, never IO. The launch and delivery
 * handlers registered by `install` run after commit, where reading the Store, creating directories, and calling the
 * Engine back are allowed.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Later } from "../persist/effects.js";
import { PrepareFailed, prepareWorkspace } from "./sandbox.js";
/**
 * The bounded limits of a proactively accepted ticket, with upstream's `mandateInstructions` semantics: work stays a
 * small, cohesive change inside one module within the accepted rule scope; anything beyond it is reported dropped rather
 * than expanded, and a message beyond the ticket is handed back instead of acted on.
 */
const INFERRED_LIMIT = 'Proactive tickets carry limited authorization: the work must stay a small, cohesive change inside'
    + ' one module within the accepted rule scope. If it would need public-interface or behavior changes, new interaction,'
    + ' or product decisions, report dropped rather than expanding scope; if a message that reaches the ticket asks for work'
    + ' beyond it, hand it back instead of acting on it.';
/** Renders one ticket Input for the worker: triggers with author and bounded text, text and notes verbatim. */
function renderInput(ticket, inputId, trigger) {
    const input = ticket.inputs.find(item => item.id === inputId);
    if (!input)
        return { inputId };
    if (input.kind === 'trigger') {
        const source = trigger(input.triggerId);
        return { kind: 'trigger', inputId, triggerId: input.triggerId, at: input.at,
            ...(source ? { actor: source.actor, human: source.human, text: source.text.slice(0, 2000) } : {}) };
    }
    if (input.kind === 'text' || input.kind === 'note')
        return { kind: input.kind, inputId, at: input.at, text: input.text };
    // policy-changed, reopen, and resumed inputs are rare; their details live on the ticket record the worker reads.
    return { kind: input.kind, inputId, at: input.at };
}
/**
 * Builds the prompt the orchestrator gives the worker subagent it spawns for a ticket: a JSON card of the bounded facts
 * (identity, mandate, origin trigger text, waiting inputs) followed by the reporting protocol. Previews are truncated on
 * purpose; the protocol points the worker at the full record reads. The trigger resolver is optional so a caller holding
 * only the ticket can still build a card; the launch handler always passes the Store lookup.
 */
export function buildAssignmentPrompt(ticket, trigger = () => undefined) {
    const mandate = ticket.mandate;
    const origin = trigger(ticket.origin.triggerId);
    const card = {
        ticketId: ticket.id,
        title: ticket.title,
        mandate: { strength: mandate.strength, scope: mandate.scope, basis: mandate.basis, policyVersion: mandate.policyVersion },
        originTriggerId: ticket.origin.triggerId,
        ...(origin ? { originText: origin.text.slice(0, 2000) } : {}),
        undelivered: ticket.undelivered.map(id => renderInput(ticket, id, trigger)),
    };
    const lines = [
        'You are the worker subagent for one open-superagent ticket. Work only inside the working directory given with your'
            + ' task, and only within the mandate below. The ticket card is your assignment:',
        '',
        JSON.stringify(card, null, 2),
    ];
    if (mandate.strength === 'inferred')
        lines.push('', INFERRED_LIMIT);
    lines.push('', 'PROTOCOL', '- The card truncates texts. Before acting on a preview, read the full ticket record and its thread with'
        + ' superagent_worker_read; it also serves the origin trigger and every input in full.', '- Report with superagent_worker_report. The states: progress - work continues (internal, wakes nobody); waiting - you wait'
        + ' for input or a person with nothing left to run; ready - a verified result exists; blocked - a person must act to'
        + ' unblock the work; failed - a person must act to recover it; dropped - nothing is left to do, which closes the'
        + ' ticket without a message.', '- A report with question asks a person one concrete question, and askedBy names the person\'s message that raised it,'
        + ' so the question is asked where that person wrote. answers names the person\'s question this report answers, which'
        + ' takes the message up as within the ticket.', '- Your report ends this assignment: after superagent_worker_report returns, stop and finish your run.');
    return lines.join('\n');
}
/**
 * Builds the prompt for a worker that continues an existing ticket: the ticket id, the working directory, the inputs that
 * just arrived, and the protocol. A continuation worker has no assignment card, so without this it would not even know
 * which ticket to read.
 */
export function buildContinuationPrompt(ticket, directory, inputs) {
    return [
        'You are the worker subagent continuing one open-superagent ticket. Work only inside the working directory below, and'
            + ' only within the mandate the ticket record carries.',
        '',
        JSON.stringify({ ticketId: ticket.id, title: ticket.title, directory, newInputs: inputs }, null, 2),
        '',
        'PROTOCOL',
        '- Read the full ticket record first with superagent_worker_read and the ticketId above; it carries the mandate, every'
            + ' earlier input, and any open question.',
        '- New messages that reached this ticket are listed above. Work what belongs to the ticket; hand back with'
            + ' superagent_worker_handback what does not.',
        '- Report with superagent_worker_report using the same ticketId. Your report ends this round: after it returns, stop.',
    ].join('\n');
}
/**
 * Queues launches and input deliveries as orchestrator actions and reports their outcome back to the Engine.
 * The deps arrive through `install` rather than the constructor because the Engine is built with the executor in hand
 * (two-phase wiring breaks the Engine-executor cycle), so the effect handlers can only register afterwards.
 */
export class ZcodeExecutor {
    deps;
    install(deps) {
        if (this.deps)
            throw new Error('The executor is already installed');
        this.deps = deps;
        deps.effects.handle('launch', async ({ ticketId, assignmentId }) => { await this.launch(ticketId, assignmentId); }, { limit: () => deps.paused() ? 0 : deps.slots(), retry: [5000, 60_000] });
        deps.effects.handle('delivery', async ({ ticketId, assignmentId }) => { this.deliverWaiting(ticketId, assignmentId); }, { limit: () => deps.paused() ? 0 : 4, retry: [5000, 60_000] });
    }
    /** Queues the assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
    start(ticket, assignment) {
        this.requireDeps().effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id });
    }
    /** Queues delivery of the ticket's waiting Inputs; reports back through `Engine.inputsDelivered`. */
    deliver(ticket, assignment) {
        this.requireDeps().effects.enqueue('delivery', ticket.id, { ticketId: ticket.id, assignmentId: assignment.id });
    }
    /**
     * Retracts the ticket's undelivered actions; the Engine calls this after the ticket or assignment has already ended in
     * the domain, and a ZCode host has no live worker session to cancel.
     */
    stop(ticket, assignment, reason) {
        this.requireDeps().actions.cancelForTicket(ticket.id);
    }
    /**
     * Reconciles the domain with what actually reached the orchestrator after a restart. A host has no live worker session to
     * inspect, so the durable action queue is the only evidence: an assignment marked `running` with no undelivered
     * `spawn_worker`/`deliver_inputs` action never reached a worker and must be resumed or restarted by the Engine, and a
     * pending assignment with no queued launch is queued again. Runs once at startup, after effects begin dispatching.
     */
    reconcile() {
        const deps = this.requireDeps();
        for (const ticket of deps.store.tickets.active()) {
            if (ticket.ended)
                continue;
            const latest = ticket.assignments.at(-1);
            if (!latest)
                continue;
            // An assignment with a failed report already told the person; restarting it would repeat a failure the environment
            // has not fixed. Only an explicit retry moves such a ticket on.
            if (latest.report?.state === 'failed' && latest.state === 'pending')
                continue;
            const queued = deps.actions.pending().some(action => action.kind === 'spawn_worker' && action.assignmentId === latest.id);
            if (latest.state === 'running' && !queued) {
                deps.log('Reconciling ticket ' + ticket.id + ': its running assignment has no queued worker');
                deps.engine.assignmentInterrupted(ticket.id, latest.id);
            }
            else if (latest.state === 'pending' && !deps.effects.pending('launch', latest.id) && !queued) {
                deps.log('Reconciling ticket ' + ticket.id + ': queueing its pending launch again');
                deps.effects.enqueue('launch', latest.id, { ticketId: ticket.id, assignmentId: latest.id });
            }
        }
    }
    requireDeps() {
        if (!this.deps)
            throw new Error('The executor is not installed; the runtime wires it before any ticket is created');
        return this.deps;
    }
    /** Prepares the workspace and turns a queued launch into a `spawn_worker` action, all after the Engine committed. */
    async launch(ticketId, assignmentId) {
        const deps = this.requireDeps();
        const ticket = deps.store.tickets.get(ticketId);
        const assignment = ticket?.assignments.find(item => item.id === assignmentId);
        // The ticket or the assignment ended while the launch waited: the Engine has spoken, and a retry cannot revive it.
        if (!ticket || !assignment || ticket.ended || assignment.state === 'ended')
            return;
        // Concurrency gate over the Engine's own working set, so a restart re-derives it instead of keeping local counters.
        const busy = deps.store.tickets.active().filter(item => !item.ended && item.assignments.some(running => running.state === 'running')).length;
        if (assignment.state !== 'running' && busy >= deps.slots())
            throw new Later('All worker slots are busy');
        const directory = ticket.execution?.directory ?? join(deps.workRoot(), ticketId.slice(0, 12));
        // Preparation is a fact recorded on the ticket, not an inference from assignment state: a retried ticket whose first
        // preparation failed must be able to prepare again once the person fixed the environment.
        if (!ticket.execution?.preparedAt) {
            try {
                mkdirSync(deps.workRoot(), { recursive: true });
                const notes = await prepareWorkspace({
                    directory,
                    workRoot: deps.workRoot(),
                    worktree: deps.worktree(),
                    projectDir: deps.projectDir(),
                    ref: deps.baseRef(),
                    timeoutMs: deps.prepareTimeoutMs(),
                });
                for (const note of notes)
                    deps.log('Ticket ' + ticketId + ': ' + note);
                deps.engine.workspacePrepared(ticketId, new Date().toISOString());
            }
            catch (error) {
                // A workspace that cannot be prepared is not retried automatically: the person must fix the environment and retry.
                const message = error instanceof PrepareFailed ? error.message : String(error);
                deps.log('Ticket ' + ticketId + ': workspace preparation failed: ' + message);
                deps.engine.report(ticketId, { state: 'failed', summary: 'Workspace preparation failed: ' + message.slice(0, 600) });
                // A launch failure is otherwise invisible to the orchestrator, which would only see a ticket that never progresses.
                deps.store.atomic(() => deps.actions.add({
                    kind: 'relay', ticketId, text: 'Worker launch failed for ' + ticketId + ': ' + message.slice(0, 300),
                }, new Date().toISOString()));
                return;
            }
        }
        // Re-read after the await: a stop or thread close during a slow worktree creation ends the assignment, and queueing a
        // spawn for it would tell the orchestrator to start work that no longer exists.
        const current = deps.store.tickets.get(ticketId);
        const live = current?.assignments.find(item => item.id === assignmentId);
        if (!current || current.ended || !live || live.state === 'ended') {
            deps.actions.cancelForTicket(ticketId);
            return;
        }
        if (live.state === 'running')
            return; // a delivery or an earlier attempt already told the Engine this runs
        const prompt = buildAssignmentPrompt(current, id => deps.store.triggers.get(id));
        deps.store.atomic(() => {
            deps.actions.add({ kind: 'spawn_worker', ticketId, assignmentId, title: current.execution?.name ?? current.title, prompt, directory }, new Date().toISOString());
            deps.engine.assignmentStarted(ticketId, assignmentId);
        });
    }
    /** Queues the ticket's waiting Inputs as a `deliver_inputs` action and records them delivered and read, in one transaction. */
    deliverWaiting(ticketId, assignmentId) {
        const deps = this.requireDeps();
        const ticket = deps.store.tickets.get(ticketId);
        const assignment = ticket?.assignments.find(item => item.id === assignmentId);
        if (!ticket || !assignment || assignment.state !== 'running')
            return;
        if (!ticket.undelivered.length)
            return;
        const inputIds = [...ticket.undelivered];
        const rendered = inputIds.map(id => renderInput(ticket, id, id2 => deps.store.triggers.get(id2)));
        const directory = ticket.execution?.directory ?? join(deps.workRoot(), ticketId.slice(0, 12));
        // The action carries the ticket id and directory as well as the inputs: a one-shot continuation worker has no
        // assignment card, so the prompt must be able to name the ticket it continues and where it works.
        const text = buildContinuationPrompt(ticket, directory, rendered);
        deps.store.atomic(() => {
            deps.actions.add({ kind: 'deliver_inputs', ticketId, assignmentId, inputIds, text, directory }, new Date().toISOString());
            deps.engine.inputsDelivered(ticketId, assignmentId, inputIds);
            // R2 port decision: deliver implies read. Upstream records `readAt` when the worker's Session takes a message into
            // a step; a ZCode subagent has no step events to reconcile against, and the action queue is the delivery channel,
            // so the Engine's read bookkeeping is brought in line with delivery here.
            deps.engine.inputsRead(ticketId, inputIds);
        });
    }
}
