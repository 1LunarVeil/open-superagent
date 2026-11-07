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
import type { Runtime } from './runtime.ts';
/** Registers the daemon's tools on the server; called once after the runtime is initialized. */
export declare function registerTools(server: McpServer, runtime: Runtime): void;
