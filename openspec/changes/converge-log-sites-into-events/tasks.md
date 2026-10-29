## 1. 事件信封与 run 作用域（design D3）

- [x] 1.1 `AgentEventMetaInput` 与 `AgentEvent` 增加可选 `runId`（`agent/agent-event-bus/types.ts`）
- [x] 1.2 `buildEventAt` 复制 `meta.runId` 到信封（`agent-event-bus.ts:336-357`）——信封在这里定型，不是 `emitAgentTelemetry`
- [x] 1.3 `AgentTelemetryEmitter` 增加 `getCurrentRunId?()`，`emitAgentTelemetry` 写入 carrier 的 `runId`；`ManagedAgent.dispatchEvent`（`managed-agent.ts:1165`）转发到 `bus.emit` meta
- [x] 1.4 `event-log-bridge.writeLog` 从 `event.runId` 写 `LogEntry.run`；删除 `managed-agent-run-lifecycle.ts:115,178` 的 `log.setRun` 调用，`AgentLog.setRun` 只保留给注册前兜底与测试
- [x] 1.5 校验：两条 run 的条目分别聚到不同 `run`，bootstrap 条目无 `run`（扩写 `validate-event-log-bridge.mjs`）

## 2. 注册前日志解析（design D2）

- [x] 2.1 `AgentManager` 增加 `constructionLogs: Map<string, AgentLog>`，提供 `bindConstructionLog(agentId, log)` / `releaseConstructionLog(agentId)`
- [x] 2.2 `logExtension.resolveLog` 顺序改为 `agents → constructionLogs → teardownLogs → null`；`AgentEventBusScope` 的 interceptor 解析器（`agent-manager.ts:119-122`）同样接入
- [x] 2.3 `buildManagedAgent` 在 `ManagedAgent` 构造完成后、bootstrap 之前绑定；构造失败路径释放（对称于 `releaseAgentScope`）；注册时移入 `agents`
- [x] 2.4 校验（探针优先）：`validate-bootstrap-log-binding.mjs` —— 构造中加载一个 `activate` 抛错的扩展，断言 `agent:extension-error` 落盘且只出现一次（读文件而非内存 capture，缓冲丢弃会让 capture 变绿）；同时修正 `agent-bootstrap.ts` 的过期注释（真实原因是注册前解析不到，不是 log extension 未启动）
- [x] 2.5 量化 bootstrap 期间的事件量：实测一次启动 **8 条**（含一个抛错扩展），`MAX_PENDING_LOG_ENTRIES = 200` 保留并在注释里写下实测值与「不该靠加大上限解决」的理由
- [x] 2.5b bootstrap 直写收敛：扩展失败类改发 `agent:extension-error`（`phase: "load" | "config"`），文档/记忆/技能等降级改发 `session:diagnostic`（`area` 区分），bootstrap 汇总为 `session:bootstrap-summary`
- [x] 2.6 `session:*` 汇总行为保持不变：`emitSessionBootstrapEvents` 已在注册后发出，没有再为它加事件；`Bootstrap complete` 作为唯一汇总行保留

## 3. 状态机改由事件驱动（design D5、D7）

- [x] 3.1 新增 telemetry 事件 `agent:status`，payload `{ from, to, trigger? }`（`agent-event-bus/meta.ts` + `runtime-types/agent-event-payloads.ts` + `EXTENSION_EVENT_VISIBILITY`）
- [x] 3.2 `ManagedAgent.setStatus` 只 `emitEvent("agent:status", …)`，删除直写分支；删除 `agent/log/status-transition-log.ts` 并从 `dev/dev-managers.ts` 移除导出
- [x] 3.3 规则表：终态与非机械触发 `info`；机械触发（`approvals-*`、`chunk:*`、`run-*`、`reconcile*`、`compaction:*`）显式抑制
- [x] 3.4 `turn:summary` payload 增加 `paused?: true`（`run-finalizer.ts` 对 `kind === "waiting"` 设置），规则区分 `Turn paused (waiting for input)` 与 `Turn complete (outcome)`
- [x] 3.5 改写 `validate-agent-status-log.mjs`（原 `validate-status-transition-log.mjs`）：不再 import `statusTransitionLogLevel`，改为断言「机械转移不产生条目 / 终态产生一条 / setStatus 只发事件不写行 / 无 trigger 的转移仍可见」

## 4. 其余手写调用点收敛（design D6、D8 + 事件清单）

- [x] 4.1 `ctx.logger` 改为 `extension:log`（**observable**）：`runner.ts` 单一改点覆盖 17 处调用；`MemoryLog` / `BindingNameLog` 等窄接口签名不变（参数名改为 `logger`，与 `AgentLog` 区分）；`ExtensionRunnerOptions.log` 删除（不再有第二个写入路径）；加「派发中丢弃嵌套日志」的重入保护
- [x] 4.2 `side-text-query.ts` 与 `extension-completion.ts` 改为 `side-query:complete` / `side-query:error`（payload 带 purpose、mode、model、durationMs、`rawExcerpt`、`fallback`）
- [x] 4.3 会话标题：`session-lifecycle-commands.ts` 与 `session-service.ts` 改为 `session:title`（`{ ok, name?, error? }`）——标题失败不是 side-query 失败
- [x] 4.4 配置变更：`setModel` 发 `model:change`（`{ from, to, style?, fallback? }`），吸收持久化模型回退告警（auto 模式/effort 已由 `session:mode` 承载）
- [x] 4.5 会话重置：`managed-agent.ts` 改为 `session:reset`（`{ reason, previousStatus, hadTodos }`）；`session:switch` 的 `reason` 放宽并贯通 `resume | fork | clone`
- [x] 4.6 错误类直写归位：chat loop 失败与 stream-recovery 上限复用 `agent:stream-error`；控制器 warn 适配器改为注入 `emitDiagnostic`
- [x] 4.7 压缩与工具投影：`compaction-middleware.ts` → `compaction:cache-cleanup-error`；`tool-compact-middleware.ts` → `tool:projection-error`
- [x] 4.8 hook 回声：`instrument-middleware-log.ts` 改为 `hooks:echo` 事件（默认抑制）。`MY_AGENT_LOG_HOOKS` 的判定收进策略模块 `agent/log/hooks-echo.ts`（`hookEchoesEnabled()`），**发射点先问策略再构造 payload**：关闭时每轮仍会计几十个 payload 并推给所有 `observeAny` 订阅者（`hooks:echo` 是 observable），这正是 `hooks-echo.ts` 头注释写下的理由；handler 保留同款守卫，拦住程序化 `bus.emit`。调用点不再自己读 env 名
- [x] 4.9 记忆/技能/指令诊断：`memory-retrieval.ts` / `binding-names.ts` 的窄 logger 端口经 `ctx.logger` 归入 `extension:log`，不再单独造事件
- [x] 4.10 父日志索引行保留直写：`subagent-log-mirror.ts` 在 allowlist 中写明理由
- [x] 4.11 错误载荷统一：载荷自带的 `error` 文本经 `eventError()` 落地（不制造指向日志模块的栈）；不引入 `AgentEventErrorInfo` 对象，因为现有载荷只需要 message

## 5. 规则表默认静默与分类映射（design D4）

- [x] 5.1 补条目：`agent:status`、`extension:log`、`side-query:*`、`session:title`、`session:reset`、`session:diagnostic`、`model:change`、`tool:projection-error`、`hooks:echo`、`compaction:cache-cleanup-error`、`run:wake`
- [x] 5.2 投影事件显式抑制：`PROJECTION_EVENT_LOG_RULES: Record<Exclude<AgentEventType, keyof AgentEventPayloadMap>, false>` 合并进 `DEFAULT_EVENT_LOG_RULES`
- [x] 5.3 internal 事件（`tool:chunk`、`tool:clear`、`extension:ui`）条目是 `false`
- [x] 5.4 分类映射集中：telemetry 事件在规则表里声明 category；`session:diagnostic` 的 area→category 映射在 `event-log-specialized.ts`，调用点不再各写 category
- [x] 5.5 校验：`validate-event-log-bridge` 断言 specialized 表与 handler map 一一对应，且 **每个事件类型都有一条规则**（用 `AGENT_EVENT_META` 的键作运行时全集）；§7b 的 internal 断言仍通过

## 6. 守卫与清理（design D9）

- [x] 6.1 新增 `validate-no-direct-agent-log.mjs` + `validate:no-direct-agent-log`：扫描 `packages/*/src`，命中 allowlist 之外即失败并打印文件:行
- [x] 6.2 allowlist 是**文件**清单（不是目录前缀）：`agent-log.ts`（seam）、`lifecycle-guards.ts`（崩溃路径，总线已不可信）、`event-log-bridge.ts` 与 `event-log-specialized.ts`（桥与专用 handler）、`subagent-log-mirror.ts`（父索引行），每条附理由；守卫自带负例自检，正则覆盖 `getLog?.()?.` / `resolveLog(...)?.` / 裸 `eventEntry(`
- [x] 6.3 删除死分类 `todo`（`types.ts` + `schemas.ts`）；`ctx.logger` 的 category 由调用方传入、未知值回落 `hooks`
- [x] 6.4 移除与 `session:*` 重复的 bootstrap 直写，保留唯一一条汇总行

## 7. 验证与文档

- [x] 7.1 `pnpm build && pnpm lint && pnpm typecheck` 全绿
- [x] 7.2 `pnpm validate:all` 全绿（含本次改写的 log 相关校验与两个新增校验）
- [ ] 7.3 真实会话回归：重启后（运行中的进程加载的是改动前的 dist）跑一轮含审批的 turn，断言无机械 status 噪音、`prompt:submit` 带真实文本、`extension:log` 落盘、`session:bootstrap-summary` 存在、子 agent 行有 `run` —— 需人工重启客户端，脚本无法代替
- [x] 7.4 `prompt:submit` 不再写 `(structured)`：从 UI 消息取最后一条非 `<ctx>` 用户消息（`lastGenuineUserText`），同一文本也交给扩展 `before_agent_start`
- [x] 7.5 同步 `AGENTS.md` 的「Logging」段落：seam 收窄为注册前兜底、策略表是唯一记录决策点、`extension:log` 为 observable、`runId` 来自信封

## 8. 真实会话审计后的收口（本轮）

依据一次真实长会话（`ses_mvt9vyoz_vcez2q`，6 轮 / 67 分钟 / 587 次工具 / 2 次压缩 / 3 个子 agent）的日志回放：

- [x] 8.1 压缩引用式 GC 加 24h 宽限期：`cleanupOrphanedToolCache` 只回收超过 `TOOL_OUTPUT_ORPHAN_GRACE_MS` 的文件（被压出 wire ≠ 证据过期；正文仍保留 `cachedOutputPath`）。事故：17:48 压缩后 17:49 读子 agent 报告得 `No such file`，中间数条审计意见永久丢失。校验 `validate:tool-output-cache` §4e（新鲜文件存活 / 2 天文件仍被回收）
- [x] 8.2 审批来源：`agent:tool-approval-request.auto`（auto/plan 执行时不问人）与 `agent:tool-approval-resolved.source: user | auto | policy`；事件照发，策略用新增的 `EventLogRule.suppress(event)` 决定不写行 —— auto 的两行消失（真实会话里 1,330/6,034 = 22%），人工与命令策略的决策保留且可读（`by policy`）
- [x] 8.3 `mode:change`：`session:mode` 是投影（策略表 `false`），无法解释"为什么这批审批没人问"；auto 开关与 reasoning effort 变化各写一条 `info`（resolution of design 的 open question 3）
- [x] 8.4 子 agent 计费：`subagent:completed.costUsd`（worker 整个 run 只有一次 `chat()`，其 `llm:response` 只是最后一轮）；根日志 + 子日志据此可与会话 `cost` 对账（实测旧会话差 31%）
- [x] 8.5 `agent:thinking` 带 `{ iteration, model }`：旧行 280 条零信息；仍为 debug，可按 iter 与 `llm:*` 对齐
- [x] 8.6 `scripts/log-quality-report.mjs`：读真实会话日志输出「量级 / 覆盖 / 承诺项 / 噪音 / 委派 / 成本对账」，`--check` 对 7.3 的验收项做机器判定（机械 status、`(structured)` prompt、无 run 的子行、成本差 >10%、遗留直写 status）。独立运行，不进 `run-all-validators`（该 runner 明确拒绝读 gitignored 的 `.agents/`）
- [x] 8.7 文档回写：tasks 2.5 的实测条数 7→8；design D8 改为已实现的 `error?: string` + `eventError()` 口径；7.3 的阻塞原因改为"运行中的进程加载的是改动前的 dist"
- [x] 8.8 缓存清理合并为一张表：`tools/shared/cache/workspace-cache.ts` 定义三个 artifact（spill `.txt` / job log `.log` / job record `.json`）的 dir+suffix+age 与 `sweepWorkspaceCaches` 唯一触发；`sweepStaleToolOutput` / `sweepStaleJobLogs` / `sweepStaleJobRecords` 委托同一 sweeper（共享 once-per-root guard），registry 与首次 spill 写入都只调一个入口；目录常量与 24h/7d 窗口收敛到表内（`COMMAND_JOB_LOG_DIR` → `COMMAND_JOB_CACHE_DIR`，因为记录与日志同目录）；新增 `validate:workspace-cache-retention`（表↔常量一致、一次清三类、guard 共享、后缀隔离），两个缓存校验共用 `scripts/helpers/mock-env.mjs`
