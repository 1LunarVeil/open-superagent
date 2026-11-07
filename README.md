# open-superagent

[中文文档](README.zh.md)

A proactive agent kernel for one repository, packaged as a ZCode plugin. It listens for requests (today via a manual injection tool; GitHub polling arrives in a later phase), judges them under a versioned Policy, turns authorized ones into Tickets, and runs each Ticket in its own worker subagent — reporting back to the original conversation.

Internalized from DeepSeek's [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype) (MIT; see [NOTICE.md](NOTICE.md) for the full adaptation list). The upstream domain kernel (`src/kernel/`) is a faithful port of its zero-dependency core, including its 144-test suite; the host drivers are new code that maps the same port interfaces onto ZCode: an MCP daemon instead of a DSH bundle, the main session as orchestrator, and a plugin-provided subagent as the worker.

## Architecture

```
ZCode main session (orchestrator, via the open-superagent skill)
 └─ superagent_* MCP tools ──> open-superagent daemon (stdio MCP server)
      ├─ src/kernel/    Engine: Trigger → Eval(gate+assessment) → Ticket(Mandate) → Assignment
      ├─ src/persist/   SQLite store, transactional effects queue, outbox, passes pump, settings
      ├─ src/daemon/    actions queue (the tick protocol), assessor/executor adapters, 18 MCP tools
      └─ state: <stateDir>/open-superagent.sqlite (+ directory lock)
 ZCode subagent `open-superagent:worker` (one per ticket) ── superagent_worker_* tools ──> daemon
```

Key properties kept from upstream: authorization (`Mandate`) is immutable and separate from execution; the Engine is synchronous and transactional with side effects queued inside the transaction and dispatched after commit; deterministic content IDs make every path idempotent; observe mode records `would_accept` without creating work; tickets self-own their state and can be resumed, retried, and handed back.

Port decisions that differ from upstream (all documented in code): workers are one-shot subagents rather than persistent sessions, so delivery is deliver-implies-read (audit finding R2 closed); an undelivered Eval can no longer stall forever (R1 closed via a stall watchdog); the daemon cannot steer a running session, so the orchestrator pulls work through `superagent_tick` instead of being pushed to.

## Components

- `.zcode-plugin/plugin.json` — manifest: one stdio MCP server, the skill, the worker agent, a SessionStart hook.
- `skills/open-superagent/` — the orchestrator protocol (tick loop, action protocols, routing and assessment rules), with upstream prompt texts under `references/`.
- `agents/worker.md` — the `open-superagent:worker` subagent definition.
- `scripts/smoke-stdio.mjs` — end-to-end stdio smoke test against the built daemon.

## The 18 MCP tools

Orchestrator: `superagent_status`, `superagent_tick`, `superagent_eval_read`, `superagent_eval_decide`, `superagent_route`, `superagent_read`, `superagent_reply`, `superagent_ticket_note`, `superagent_settings_get`, `superagent_settings_save`, `superagent_trigger_inject`, `superagent_health`.
Worker: `superagent_worker_read`, `superagent_worker_ack`, `superagent_worker_report`, `superagent_worker_handback`, `superagent_worker_thread_unrelated`, `superagent_worker_thread_follow`.

## Development

```
npm install
npm run check        # typecheck + vitest (144 tests) + build to lib/
node scripts/smoke-stdio.mjs
```

Requires Node >= 22.5 (`node:sqlite`). The daemon keeps its state under `OPEN_SUPERAGENT_STATE_DIR` (default `~/.open-superagent`), locked per directory.

## Trust boundary

The worker runs with the host session's permissions inside its ticket directory; the plugin does not add an OS sandbox (the same caveat as upstream, which recommends a dedicated OS account for isolation). Admission is observe-first: by default only senders on the Policy's per-source allowlist who address the agent can start work, and proactive rules start in `observe` mode. Everything the agent sends to a conversation is recorded as a receipt in the outbox.

## Roadmap

- Phase 5: GitHub Source (upstream polling machine port: notifications, streams, ETag cursors, CI) and a panel.
- Phase 6: a Gen UI/MCP App view for "what needs a person", Feishu Source, adapters for other MCP hosts (the daemon is host-agnostic by construction).
