# open-superagent

[中文文档](README.zh.md)

A proactive agent kernel for one repository, packaged as a ZCode plugin. It listens for requests, judges them under a
versioned Policy, turns authorized ones into Tickets, and runs each Ticket in its own worker subagent — reporting back to
the original conversation.

Internalized from DeepSeek's [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT;
see [NOTICE.md](NOTICE.md) for the full adaptation list). This plugin reimplements the host driver layer for ZCode.
The upstream domain kernel (`src/kernel/`) is a faithful port of
its zero-dependency core, including its 144-test suite; the host drivers are new code that maps the same port interfaces
onto ZCode: an MCP daemon instead of a DSH bundle, the main session as orchestrator, and a plugin-provided subagent as the
worker. [docs/alignment-0.1.1.md](docs/alignment-0.1.1.md) records capability parity against upstream, and where this
port deliberately differs.

## Architecture

```
ZCode main session (orchestrator, via the open-superagent skill)
 └─ superagent_* MCP tools ──> open-superagent daemon (stdio MCP server)
      ├─ src/kernel/    Engine: Trigger → Eval(gate+assessment) → Ticket(Mandate) → Assignment
      ├─ src/persist/   SQLite store, transactional effects queue, outbox, passes pump, settings
      ├─ src/daemon/    actions queue (the tick protocol), assessor/executor adapters, workspace prep, 25 MCP tools
      └─ state: <stateDir>/open-superagent.sqlite (+ directory lock)
 ZCode subagent `open-superagent:worker` (one per ticket) ── superagent_worker_* tools ──> daemon
```

Key properties kept from upstream: authorization (`Mandate`) is immutable and separate from execution; the Engine is
synchronous and transactional with side effects queued inside the transaction and dispatched after commit; deterministic
content IDs make every path idempotent; observe mode records `would_accept` without creating work; tickets self-own their
state and can be resumed, retried, and handed back.

Port decisions that differ from upstream (all documented in code): workers are one-shot subagents rather than persistent
sessions, so delivery is deliver-implies-read; the daemon cannot steer a running session, so the orchestrator pulls work
through `superagent_tick` instead of being pushed to; and the ticket hand-out is a lease that the orchestrator retires with
`superagent_tick_ack`, so a session that dies mid-protocol loses one lease rather than the work.

## Components

- `.zcode-plugin/plugin.json` — manifest: one stdio MCP server (launched in the workspace), the skill, the worker agent, a SessionStart hook.
- `skills/open-superagent/` — the orchestrator protocol (tick loop and acknowledgement, chat ingress, action protocols, routing and assessment rules), with upstream prompt texts under `references/`.
- `agents/worker.md` — the `open-superagent:worker` subagent. Its `tools:` line is the host's enforced allowlist: the six worker MCP tools are named there in full, so a worker cannot reach the orchestrator's tools.
- `src/daemon/sandbox.ts` — ticket workspace preparation: a detached `git worktree` of the project, with fixed argv and validated paths.
- `scripts/smoke-stdio.mjs`, `scripts/check-agent-tools.mjs` — end-to-end smoke test, and a guard that fails when an agent's MCP tool names drift.

## The 25 MCP tools

Orchestrator: `superagent_status`, `superagent_tick`, `superagent_tick_ack`, `superagent_eval_read`,
`superagent_eval_decide`, `superagent_route`, `superagent_read`, `superagent_reply`, `superagent_ticket_note`,
`superagent_settings_get`, `superagent_settings_save`, `superagent_trigger_inject`, `superagent_health`.

Operator controls: `superagent_ticket_retry`, `superagent_ticket_stop`, `superagent_ticket_status`,
`superagent_thread_unsubscribe`, `superagent_decision_dismiss`, `superagent_trigger_requeue`.

Worker: `superagent_worker_read`, `superagent_worker_ack`, `superagent_worker_report`, `superagent_worker_handback`,
`superagent_worker_thread_unrelated`, `superagent_worker_thread_follow`.

## Development

```
npm ci
npm run check        # typecheck + 178 tests + build to lib/ + agent tool-name guard
node scripts/smoke-stdio.mjs
```

Requires Node >= 22.5 (`node:sqlite`). `lib/` is committed on purpose: the manifest starts the daemon from it, and a
directory-marketplace install does not run a build. Rebuild and commit `lib/` with any source change.

## State and installation

State lives under `OPEN_SUPERAGENT_STATE_DIR` when set, else `~/.open-superagent/projects/<project-hash>` so two
repositories never share one ticket database. A state directory written by an older build at `~/.open-superagent` is still
used, so an upgrade keeps its tickets.

Each ticket directory is a detached git worktree of the project repository under `<stateDir>/work/`. Worktrees are removed
only when clean; a dirty one stays for inspection. Set `executor.worktree` to `false` to give workers an empty directory
instead.

Only one daemon may own a state directory. Opening a second session in the same project fails with exit code 3 and a
message naming the directory.

## Trust boundary

The worker runs with the host session's permissions inside its ticket worktree; the plugin does not add an OS sandbox (the
same caveat as upstream, which recommends a dedicated OS account for isolation). The daemon never executes an
operator-supplied command: workspace preparation is a fixed `git worktree` invocation with validated arguments. Admission
is observe-first: the local operator is allowlisted on first run so their explicit requests start work, while proactive
rules stay in `observe` mode until switched to `auto`. Everything the agent sends to a conversation is recorded as a
receipt in the outbox.

## Roadmap

- Phase 5: GitHub Source (upstream polling machine port: notifications, streams, ETag cursors, CI) and a panel.
- Phase 6: a Gen UI/MCP App view for "what needs a person", Feishu Source, adapters for other MCP hosts (the daemon is host-agnostic by construction).
