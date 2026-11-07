# open-superagent 0.1.1 — dsh-superagent 能力对齐矩阵

对照对象：DeepSeek `dsh-superagent-prototype` @ `8c32a9d`（MIT），能力清单见
`D:\agent_try\plugins\superagent-research\dsh-superagent-audit.md` 与本次全量能力审计。

版本约定：本插件版本号**始终跟随 dsh-superagent 的发布版本（0.1.1）**，功能完善与缺陷修复不递增版本号。
因此本文件是「同一版本号下的能力快照」，随每次推进更新，而不是随版本号变化。

图例：**对齐** = 功能等价；**部分** = 语义保留但宿主能力受限；**未实现** = 本轮未做；**不适用** = DSH 专属，不应移植。

## 一、可移植的必需能力

| # | 上游能力 | 状态 | 本插件落点与证据 |
|---|---|---|---|
| A1 | 事件摄入 + 确定性去重 ID | 部分 | `superagent_trigger_inject`（`src/daemon/tools.ts`）用内容哈希 `key('manual', thread, actor, text)` 去重；**无外部 Source 轮询**（GitHub/Feishu 见下） |
| A2 | Thread 抽象 + 订阅扇出 + 只读关注 | 对齐 | 内核原样移植：`src/kernel/model.ts`、`tickets.ts`（`followForContext`/`markUnrelated`） |
| A3 | 确定性准入闸门（allowlist + addressed + admission 表 + strength） | 对齐 | `src/kernel/policy.ts`、`admission.ts`；e2e 验证 unlisted 发送者被 gate 忽略 |
| A4 | accept 模式 `off/observe/auto` | 对齐 | `EvalConfigSchema.mode` 默认 `observe`；`assessmentOutcome` 记录 `would_accept` |
| A5 | 按线程批量 Eval + 串行化 + 超时/重排 | 对齐 | `src/kernel/evals.ts`；`REQUEUES=2`，`UNDELIVERED_STALL_MS` 看门狗（R1 修复） |
| A6 | 不可变 Mandate + 策略版本 + resume 重校验 | 对齐 | `model.ts` 的 `Mandate`；`policyVersion()` 哈希 rules+mode+sources |
| A7 | Ticket 状态机 + stage 分类 + 结局 | 对齐 | `src/kernel/tickets.ts`、`stage.ts`；`stageLabel()` 在 `actions.ts` |
| A8 | Assignment 生命周期 + report 状态 + `waitsForPerson` | 对齐 | `src/kernel/assignments.ts`；本轮补上 `turnEnded` 调用（`tools.ts` worker_report） |
| A9 | 持久 effect 队列（同库事务内入队） | 对齐 | `src/persist/effects.ts`；测试覆盖 Later/退避/generation 保护/有序阻塞 |
| A10 | Outbox 回执 + 幂等键 + 按会话排序 + gone/retryable | 对齐 | `src/persist/outbox.ts`；manual 通道回执转为 `reply_recorded` 动作 |
| A11 | 面向人的回复目的闸门 + 字数上限 | 部分 | `src/kernel/replies.ts` 原样移植；IM 100 词限制原本在 Feishu sender，本插件无 IM 通道 |
| A12 | worker 并发上限 + 1 个人类插槽 | 部分 | `executor.maxWorkers` 已生效于 launch 闸门；**一次只 spawn 一个 worker**，无后台并行池 |
| A13 | 崩溃恢复：中断 assignment 重启 + 保留未投递输入 | 对齐（本轮新增）| `ZcodeExecutor.reconcile()` + `Engine.assignmentInterrupted`；`test/daemon.spec.ts` 覆盖 |
| A14 | 暂停语义（顺延 deadline、不派发） | 对齐 | `src/persist/passes.ts`、`effects` 的 `limit: () => paused ? 0` |
| A15 | Settings 分块 + 乐观并发 + 策略版本 | 对齐（本轮增强）| `src/persist/settings.ts`：块内浅合并 + `revision` 冲突拒绝 |
| A16 | 版本化 prompt + per-session 绑定 | 不适用 | 本插件把 prompt 交给宿主 skill/agent 文件；`prompts/` 子系统已移除 |
| A17 | PR 生命周期绑定 | 未实现 | 依赖 GitHub Source，下阶段 |
| A18 | 健康条目 + 不可用决策处理 | 对齐（本轮修复）| `src/persist/health.ts`；`passes.start()` 立即跑一轮，不再永久 `starting`；`superagent_decision_dismiss` |
| A19 | 面板/API 的 retry/stop/requeue/unsubscribe/dismiss/pause/settings | 对齐（本轮补齐）| 6 个新工具映射原 Engine 方法（`tools.ts` 第三批） |
| A20 | 有界分页读取代替灌上下文 | 部分 | `superagent_read` / `superagent_eval_read` 有界；无 `offset/cursor` 分页 |
| A21 | 跨重启幂等投递 | 对齐（本轮增强）| 动作队列改为**租约** + `superagent_tick_ack`，`actions.prune()` 控制增长 |
| A22 | 单写者状态所有权 | 对齐 | `proper-lockfile` 锁定 stateDir；第二实例 exit 3 并输出可诊断信息 |

## 二、本轮修复的缺陷（此前版本的真实问题）

| 缺陷 | 后果 | 修复 |
|---|---|---|
| worker 未声明 MCP 工具 | 子代理拿不到 `superagent_worker_*`，工单永远无法读完/上报 | `agents/worker.md` 显式列出 6 个 `mcp__plugin_open-superagent_open-superagent__*`；`scripts/check-agent-tools.mjs` 守卫 |
| 工单目录只有 `mkdir` | worker 无仓库可改 | `src/daemon/sandbox.ts`：固定 argv 的 `git worktree add --detach`，路径/ref 白名单校验 |
| `assignmentInterrupted` 无调用方 | 重启后 running 工单永久卡死 | `ZcodeExecutor.reconcile()` 在启动时对账 |
| `take()` 一次性终态 | 编排器中途崩溃即丢动作 | 租约 + ack + `retry` 标记 |
| 回复只进队列 | 用户看不到 ack/结果 | `reply_recorded` 协议要求 manual 通道原样输出 |
| 无对话入口 | 用户请求进不了 daemon | SKILL.md 定义 `superagent_trigger_inject` 注入协议 + 首启播种 operator |
| 6 个 Engine 能力无入口 | 无法 retry/stop/dismiss/requeue | 6 个新 MCP 工具 |
| 健康状态卡 `starting` | 状态页永远不 ready | `Passes.start()` 立即跑一轮 |
| 保存 `policy` 丢 `rules` | 改 sources 会静默清空规则 | 块内浅合并（数组仍整体替换） |
| `eval_decide` 强制 title/scope | ignore 也必须编造票面信息 | 仅 accept 必填 |
| `lib/` 被 gitignore | 目录市场安装后 daemon 起不来 | `lib/` 纳入版本控制；版本单一来源读 package.json |
| 全局状态目录 | 多项目共用一个库、第二个会话无工具 | `~/.open-superagent/projects/<sha256(project)[:16]>`；旧库存在时兼容回退 |
| 关闭后锁不释放（实测） | 重开会话直接 exit 3，插件彻底失效 | `index.ts` 监听 stdin `end`/`close` 与 server `onclose` 优雅关闭；e2e 回归测试 |
| 启动失败不释放锁 | 报「已被占用」，掩盖真实错误 | `main()` 在 `initialize` 失败时先 `runtime.stop()` |
| 重启后旧租约不释放（H1） | tick 回答「无待办」，工作被静默搁置 | `Actions.releaseAllLeases()` 在启动时释放 |
| 重启误杀运行中 worker（H3） | 两个 worker 写同一目录 | Assignment 增加 `claimedAt`（worker_read 时记录），已认领不重启 |
| 重投 spawn 判定错（H4） | 重试后误判「已服务」导致永久不派工，或重复派工 | `ticket_status` 暴露 assignment id/claimedAt；SKILL 按 claimedAt 判定 |
| 工作区失败后无法重试 prep（H2） | 修好环境后重试仍用坏目录 | `execution.preparedAt` 持久化，仅成功后才置位 |
| await 期间工单被停止（H6） | 为已结束 assignment 排队 spawn | 准备后重读工单，已结束则撤销动作 |
| 无 worktree 时不建目录（M2） | spawn 指向不存在的路径 | 非 worktree 分支 `mkdirSync` |
| notice 读错事件字段（M3） | notice 永不产生 | 改读 `event.data` |
| pause/executor 保存取消评估（M5） | 保存设置静默丢弃在途候选 | 仅策略版本真变化才 `policyChanged` |
| `policy.sources` 整块覆盖（M6） | 保存一个源丢其他源策略 | `sources` 再向下一层合并 |
| 首启 seed 被无关保存阻断（M1） | 操作员请求被闸门拒绝，插件看似无效 | 守卫改为 `blockRevision('policy') === 0` |

## 三、DSH 专属，明确不移植

`cordis.patch.yml`、Cordis DI/生命周期、DSH Session 的 steer/inject/inbox、`permissionPresets`、agent preset 注册、
`sessionPersistence`、DSH web client 的 slot 注入、`dsh-compaction-*`、tmux 部署脚本。这些在 MCP 化后由宿主或本插件
自己的实现替代，移植只会把 alpha 依赖带回来。

## 四、当前已知差距（如实披露）

1. **并发 worker = 1**：`maxWorkers` 只作为准入闸门，编排器一次只 spawn 一个 worker 并等待其结束。上游是真正的并发池 + 后台作业存活计费。
2. **无沙箱**：worker 以宿主会话权限运行，本插件不加 OS 隔离（与上游一致，上游建议专用 OS 账号）。
3. **无 token/step 预算**：上游同样只有字符上限与 30 分钟后台时限；本插件目前只有字符截断。
4. **无外部 Source**：GitHub 轮询（notifications/streams/ETag/CI）与 Feishu 事件消费均未实现，因此 A1/A17 为部分/未实现。
5. **无面板**：上游的 HTTP + React 概览页未移植；本插件用 MCP 工具 + skill 承担同样的操作面。
6. **无分页游标**：`superagent_read` 一次返回定长结果，超大线程可能被截断。
7. **`prepare` 命令未移植**：上游允许操作员配置任意 shell 准备命令；本插件只跑固定的 `git worktree`，以避免任意命令执行面（这是有意的安全取舍，不是遗漏）。
8. **跨会话共享**：同一项目同时开两个会话时，第二个 daemon 无法获得锁（exit 3）。这是单写者设计的必然结果，已在 stderr 明确提示。

## 五、验证证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 |
| 单元 + 集成 | `npm test` | 185 通过（内核 146 + 持久层 13 + daemon 19 + e2e 7） |
| 构建 | `npm run build` | 通过，产出 `lib/` |
| agent 工具名一致 | `npm run check:agents` | 25 工具 / 1 agent 文件，OK |
| 冒烟 | `node scripts/smoke-stdio.mjs` | 25 工具、准入闸门、候选卡均符合预期 |
| 真实宿主 | 桌面端重装后新会话 | **待用户确认**（需在 UI 卸载重装 0.1.1） |
