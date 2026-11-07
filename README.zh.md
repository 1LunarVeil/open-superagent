# open-superagent（开放超级智能体）

面向单仓库的主动式 agent 内核，打包为 ZCode 插件。它监听请求（当前通过手动注入工具；GitHub 轮询源将在后续阶段接入），在版本化 Policy 下裁决，把获准的请求变成工单（Ticket），每张工单在独立的 worker 子代理中执行，并把结果写回原对话。

内化自 DeepSeek 的 [`dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)（MIT；完整适配清单见 [NOTICE.md](NOTICE.md)）。域内核（`src/kernel/`）是对其零依赖核心的忠实移植，包括 144 个测试的完整测试套件；宿主驱动层是新代码，把同样的端口接口映射到 ZCode：用 MCP daemon 替代 DSH bundle，用主会话充当 Orchestrator（编排器），用插件自带的子代理充当 Worker（执行器）。

## 架构

```
ZCode 主会话（编排器，经 open-superagent 技能）
 └─ superagent_* MCP 工具 ──> open-superagent daemon（stdio MCP server）
      ├─ src/kernel/    引擎：Trigger → Eval(门控+研判) → Ticket(授权) → Assignment(派工)
      ├─ src/persist/   SQLite 存储、事务性副作用队列、发件箱、推进泵、设置
      ├─ src/daemon/    动作队列（tick 协议）、assessor/executor 适配器、18 个 MCP 工具
      └─ 状态：<stateDir>/open-superagent.sqlite（+ 目录锁）
 ZCode 子代理 open-superagent:worker（每张工单一个）── superagent_worker_* 工具 ──> daemon
```

### 工作循环（tick 协议）

1. 会话开始或每完成一件事，编排器调用 `superagent_tick`；
2. 按序处理返回的待办动作：`assess_candidate`（评估主动候选）、`spawn_worker`（派工单给 worker 子代理）、`deliver_inputs`（给进行中的工单投递新消息）、`relay`（转述 worker 报告）、`reply_recorded`（回执）；
3. 处理完再 tick，直到返回 "No pending actions."。

daemon 无法主动唤醒主会话（这是与上游推送式 steering 的关键差异），因此编排采用「拉取」而非「推送」；SessionStart 钩子会在会话开始时提醒有积压动作。

### 从上游保留的关键性质

- **授权与执行分离**：Mandate（授权）不可变，工单状态自持，可恢复、可重试、可退回（handback）；
- **事务性内核**：引擎同步执行、每个命令包在 SQLite 嵌套保存点事务里，副作用在事务内入队、提交后执行（transactional outbox）；
- **全链路幂等**：确定性内容 ID 贯穿触发、决策、投递、回复；
- **observe 先行**：默认只有允许名单上、且 @ 了 agent 的发送者能发起工作；主动规则默认 `observe` 模式——只记录「将会接受什么」而不真正建单；
- **消息永不静默丢失**：工单结束时未领取的人消息会重新进入评估。

### 与上游的有意差异（均为移植决定，代码内有注释）

| 上游（DSH） | 本插件（ZCode） |
|---|---|
| 每工单一个持久 worker 会话 | 每工单一次性 worker 子代理（assignment 卡承载全部上下文） |
| daemon 把候选卡/报告**推送**进常驻编排会话 | 编排器经 `superagent_tick` **拉取**待办动作 |
| 24/7 常驻部署（tmux + 独立 profile） | 会话内存活；daemon 随 MCP 连接起停 |
| 管理面板（React，注入 DSH 客户端） | 暂无面板；`superagent_status`/`superagent_health` 承担概览 |
| GitHub/Feishu 事件源 | `manual` 注入源（阶段 5 接入 GitHub 轮询机器） |
| 已送达未读需会话对账 | 投递即读（audit R2 修复，v1 无会话对账） |
| 未送达的评估可能永久卡死线程 | 未送达评估有看门狗兜底过期（audit R1 修复） |

## 组件

- `.zcode-plugin/plugin.json` —— 插件清单：一个 stdio MCP server、技能、worker 子代理、SessionStart 钩子。
- `skills/open-superagent/` —— 编排器协议（tick 循环、动作协议、路由与评估规则），`references/` 内为上游 prompt 原文的裁剪版。
- `agents/worker.md` —— `open-superagent:worker` 子代理定义。
- `scripts/smoke-stdio.mjs` —— 针对构建产物的 stdio 端到端冒烟测试。

## 18 个 MCP 工具

编排器：`superagent_status`、`superagent_tick`、`superagent_eval_read`、`superagent_eval_decide`、`superagent_route`、`superagent_read`、`superagent_reply`、`superagent_ticket_note`、`superagent_settings_get`、`superagent_settings_save`、`superagent_trigger_inject`、`superagent_health`。
执行器：`superagent_worker_read`、`superagent_worker_ack`、`superagent_worker_report`、`superagent_worker_handback`、`superagent_worker_thread_unrelated`、`superagent_worker_thread_follow`。

## 开发

```
npm install
npm run check        # 类型检查 + vitest（144 个测试）+ 构建到 lib/
node scripts/smoke-stdio.mjs
```

需要 Node >= 22.5（`node:sqlite`）。daemon 的状态保存在 `OPEN_SUPERAGENT_STATE_DIR`（默认 `~/.open-superagent`），按目录加锁，同一状态目录同一时刻只允许一个 daemon 实例。

## 信任边界

worker 以宿主会话的权限在工单目录内工作；本插件不提供 OS 级沙箱（与上游相同，如需隔离建议使用专用 OS 账户）。准入是 observe 先行：默认只有策略允许名单上的发送者、显式 @ agent 才能发起工作，主动规则从 observe 模式起步。agent 发往对话的每条消息都在发件箱留有回执。

## 路线图

- 阶段 5：GitHub 事件源（移植上游轮询机器：notifications、多流游标、ETag、CI）与面板。
- 阶段 6：面向「需要人处理的事项」的 Gen UI/MCP App 视图、飞书源、其他 MCP 宿主适配器（daemon 天然与宿主无关）。
