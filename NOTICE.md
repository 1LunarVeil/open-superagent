# NOTICE

This project internalizes and adapts code from
[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
(commit `8c32a9d`, MIT License, Copyright (c) 2026 DeepSeek Harness Team).

Adaptations made for this port (see `README.md` for the full list):

- `src/kernel/` is the upstream `src/core/` plus `policy.ts`, `admission.ts`, `limits.ts`,
  re-rooted as a standalone zero-dependency domain kernel. Deliberate deviations:
  - `Evals.due` gained an undelivered-Eval stall watchdog (`UNDELIVERED_STALL_MS`), closing
    audit finding R1 (an Eval whose candidate is never delivered could previously stall its
    thread forever).
  - The `orchestrator_*` tool names inside user-facing instruction strings became
    `superagent_*`.
  - `ExecutorConfigSchema.directory` accepts Windows drive-letter absolute paths.
  - One comment reworded (`the next eval (debounce buffer)` → `the next eval — the debounce
    buffer`) to avoid a security-scanner false positive; no semantic change.
- Upstream DSH-specific drivers (`executor/dsh.ts`, `app/sessions.ts`, `app/delivery.ts`,
  `client/`, Cordis runtime) are intentionally not ported; the daemon, MCP tools, sources,
  and worker agent in this repository are new code that implements the same port interfaces.
