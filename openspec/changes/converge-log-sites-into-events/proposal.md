## Why

「记什么日志」现在有两个决定点：一张事件规则表（`agent/log/event-log-rules.ts`，改一行即可）和 61 处手写 `log.*` 调用（16 个文件，level/category 硬编码在调用点）。于是调整可观测性必须改代码，且同一事实有两套写法——状态机、bootstrap、扩展错误都既发事件又直写日志，造成状态转移占总量 31.4%、`prompt:submit` 永远写占位符 `(structured)`、审批 12,126 条里只有 2 条带原因。把记录来源收敛成「事件是唯一事实源」，才能让「记录哪些」变成配置问题而不是遍历代码的问题。

## What Changes

- **日志不再是写入口**：core 内 61 处 `log.*` 调用点（16 个文件）与 17 处 `ctx.logger.*`（6 个文件，经 `ExtensionRunner.writeExtensionLog` 落 `AgentLog`）改写成领域事件（新增事件类型 + 扩展已有 payload），日志只保留「agent 尚未注册」的启动兜底窗口。
- **单一声明点**：`event-log-rules.ts` 成为唯一的记录策略表（level / category / 格式化 / 抑制），并补齐「默认静默、显式开启」的缺省，事件比日志行多，不显式开启就不会写。
- **新增/扩展事件**（按需，实施时可增删）：`agent:status`（from/to/trigger，取代 `setStatus` 直写）、`session:title`、`session:mode`、`model:change`、`side-query:error|complete`（取代 `side-query` 直写）、`extension:log`（取代 `ctx.logger` 与 extension runner 直写）、`todo:changed`、`compaction:cache-cleanup-error` 等。`session:jobs` 等已有但被刻意排除的事件，改为在表里显式 `false` / 低级别。
- **run 作用域上移**：`runId` 进事件 envelope（`AgentEventMetaInput`），不再由日志 seam 的可变状态 `setRun()` 保存；`LogEntry.run` 由 bridge 从事件取。
- **启动期不丢**：core 在 bootstrap **之前**为 agent 绑定日志目标（对称于已有的 `teardownLogs`），使注册前事件也能被 `resolveLog` 命中；`AgentLog` 的 pending buffer 退化为兜底，不再是 bootstrap 诊断的唯一通路。
- **BREAKING（spec 层）**：`log-extension` 中「seam 永久存在、不可禁用、不依赖扩展」的要求改为「seam 仅覆盖注册前窗口」；`agent-log-timeline` 中「seam 直写是合法记录来源」的表述改为「记录来源必须是 bus 事件」，状态转移记录改由 `agent:status` 派生。
- **BREAKING（实现层）**：`AgentLog` 的 `setRun` / `debug/info/warn/error` 不再是推荐写法（保留给注册前兜底与 sink 测试）；新增 `validate:*` 断言阻止新增直写调用点。
- 磁盘格式不追溯：JSONL 行字段（`level`/`category`/`message`/`data`/`run`/`event`/`scope`）保持，`category` 改由事件类型映射到既有词表，历史日志与既有读取方无需迁移。

## Capabilities

### New Capabilities

（无。记录策略与 Event→Log 契约已有归属，本次只改它们的要求。）

### Modified Capabilities

- `agent-log-timeline`: 记录来源从「seam 直写 + 规则表」收敛为「全部由 bus 事件派生」；策略表完整性、状态转移由 `agent:status` 派生、run 作用域来自事件、禁止新增直写调用点成为强制要求。
- `log-extension`: sink/policy 边界不变，但日志目标必须能被 `resolveLog` 在 bootstrap 之前解析；seam 的定位从「永久不可移除的通知旁路」收窄为「agent 注册前的有界兜底」。
- `agent-event-envelope`: envelope 增加可选 `runId`，并声明「run 作用域的权威来源是事件，不是消费者保存的状态」。

## Impact

- 代码：`packages/core/src/agent/agent-log/`、`agent/log/`、`agent/agent-event-bus/`（`types.ts`、`meta.ts`、`buildEventAt`）、`runtime-types/agent-event-payloads.ts`、`agent/extension/`（`runner.ts` 的 `ctx.logger`、`event-visibility.ts`）、`managers/`（`agent-bootstrap.ts`、`agent-manager.ts`、`managed-agent.ts`、`approval-decision-coordinator.ts`、`session-lifecycle-commands.ts`、`middleware/*`、`stream-recovery/*`）、`agent/code-mode/`、`agent/memory/`、`agent/skills/`、`agent/lsp/`、`agent/mcp/`、`models/adapter/side-text-query.ts`。
- 校验：`validate:agent-log-timeline`、`validate:event-log-bridge`、`validate:agent-status-log`（原 `status-transition-log`）、`validate:agent-log-binding`、`validate:middleware-log`、`validate:agent-log-host-sink`、`validate:session-reuse-log`、`validate:session-message-log` 需同步改写或新增断言；新增「无手写记录调用点」「每个事件都有策略条目」检查。
- 主机（cli/app/acp/server）API 不变；`ctx.logger` 语义变为「emit `extension:log`」，扩展输出现有调用点无需改签名。
- 不涉及 `CoreEnv`、会话存储格式、Session 通道；不新增依赖。
