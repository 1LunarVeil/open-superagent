/**
 * The MCP tools of the open-superagent daemon, in four batches: the orchestrator's status, tick (the pending-action
 * handout and its acknowledgement), settings, trigger injection, and health; the orchestrator's assessment, routing, and
 * full-record reads (eval_read, eval_decide, route, read, reply, ticket_note); the operator's ticket controls
 * (ticket_retry, ticket_stop, ticket_status, thread_unsubscribe, decision_dismiss, trigger_requeue); and the worker
 * protocol its subagents run tickets through (worker_read, worker_ack, worker_report, worker_handback,
 * worker_thread_unrelated, worker_thread_follow). Port note: these replace upstream's main-Session tools
 * (`orchestrator_*`), which its Session host registered in-process; a ZCode main session reaches the daemon over MCP
 * instead, and the assessment/report protocols live in the open-superagent skill the session follows, not in these handlers.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { UserError, canRetry, key, latestAssignment, latestReport, ticketStage, threadKey } from "../kernel/index.js";
import { assessmentOutcome } from "../kernel/policy.js";
import { candidateCard, stageLabel } from "./actions.js";
/** Settings blocks a tool caller may save against; v1 has exactly the manual Source. */
const SETTINGS_BLOCKS = ['policy', 'eval', 'executor', 'source:manual', 'pause'];
/**
 * The body of `superagent_eval_decide`, aligned field for field with the upstream assessment interface: the orchestrator
 * judges every enabled rule exactly once, states the three direction facts, and for an accept adds the intent evidence,
 * the acknowledgement, and the short directory name. Only an accept needs the ticket fields; an ignore or an unavailable
 * decision carries its reason and nothing else.
 */
const EvalDecideSchema = z.strictObject({
    triggerId: z.string().min(1).describe('The trigger to decide, by its id from the candidate card.'),
    decision: z.enum(['accept', 'ignore', 'unavailable']),
    rule_assessments: z.array(z.strictObject({ rule_id: z.string(), reason: z.string(), matched: z.boolean() }))
        .describe('Exactly one entry for every enabled rule, none repeated or unknown; negative judgments are matched=false with a factual reason.'),
    direction: z.strictObject({
        implementation_requested: z.boolean(),
        target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
        requires_design_decision: z.boolean(),
        evidence: z.string().describe('The source statements that establish the direction facts; do not invent evidence to make the booleans pass.'),
    }),
    reason: z.string().min(1).describe('Why, recorded on the decision.'),
    title: z.string().optional().describe('For an accept, the ticket title.'),
    scope: z.string().optional().describe('For an accept, the mandate scope, such as small.'),
    intent_evidence: z.string().nullable().optional().describe('For an accept, the three admission facts with their source quotes.'),
    acknowledgement: z.string().nullable().optional().describe('For an accept, one short sentence naming the change and intended result, in the source language.'),
    worktree_name: z.string().optional().describe('For an accept, a short English directory name independent of the title.'),
});
/** One routing decision of `superagent_route`; the fields beyond trigger and kind depend on the kind. */
const RouteItemSchema = z.object({
    triggerId: z.string().min(1).describe('The trigger to route, by its real id from the card, never a rewrite or a worker summary.'),
    kind: z.enum(['accept', 'attach', 'ignore', 'stop']),
    ticketId: z.string().optional().describe('For attach, the ticket the message explicitly points at; for stop, the ticket whose work ends.'),
    note: z.string().optional().describe('Routing note of at most 30 words: routing background or explicit human constraints, never implementation instructions.'),
    title: z.string().optional().describe('For accept, the new ticket title.'),
    scope: z.string().optional().describe('For accept, the mandate scope, such as small.'),
    reason: z.string().optional().describe('The recorded reason of the decision.'),
    acknowledgement: z.string().optional().describe('For accept, one short sentence naming the change and intended result, in the source language.'),
});
/**
 * Runs a tool body into a text result: a `UserError` (an expected refusal or missing record the model should see) becomes
 * an error result, and anything else keeps throwing so the MCP layer reports a daemon fault.
 */
async function textResult(run) {
    try {
        return { content: [{ type: 'text', text: await run() }] };
    }
    catch (error) {
        if (error instanceof UserError)
            return { isError: true, content: [{ type: 'text', text: error.message }] };
        throw error;
    }
}
/** Compact summary of one ticket for lists. */
function ticketSummary(ticket) {
    const report = latestReport(ticket);
    return {
        id: ticket.id,
        title: ticket.title,
        stage: stageLabel(ticketStage(ticket)),
        ...(ticket.attention ? { attention: ticket.attention.question } : {}),
        ...(report ? { latestReport: report } : {}),
        assignmentState: latestAssignment(ticket)?.state,
    };
}
/** The status overview: settings that shape the run, every open ticket, thread counts, and the health board. */
function status(runtime) {
    const settings = runtime.settings.get();
    return {
        paused: settings.paused,
        mode: settings.eval.mode,
        maxWorkers: settings.executor.maxWorkers,
        tickets: runtime.store.tickets.open().map(ticketSummary),
        threads: { count: runtime.store.threads.list().length, active: runtime.store.threads.active().length },
        health: runtime.healthSnapshot(),
    };
}
/**
 * The full record of a ticket: every field of the aggregate, the keys of the threads it belongs to or follows, and each
 * input with its trigger in full text, so a reader never acts on a truncated preview.
 */
function ticketView(ticket, trigger) {
    const threads = new Set();
    for (const follow of ticket.follows ?? [])
        threads.add(follow.thread);
    const originIds = [ticket.origin.triggerId, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])];
    for (const triggerId of originIds) {
        for (const ref of trigger(triggerId)?.threads ?? [])
            threads.add(threadKey(ref));
    }
    return {
        ...ticket,
        threads: [...threads],
        inputs: ticket.inputs.map(input => input.kind === 'trigger' ? { ...input, trigger: trigger(input.triggerId) } : input),
    };
}
/** Reads one `superagent_read` resource; the uri grammar is `kind/<id>` for records and a bare kind for lists. */
function readResource(runtime, resource) {
    if (resource === 'tickets')
        return { tickets: runtime.store.tickets.open().map(ticketSummary) };
    if (resource === 'threads')
        return { threads: runtime.store.threads.active() };
    if (resource === 'decisions')
        return { decisions: runtime.store.read.recentDecisions(0, 30) };
    const separator = resource.indexOf('/');
    const kind = separator > 0 ? resource.slice(0, separator) : '';
    const id = separator > 0 ? resource.slice(separator + 1) : '';
    if (kind === 'trigger') {
        const trigger = runtime.store.triggers.get(id);
        if (!trigger)
            throw new UserError('unknownTrigger');
        return { trigger, disposition: runtime.store.triggers.disposition(id) };
    }
    if (kind === 'thread') {
        const thread = runtime.store.threads.get(id);
        if (!thread)
            throw new UserError('unknownThread', { thread: id });
        return { thread, triggers: runtime.store.read.threadTriggers(id, 50) };
    }
    if (kind === 'ticket') {
        const ticket = runtime.store.tickets.get(id);
        if (!ticket)
            throw new UserError('unknownTicket');
        return ticketView(ticket, triggerId => runtime.store.triggers.get(triggerId));
    }
    throw new UserError('unknownResource', { resource });
}
/**
 * Routes one `superagent_route` item on its own: a failure (an expected refusal or a missing record) reports per item and
 * never fails the batch, which is what upstream's routing loop did for each of its decisions.
 */
function routeOne(runtime, item) {
    try {
        if (item.kind === 'accept') {
            const decision = runtime.engine.decide(item.triggerId, {
                kind: 'accept',
                title: item.title ?? 'Ticket',
                scope: item.scope ?? 'small',
                reason: item.reason ?? 'routed by hand',
                ...(item.acknowledgement ? { acknowledgement: item.acknowledgement } : {}),
                ...(item.note ? { note: item.note } : {}),
            });
            return { triggerId: item.triggerId, ok: true, decisionId: decision.id, ...(decision.ticketId ? { ticketId: decision.ticketId } : {}) };
        }
        if (item.kind === 'attach') {
            if (!item.ticketId)
                return { triggerId: item.triggerId, ok: false, error: 'kind attach requires ticketId' };
            const ticket = runtime.engine.attach(item.ticketId, item.triggerId, item.note);
            return { triggerId: item.triggerId, ok: true, ticketId: ticket.id };
        }
        if (item.kind === 'ignore') {
            const decision = runtime.engine.decide(item.triggerId, { kind: 'ignore', reason: item.reason ?? 'routed by hand' });
            return { triggerId: item.triggerId, ok: true, decisionId: decision.id };
        }
        if (!item.ticketId)
            return { triggerId: item.triggerId, ok: false, error: 'kind stop requires ticketId' };
        const decision = runtime.engine.decide(item.triggerId, { kind: 'stop', ticketId: item.ticketId, reason: item.reason ?? 'stop requested' });
        return { triggerId: item.triggerId, ok: true, decisionId: decision.id, ...(decision.ticketId ? { ticketId: decision.ticketId } : {}) };
    }
    catch (error) {
        return { triggerId: item.triggerId, ok: false, error: error instanceof UserError ? error.message : String(error) };
    }
}
/** Registers the daemon's tools on the server; called once after the runtime is initialized. */
export function registerTools(server, runtime) {
    // Batch 1: the daemon's own surfaces — status, tick, settings, manual triggers, health.
    server.registerTool('superagent_status', {
        title: 'open-superagent status',
        description: 'Overview of the open tickets and the daemon\'s health, including each effect queue. Call before'
            + ' assessing or routing to see what work exists and what the system is doing.',
    }, () => textResult(() => JSON.stringify(status(runtime), null, 2)));
    server.registerTool('superagent_tick', {
        title: 'open-superagent tick',
        description: 'Take the orchestrator\'s pending actions: candidate cards to assess, workers to spawn, inputs to'
            + ' deliver, and reply receipts. Call at session start and whenever idle. The actions stay leased to you for ten'
            + ' minutes and are handed out again if you never finish them, so call superagent_tick_ack with the actionIds you'
            + ' completed before ending your turn. The open-superagent skill defines the protocols each action follows.',
    }, () => textResult(async () => {
        // Give the effect queue a chance to write its actions before handing them out. Only the leading process dispatches;
        // a follower has no passes of its own, so it waits for the leader indirectly by re-reading the database.
        if (runtime.isLeader)
            await runtime.passes.idle();
        runtime.actions.prune();
        // A candidate card whose Eval was decided or expired meanwhile is no longer actionable: handing it out would make the
        // orchestrator retry a finished assessment forever (eval_read raises noCandidate and the row is re-leased each cycle).
        runtime.actions.dropStaleAssessments(triggerId => runtime.engine.candidate(triggerId) !== undefined);
        const actions = runtime.actions.take();
        if (!actions.length) {
            // A lease still held by this same session is not "no work": say when it returns, so the orchestrator does not end
            // its turn believing the queue is empty while handed-out work waits out its lease.
            const leased = runtime.actions.leased();
            if (leased.count)
                return 'No new actions. ' + String(leased.count) + ' action(s) are still leased to this session'
                    + (leased.until ? ', returning after ' + leased.until : '') + ' if you do not finish them.';
            return 'No pending actions.';
        }
        return 'Pending actions for the orchestrator. Act on each in order, then call superagent_tick_ack with the actionIds'
            + ' you completed; the open-superagent skill defines the protocols.\n'
            + JSON.stringify({ actions, note: 'A retry:true action was handed out before and its lease lapsed: verify the domain before repeating a non-idempotent step.' }, null, 2);
    }));
    server.registerTool('superagent_tick_ack', {
        title: 'open-superagent tick ack',
        description: 'Retire the tick actions you finished, by actionId, so they are never handed out again. Call it after the'
            + ' protocols of one tick are complete; an action you drop without acting stays leased until its lease lapses and'
            + ' comes back marked retry.',
        inputSchema: {
            actionIds: z.array(z.string().min(1)).min(1).describe('The actionId values of the actions this turn completed.'),
        },
    }, args => textResult(() => JSON.stringify({ retired: runtime.actions.ack(args.actionIds) }, null, 2)));
    server.registerTool('superagent_settings_get', {
        title: 'open-superagent settings get',
        description: 'Read the current settings and each block\'s revision counter (for optimistic saves).',
    }, () => textResult(() => {
        const revisions = {};
        for (const block of SETTINGS_BLOCKS)
            revisions[block] = runtime.settings.revision(block);
        return JSON.stringify({ settings: runtime.settings.get(), revisions }, null, 2);
    }));
    server.registerTool('superagent_settings_save', {
        title: 'open-superagent settings save',
        description: 'Save one settings block (policy, eval, executor, source:manual, or pause) as the next revision, and'
            + ' tell the Engine how the change bears on open tickets. Block values merge over the current block, so a policy'
            + ' save that sets sources keeps the configured rules. Pass the revision you read from superagent_settings_get to'
            + ' refuse a save someone else made first.',
        inputSchema: {
            block: z.string(),
            value: z.unknown(),
            revision: z.number().int().nonnegative().optional()
                .describe('The block revision the caller read; a mismatch is refused instead of overwriting a concurrent save.'),
        },
    }, args => textResult(() => {
        const block = SETTINGS_BLOCKS.find(item => item === args.block);
        if (!block)
            throw new UserError('unknownBlock', { block: args.block });
        const saved = runtime.settings.save(block, args.value, 'tool', args.revision);
        return JSON.stringify({ revision: saved.revision, policyVersion: saved.policyVersion, policyChanged: saved.policyChanged }, null, 2);
    }));
    server.registerTool('superagent_trigger_inject', {
        title: 'open-superagent trigger inject',
        description: 'Inject one manual trigger (the manual Source): an actor said text in a conversation. This is the'
            + ' general entry for tests and for integrations without a webhook. Injecting the same text again for the same'
            + ' actor and thread is idempotent. Returns the intake result and the trigger id.',
        inputSchema: {
            threadId: z.string().min(1).describe('Conversation key the trigger belongs to; it also becomes the receiving scope row.'),
            actorId: z.string().min(1).describe('The sender\'s id on the manual Source.'),
            text: z.string().min(1).describe('The message text.'),
            human: z.boolean().default(true).describe('Whether a person wrote it; a bot message is an inferred candidate at most.'),
            addressed: z.enum(['mention', 'direct']).optional().describe('That the sender addressed the agent, which strengthens explicit requests.'),
        },
    }, args => textResult(() => {
        const trigger = {
            id: key('manual', args.threadId, args.actorId, args.text),
            source: 'manual',
            threads: [{ source: 'manual', id: args.threadId }],
            actor: { source: 'manual', id: args.actorId },
            human: args.human,
            ...(args.addressed ? { addressed: args.addressed } : {}),
            at: new Date().toISOString(),
            text: args.text,
            channel: { source: 'manual', thread: args.threadId, address: { threadId: args.threadId } },
            meta: { threadId: args.threadId },
        };
        const result = runtime.passes.receive(trigger);
        return JSON.stringify({ result, triggerId: trigger.id }, null, 2);
    }));
    server.registerTool('superagent_health', {
        title: 'open-superagent health',
        description: 'The daemon\'s health entries: the runtime and one entry per effect kind, each with its state and detail.',
    }, () => textResult(() => JSON.stringify(runtime.healthSnapshot(), null, 2)));
    // Batch 2: the orchestrator's assessment, routing, and full-record reads.
    server.registerTool('superagent_eval_read', {
        title: 'open-superagent eval read',
        description: 'Read the complete assessment material of one in-flight proactive candidate: its card, every batch'
            + ' trigger in full text, the thread window around it, and the tickets already on the thread. Assessment is'
            + ' read-only: this records nothing; record the judgement with superagent_eval_decide.',
        inputSchema: { triggerId: z.string().min(1).describe('A trigger the candidate card named; any trigger of its batch works.') },
    }, args => textResult(() => {
        const candidate = runtime.engine.candidate(args.triggerId);
        if (!candidate)
            throw new UserError('noCandidate', { trigger: args.triggerId });
        const batch = new Set(candidate.triggers.map(item => item.id));
        const window = runtime.store.read.threadTriggers(candidate.thread.key, 30);
        const context = window.filter(item => !batch.has(item.id)).slice(-10);
        return JSON.stringify({
            card: candidateCard(candidate, context),
            triggers: candidate.triggers,
            threadWindow: window,
            tickets: candidate.tickets.map(ticket => ({ ...ticket, stage: stageLabel(ticketStage(ticket)), latestReport: latestReport(ticket) })),
        }, null, 2);
    }));
    server.registerTool('superagent_eval_decide', {
        title: 'open-superagent eval decide',
        description: 'Record the assessment decision for one trigger of an in-flight candidate. Assess every enabled rule'
            + ' exactly once (rule_assessments covers them all); an accept requires a settled direction (implementation'
            + ' requested, a specified target or an existing standard, no open design decision), intent_evidence, and at least'
            + ' one matched rule. Observe mode records what would be accepted without creating a ticket.',
        inputSchema: EvalDecideSchema,
    }, (args) => textResult(() => {
        // Only an accept needs the ticket fields; an ignore records its reason alone.
        if (args.decision === 'accept' && (!args.title?.trim() || !args.scope?.trim()))
            throw new UserError('assessmentInvalid', { reason: 'An accept requires title and scope' });
        // The strength rides with the candidate; a candidate that is already gone (decided, expired) still allows routing
        // the trigger by hand, which the Engine judges from the gate alone.
        const candidate = runtime.engine.candidate(args.triggerId);
        const assessment = {
            decision: args.decision,
            rule_assessments: args.rule_assessments,
            direction: args.direction,
            title: args.title?.trim() ?? '',
            scope: args.scope?.trim() ?? '',
            reason: args.reason,
            ...(args.intent_evidence !== undefined ? { intent_evidence: args.intent_evidence } : {}),
            ...(args.acknowledgement !== undefined ? { acknowledgement: args.acknowledgement } : {}),
            ...(args.worktree_name !== undefined ? { worktree_name: args.worktree_name } : {}),
        };
        let outcome;
        try {
            outcome = assessmentOutcome(assessment, runtime.settings.get(), candidate?.strength ?? 'explicit');
        }
        catch (error) {
            throw new UserError('assessmentInvalid', { reason: error instanceof Error ? error.message : String(error) });
        }
        const decision = runtime.engine.decide(args.triggerId, { ...outcome, ...(candidate ? { evalId: candidate.evalId } : {}) });
        return JSON.stringify({ decision, ...(decision.ticketId ? { ticketId: decision.ticketId } : {}) }, null, 2);
    }));
    server.registerTool('superagent_route', {
        title: 'open-superagent route',
        description: 'Route explicit requests in one batch, one item per candidate: kind accept starts a new ticket, attach'
            + ' points the message at the ticket it explicitly names, ignore records ordinary discussion, and stop ends a'
            + ' ticket\'s work on an explicit human instruction. Items succeed or fail independently; routing never rewrites'
            + ' the request or adds requirements.',
        inputSchema: { decisions: z.array(RouteItemSchema).max(20).describe('One item per candidate; at most 20 per call.') },
    }, args => textResult(() => JSON.stringify(args.decisions.map(item => routeOne(runtime, item)), null, 2)));
    server.registerTool('superagent_read', {
        title: 'open-superagent read',
        description: 'Read one resource in full text: trigger/<id> (the message and where it went), thread/<source>:<id>'
            + ' (oldest first, 50), ticket/<id> (the whole ticket with its inputs and triggers), or the lists tickets, threads,'
            + ' and decisions (latest 30). Cards and deliveries carry previews only; pull full text here before acting on a'
            + ' cut-off message.',
        inputSchema: {
            resource: z.string().min(1)
                .describe('Resource uri: \'trigger/<id>\', \'thread/<source>:<id>\', \'ticket/<id>\', \'tickets\', \'threads\', or \'decisions\'.'),
        },
    }, args => textResult(() => JSON.stringify(readResource(runtime, args.resource), null, 2)));
    server.registerTool('superagent_reply', {
        title: 'open-superagent reply',
        description: 'Queue a message back to the original conversation: purpose answer replies to a person\'s question,'
            + ' result delivers a ticket result once it is ready, and attention asks the ticket\'s current structured question'
            + ' (question must copy ticket.attention.question exactly). The daemon sends it where the person wrote and records'
            + ' the send as a reply_recorded action; each message goes out at most once.',
        inputSchema: {
            purpose: z.enum(['answer', 'result', 'attention']),
            ticketId: z.string().optional().describe('The ticket the message is for; answer may omit it when triggerId names the question.'),
            triggerId: z.string().optional().describe('For answer, the original human question trigger.'),
            question: z.string().optional().describe('For attention, the ticket\'s current attention question, copied exactly.'),
            text: z.string().min(1).describe('The message text; keep replies short and free of private material.'),
        },
    }, args => textResult(() => {
        const reply = runtime.engine.reply({
            purpose: args.purpose,
            ...(args.ticketId !== undefined ? { ticketId: args.ticketId } : {}),
            ...(args.triggerId !== undefined ? { triggerId: args.triggerId } : {}),
            ...(args.question !== undefined ? { question: args.question } : {}),
            text: args.text,
        });
        return JSON.stringify(reply, null, 2);
    }));
    server.registerTool('superagent_ticket_note', {
        title: 'open-superagent ticket note',
        description: 'Hand one open ticket\'s worker a context fact from other work. A note asks for nothing and authorizes'
            + ' nothing: instructions and authorization travel through routing, not notes.',
        inputSchema: {
            ticketId: z.string().min(1),
            text: z.string().min(1).describe('The fact, as you would state it to a colleague.'),
        },
    }, args => textResult(() => {
        const ticket = runtime.engine.note(args.ticketId, args.text);
        return JSON.stringify({ ticketId: ticket.id, updatedAt: ticket.updatedAt }, null, 2);
    }));
    // Batch 3: the operator's controls over tickets, threads, decisions, and stored triggers. These map one-to-one onto
    // Engine methods upstream exposed through its management panel; a ZCode install has no panel, so they are tools.
    server.registerTool('superagent_ticket_retry', {
        title: 'open-superagent ticket retry',
        description: 'Start a new assignment for a ticket whose worker reported blocked or failed (or whose input delivery'
            + ' failed), under the same mandate. Use it after the person acted on the blocker.',
        inputSchema: { ticketId: z.string().min(1) },
    }, args => textResult(() => {
        const before = runtime.store.tickets.get(args.ticketId);
        if (!before)
            throw new UserError('unknownTicket');
        if (!canRetry(before))
            throw new UserError('notRetryable');
        const ticket = runtime.engine.retryTicket(args.ticketId);
        return JSON.stringify({ ticketId: ticket.id, stage: stageLabel(ticketStage(ticket)), assignment: latestAssignment(ticket)?.state }, null, 2);
    }));
    server.registerTool('superagent_ticket_stop', {
        title: 'open-superagent ticket stop',
        description: 'Stop a ticket on an explicit human instruction: it ends, its mandate is withdrawn, and it receives'
            + ' nothing more. A worker-reported blocker is not a reason to stop.',
        inputSchema: { ticketId: z.string().min(1), reason: z.string().optional().describe('Why, in one sentence.') },
    }, args => textResult(() => {
        const ticket = runtime.engine.stopTicket(args.ticketId, args.reason);
        return JSON.stringify({ ticketId: ticket.id, ended: ticket.ended?.outcome ?? 'stopped' }, null, 2);
    }));
    server.registerTool('superagent_ticket_status', {
        title: 'open-superagent ticket status',
        description: 'Read one ticket\'s stage, latest report, assignment state, attention question, and working directory,'
            + ' without the full input record. Ask a waiting worker for a status report with requestStatus.',
        inputSchema: {
            ticketId: z.string().min(1),
            requestStatus: z.boolean().optional().describe('Also ask the worker for a status report; only a worker that reported waiting is asked.'),
        },
    }, args => textResult(() => {
        const ticket = runtime.store.tickets.get(args.ticketId);
        if (!ticket)
            throw new UserError('unknownTicket');
        const asked = args.requestStatus ? runtime.engine.requestStatus(args.ticketId) : undefined;
        const assignment = latestAssignment(ticket);
        return JSON.stringify({
            ...ticketSummary(ticket),
            open: !ticket.ended,
            ended: ticket.ended,
            attention: ticket.attention,
            directory: ticket.execution?.directory,
            prepared: !!ticket.execution?.preparedAt,
            // The current assignment, so an orchestrator judging a re-handed spawn can tell whether a worker already claimed it
            // (claimedAt) or never started (no claim, no report).
            assignment: assignment ? { id: assignment.id, state: assignment.state, createdAt: assignment.createdAt,
                startedAt: assignment.startedAt, claimedAt: assignment.claimedAt, report: assignment.report } : undefined,
            threads: [...new Set([...(ticket.follows ?? []).map(follow => follow.thread), ...ticket.origin.triggerIds.flatMap(id => runtime.store.triggers.get(id)?.threads ?? []).map(threadKey)])],
            ...(asked !== undefined ? { statusRequested: asked } : {}),
        }, null, 2);
    }));
    server.registerTool('superagent_thread_unsubscribe', {
        title: 'open-superagent thread unsubscribe',
        description: 'Drop every ticket\'s subscription to one thread, such as a noisy issue, until a new decision'
            + ' subscribes a ticket to it again. Open tickets keep working; they stop receiving that thread\'s messages.',
        inputSchema: { thread: z.string().min(1).describe('The thread key, such as manual:conversation-1.') },
    }, args => textResult(() => JSON.stringify({ thread: args.thread, removed: runtime.engine.unsubscribe(args.thread) }, null, 2)));
    server.registerTool('superagent_decision_dismiss', {
        title: 'open-superagent decision dismiss',
        description: 'Dismiss the problem an unavailable decision shows, so the overview lists it no more. Only an'
            + ' unavailable decision can be dismissed; a failed assessment\'s trigger stays stored and can be requeued.',
        inputSchema: { decisionId: z.string().min(1) },
    }, args => textResult(() => {
        const decision = runtime.engine.dismiss(args.decisionId);
        return JSON.stringify({ decisionId: decision.id, kind: decision.kind }, null, 2);
    }));
    server.registerTool('superagent_trigger_requeue', {
        title: 'open-superagent trigger requeue',
        description: 'Queue a stored trigger for a fresh evaluation, such as after fixing an assessment failure. Refused'
            + ' while a worker on one of its threads still decides it.',
        inputSchema: { triggerId: z.string().min(1) },
    }, args => textResult(() => JSON.stringify({ triggerId: args.triggerId, queued: runtime.engine.reevaluate(args.triggerId) }, null, 2)));
    // Batch 4: the worker protocol its subagents run tickets through.
    server.registerTool('superagent_worker_read', {
        title: 'open-superagent worker read',
        description: 'Read your ticket\'s full record: the mandate, every input with its trigger in full text, the thread'
            + ' keys, the assignments with their reports, and any open question. The assignment card truncates texts; read here'
            + ' before acting on a preview.',
        inputSchema: { ticketId: z.string().min(1) },
    }, args => textResult(() => {
        const ticket = runtime.store.tickets.get(args.ticketId);
        if (!ticket)
            throw new UserError('unknownTicket');
        // A worker reading its record is the first real evidence that a worker exists for this assignment; the Executor's
        // restart reconciliation uses it to tell "still running" from "never started".
        const assignment = latestAssignment(ticket);
        if (assignment && assignment.state === 'running' && !assignment.claimedAt)
            runtime.engine.assignmentClaimed(ticket.id, assignment.id);
        return JSON.stringify(ticketView(ticket, triggerId => runtime.store.triggers.get(triggerId)), null, 2);
    }));
    server.registerTool('superagent_worker_ack', {
        title: 'open-superagent worker ack',
        description: 'Acknowledge the original human request you are about to work on: one brief sentence naming the'
            + ' concrete object and the intended result. Call it before substantial work on a person\'s request; the daemon'
            + ' answers where the person wrote, at most once per request.',
        inputSchema: {
            ticketId: z.string().min(1),
            triggerId: z.string().min(1).describe('The original request trigger, from the assignment card.'),
            text: z.string().min(1).describe('The one-sentence acknowledgement.'),
        },
    }, args => textResult(() => JSON.stringify(runtime.engine.reply({ purpose: 'acknowledgement', ticketId: args.ticketId, triggerId: args.triggerId, text: args.text }), null, 2)));
    server.registerTool('superagent_worker_report', {
        title: 'open-superagent worker report',
        description: 'Report your ticket\'s state: progress and waiting stay internal, while ready, blocked, failed, and any'
            + ' question notify the orchestrator. question asks one person one concrete question (askedBy names the person\'s'
            + ' message that raised it), answers names the person\'s question this report answers. Your report ends this'
            + ' assignment round: after it returns, stop and finish your run.',
        inputSchema: {
            ticketId: z.string().min(1),
            state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
            summary: z.string().min(1)
                .describe('What happened: changes, tests actually run, risks, and the concrete blocker when blocked or failed.'),
            question: z.string().nullable().optional().describe('One concrete question for a person, or null to clear an open one.'),
            askedBy: z.string().optional().describe('The person\'s message whose request raised the question.'),
            answers: z.string().optional().describe('The person\'s question trigger this report answers, which takes it up as within the ticket.'),
        },
    }, args => textResult(() => {
        const report = {
            state: args.state,
            summary: args.summary,
            ...(args.question !== undefined ? { question: args.question } : {}),
            ...(args.askedBy !== undefined ? { askedBy: args.askedBy } : {}),
            ...(args.answers !== undefined ? { answers: args.answers } : {}),
        };
        const ticket = runtime.engine.report(args.ticketId, report);
        // A one-shot worker's report ends its run, so the assignment's turn is over: record the boundary the Engine uses to
        // decide which human messages a worker had a chance to read before the ticket ends.
        const assignment = latestAssignment(ticket);
        if (assignment && assignment.state === 'running')
            runtime.engine.turnEnded(args.ticketId, assignment.id);
        // Upstream notice semantics: a question and a terminal state reach the orchestrator; progress, waiting, and dropped stay internal.
        const question = typeof report.question === 'string' ? report.question : undefined;
        const text = question !== undefined
            ? 'Worker attention: ' + args.summary + ' Question: ' + question
            : args.state === 'ready' || args.state === 'blocked' || args.state === 'failed'
                ? 'Worker ' + args.state + ': ' + args.summary
                : undefined;
        if (text)
            runtime.store.atomic(() => runtime.actions.add({ kind: 'relay', text, ticketId: args.ticketId }, new Date().toISOString()));
        return JSON.stringify({ ticketId: ticket.id, state: args.state, ...(ticket.ended ? { ended: ticket.ended.outcome } : {}) }, null, 2);
    }));
    server.registerTool('superagent_worker_handback', {
        title: 'open-superagent worker handback',
        description: 'Hand a message that reached your ticket back for assessment because it asks for work beyond the ticket'
            + ' or belongs to another one. Hand back unacknowledged, with a one-sentence reason; never drop a request silently.',
        inputSchema: {
            ticketId: z.string().min(1),
            triggerId: z.string().min(1).describe('The message to hand back.'),
            reason: z.string().min(1).describe('One sentence: what the message asks that the ticket does not cover.'),
        },
    }, args => textResult(() => JSON.stringify({ queued: runtime.engine.handback(args.ticketId, args.triggerId, args.reason) }, null, 2)));
    server.registerTool('superagent_worker_thread_unrelated', {
        title: 'open-superagent worker thread unrelated',
        description: 'Unsubscribe your ticket from a thread that turned out unrelated to it, with a one-sentence reason; read'
            + ' the thread\'s original messages first. The thread the ticket started on and the threads a Source bound it to stay.',
        inputSchema: {
            ticketId: z.string().min(1),
            thread: z.string().min(1).describe('The thread key, such as manual:conversation-1.'),
            reason: z.string().min(1).describe('One sentence on why the thread is not about this ticket.'),
        },
    }, args => textResult(() => {
        runtime.engine.markUnrelated(args.ticketId, args.thread, args.reason);
        return JSON.stringify({ ticketId: args.ticketId, thread: args.thread, unsubscribed: true }, null, 2);
    }));
    server.registerTool('superagent_worker_thread_follow', {
        title: 'open-superagent worker thread follow',
        description: 'Follow a related thread for read-only context: its messages reach the ticket as context, grant nothing,'
            + ' and a person\'s message there does not resume an ended ticket.',
        inputSchema: {
            ticketId: z.string().min(1),
            source: z.string().min(1).describe('The thread\'s Source, such as manual.'),
            id: z.string().min(1).describe('The thread id on that Source.'),
        },
    }, args => textResult(() => JSON.stringify({ following: runtime.engine.followForContext(args.ticketId, { source: args.source, id: args.id }) }, null, 2)));
}
