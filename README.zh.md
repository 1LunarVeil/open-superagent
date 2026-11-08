# open-superagent（开放超级智能体）

面向单仓库的主动式 agent 内核，打包为 ZCode 插件。它监听请求（当前通过手动注入工具；GitHub 轮询源将在后续阶段接入），在版本化 Policy 下裁决，把获准的请求变成工单（Ticket），每张工单在独立的 worker 子代理中执行，并把结果写回原对话。

内化自 DeepSeek 的 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT；完整适配清单见 [NOTICE.md](NOTICE.md)）。本插件为 ZCode 重新实现了宿主驱动层。域内核（`src/kernel/`）是对其零依赖核心的忠实移植，包括 144 个测试的完整测试套件；宿主驱动层是新代码，把同样的端口接口映射到 ZCode：用 MCP daemon 替代 DSH bundle，用主会话充当 Orchestrator（编排器），用插件自带的子代理充当 Worker（执行器）。与上游的能力对照及有意差异记录在 [docs/alignment-0.1.1.md](docs/alignment-0.1.1.md)。

## 架构

```
ZCode 主会话（编排器，经 open-superagent 技能）
 └─ superagent_* MCP 工具 ──> open-superagent daemon（stdio MCP server）
      ├─ src/kernel/    引擎：Trigger → Eval(门控+研判) → Ticket(授权) → Assignment(派工)
      ├─ src/persist/   SQLite 存储、事务性副作用队列、发件箱、推进泵、设置
      ├─ src/daemon/    动作队列（tick 协议）、assessor/executor 适配器、工作区准备、25 个 MCP 工具
      └─ 状态：<stateDir>/open-superagent.sqlite（+ 目录锁）
 ZCode 子代理 open-superagent:worker（每张工单一个）── superagent_worker_* 工具 ──> daemon
```

### 工作循环（tick 协议）

1. 会话开始时、或用户在本仓库提出工作请求时，先用 `superagent_trigger_inject` 记录该请求（`threadId` 为本会话键，`actorId` 为 `operator`，`addressed: 'direct'`）；
2. 调用 `superagent_tick`，按序处理整批待办动作：`assess_candidate`（评估主动候选）、`spawn_worker`（派工单给 worker 子代理）、`deliver_inputs`（给进行中的工单投递新消息）、`relay`（转述 worker 报告）、`reply_recorded`（回执）、`notice`（系统通知）；
3. 用 `superagent_tick_ack` 提交本批已完成的 `actionId`，再 tick，直到返回 "No pending actions."。

tick 发放的是**租约**而非终态：未被确认的动作在十分钟后重新发放并标记 `retry: true`，因此编排器中途崩溃只损失一次租约，不会丢掉工作。daemon 无法主动唤醒主会话（这是与上游推送式 steering 的关键差异），因此编排采用「拉取」而非「推送」；SessionStart 钩子会在会话开始时提醒有积压动作。

`reply_recorded` 在 `manual` 源上就是当前对话：编排器必须把动作里的 `text` 原样输出，而不是另写摘要。

### 从上游保留的关键性质

- **授权与执行分离**：Mandate（授权）不可变，工单状态自持，可恢复、可重试、可退回（handback）；
- **事务性内核**：引擎同步执行、每个命令包在 SQLite 嵌套保存点事务里，副作用在事务内入队、提交后执行（transactional outbox）；
- **全链路幂等**：确定性内容 ID 贯穿触发、决策、投递、回复；
- **observe 先行**：主动规则默认 `observe` 模式——只记录「将会接受什么」而不真正建单；本地操作员首次运行即进入 `manual` 源允许名单，其显式请求可直接开工；
- **消息永不静默丢失**：工单结束时未领取的人消息会重新进入评估。

### 与上游的有意差异（均为移植决定，代码内有注释）

| 上游（DSH） | 本插件（ZCode） |
|---|---|
| 每工单一个持久 worker 会话 | 每工单一次性 worker 子代理（assignment 卡承载全部上下文） |
| daemon 把候选卡/报告**推送**进常驻编排会话 | 编排器经 `superagent_tick` **拉取**待办动作 |
| 动作一经发放即视为完成 | 租约 + `superagent_tick_ack` 确认，超时重投并标记 `retry` |
| 24/7 常驻部署（tmux + 独立 profile） | 会话内存活；daemon 随 MCP 连接起停 |
| 操作员自行配置 `prepare` shell 命令建工作树 | 固定 argv 的 `git worktree add --detach`，路径与 ref 校验，不执行任意命令 |
| 管理面板（React，注入 DSH 客户端） | 暂无面板；`superagent_status`/`superagent_health` + 6 个操作工具承担概览与干预 |
| GitHub/Feishu 事件源 | `manual` 注入源（阶段 5 接入 GitHub 轮询机器） |
| 已送达未读需会话对账 | 投递即读（audit R2 修复，v1 无会话对账） |
| 未送达的评估可能永久卡死线程 | 未送达评估有看门狗兜底过期（audit R1 修复） |

## 组件

- `.zcode-plugin/plugin.json` —— 插件清单：一个 stdio MCP server（在工作区启动）、技能、worker 子代理、SessionStart 钩子。
- `skills/open-superagent/` —— 编排器协议（tick 循环与确认、对话入口、动作协议、路由与评估规则），`references/` 内为上游 prompt 原文的裁剪版。
- `agents/worker.md` —— `open-superagent:worker` 子代理定义。其 `tools:` 行是宿主强制的可见工具白名单：六个 worker MCP 工具以全名列出，worker 结构上无法调用编排器工具。
- `src/daemon/sandbox.ts` —— 工单工作区准备：项目仓库的 `git worktree` 分离检出，固定 argv + 路径校验。
- `scripts/smoke-stdio.mjs`、`scripts/check-agent-tools.mjs` —— 端到端冒烟测试，以及 agent 的 MCP 工具名漂移守卫。

## 25 个 MCP 工具

编排器：`superagent_status`、`superagent_tick`、`superagent_tick_ack`、`superagent_eval_read`、`superagent_eval_decide`、`superagent_route`、`superagent_read`、`superagent_reply`、`superagent_ticket_note`、`superagent_settings_get`、`superagent_settings_save`、`superagent_trigger_inject`、`superagent_health`。
操作控制：`superagent_ticket_retry`、`superagent_ticket_stop`、`superagent_ticket_status`、`superagent_thread_unsubscribe`、`superagent_decision_dismiss`、`superagent_trigger_requeue`。
执行器：`superagent_worker_read`、`superagent_worker_ack`、`superagent_worker_report`、`superagent_worker_handback`、`superagent_worker_thread_unrelated`、`superagent_worker_thread_follow`。

## 安装（ZCode）

插件已带构建产物（`lib/` 已提交），安装只需要 `PATH` 上有 Node >= 22.5 —— 不需要构建，也不需要为插件本身跑 `npm install`。

1. 设置 → 插件管理 → 把本仓库目录添加为本地市场，或把插件目录复制进已有市场。
2. 安装 `open-superagent`，然后**新开一个会话**：MCP 工具在会话启动时挂载，已开着的会话仍持有旧工具列表。
3. 在新会话里直接让 daemon 说话——`superagent_status`——确认它应答。

## 开发

```
npm ci
npm run check        # 类型检查 + 188 个测试 + 构建到 lib/ + agent 工具名守卫
node scripts/smoke-stdio.mjs
```

需要 Node >= 22.5（`node:sqlite`）。`lib/` 刻意纳入版本控制：清单从它启动 daemon，而目录市场安装不会执行构建。任何源码改动后都要重新构建并一并提交 `lib/`。

## 状态与安装

状态目录取 `OPEN_SUPERAGENT_STATE_DIR`；未设置时使用 `~/.open-superagent/projects/<项目哈希>`，避免两个仓库共用一份工单库。早期版本写在 `~/.open-superagent` 的库仍会被沿用，升级不丢工单。

每张工单的目录是项目仓库 `<stateDir>/work/` 下的分离工作树；工单结束后工作树保留，供你审阅改动。把 `executor.worktree` 设为 `false` 可改为空目录。

同一项目可以同时开多个会话：它们共用一份数据库，只有一个负责调度（派发 effect、运行 passes），其余正常提供全部工具，并在前者关闭后接管调度。

## 工单不做什么

worker 只改自己的分离工作树，主检出不受影响，也不会有任何东西自动合并回来。读完 worker 的报告后，需要你自己应用或丢弃那个工作树。把这条链路接到 PR 上是 GitHub Source 阶段的事。

## 信任边界

worker 以宿主会话的权限在工单工作树内工作；本插件不提供 OS 级沙箱（与上游相同，如需隔离建议使用专用 OS 账户）。daemon 不执行操作员提供的任意命令：工作区准备是固定的 `git worktree` 调用，参数经过校验。准入是 observe 先行：本地操作员首次运行进入允许名单，主动规则保持 `observe` 直到切到 `auto`。agent 发往对话的每条消息都在发件箱留有回执。本插件只做调度，不做沙箱隔离。

## 路线图

- 阶段 5：GitHub 事件源（移植上游轮询机器：notifications、多流游标、ETag、CI）与面板。
- 阶段 6：面向「需要人处理的事项」的 Gen UI/MCP App 视图、飞书源、其他 MCP 宿主适配器（daemon 天然与宿主无关）。
