# Change: 为 Agent 实现 ACP（Agent Client Protocol）agent 侧包

## Why

我们希望像 Claude Code / opencode / pi 一样，把我们的 Agent 作为**标准 ACP agent** 暴露出去，从而直接复用成熟的 ACP 生态：

- **编辑器**：Zed / JetBrains / ACP Registry 可以直接连上我们的 Agent；
- **现成的 ACP→IM bot**：Kiro 式 Telegram bot、`acpx`（openclaw）、OpenClaw 等只要把 Agent 当作可 spawn 的子进程驱动，就能把我们的 Agent 变成 IM 机器人——**无需我们再写 IM 代码**。

当前我们没有 ACP 入口，编辑器和 IM 生态都无法驱动我们的 Agent，只有自研 `im-bridge` 一条通道。核心引擎（`AgentSession`/`AgentSessionHost`、模式、审批、计划、usage、持久化）已经足够，缺的是**适配层**（ACP 协议服务 + 出站/入站投影）。

## What Changes

- 新增 `@codent/acp` 包：**agent 侧** ACP v1 协议实现，进程内驱动 `AgentSessionHost`（不 spawn 子进程）。
- 新增 `codent acp` 子命令（以及 `codent-acp` bin）：stdio JSON-RPC 入口，可被任何 ACP client（编辑器 / IM bot）作为子进程拉起，自带模型配置解析（复用 CLI local bootstrap，`cwd` → `rootPath`）。
- 覆盖 ACP v1 的**全部**方法/通知：`initialize`/`authenticate`、`session/new|load|resume|close|prompt|cancel|set_mode`、`session/update` 全部变体、`session/request_permission`、`elicitation/create`、`logout`、slash 命令、usage、plan、modes、compaction、notices；以及对 client 能力（`fs`/`terminal`/`elicitation`）的正确协商（我们不使用 fs/terminal，但要如实声明）。
- **出站投影**：`AgentSession` 通道 → ACP `session/update`，含**增量** `agent_message_chunk` / `tool_call_update`（整条消息级 → part 级投影）。
- **入站映射**：ACP prompt `ContentBlock` → `ContentPart`/string；permission outcome → approvals；`elicitation` ↔ `ask_user`。
- **能力缺失补齐**：
  - ACP 层（本包）：part 级增量投影、tool `kind`/`locations`/结构化 `diff`、usage 的 used/size/cost 映射。
  - **session 契约**（经完整分析后确定的一处缺口）：slash 命令目录不可枚举——内置命令的元数据只在 `@codent/app`，扩展命令的摘要只有 `{name, hasOptions}`（无 description）。需给 `session-host-api` **新增**一个“可广告的 slash 命令目录”需求（内置命令以 core 为准，扩展命令带 description）。
- `AgentSession` 其余契约经分析**足够**（含 stop reason：`lifecycle` 通道已带 `agent:stop.reason` 与 `llm:response.finishReason`），无需其它 MODIFIED。
- **BREAKING**：无（纯新增）。

## Capabilities

### New Capabilities
- `acp-agent-host`: ACP agent 侧协议服务与 `codent acp` 入口——stdio 传输、能力协商、session 生命周期（new/load/resume/close）、prompt/cancel/set_mode、stop reason、并发会话。
- `acp-session-updates`: `AgentSession` → ACP `session/update` 的出站投影——增量 `agent_message_chunk`/`agent_thought_chunk`、`tool_call`/`tool_call_update`、`plan`、`current_mode_update`、`available_commands_update`、`usage_update`、`compaction_update`、`notice`、`session_info_update`。
- `acp-prompt-content`: 入站 prompt 与出站内容的映射——`ContentBlock` ↔ `ContentPart`、能力门控、tool `locations`、结构化 `diff`。
- `acp-user-interaction`: 权限与 elicitation——`session/request_permission` ↔ approvals、`elicitation/create` ↔ `ask_user`（含能力门控与降级）。

### Modified Capabilities
- `session-host-api`: 新增“可广告的 slash 命令目录”需求——会话/宿主 SHALL 能枚举内置命令（以 core 为准，name+description+参数提示）与扩展命令（含 description），供 ACP `available_commands_update` 使用。

## Impact

- **新增包**：`packages/acp`（`@codent/acp`）。
- **release host**：`packages/codent` 增加 `acp` 子命令与 `codent-acp` bin（自包含打包，符合 release host 定位）。
- **依赖**：新增 `@agentclientprotocol/sdk`（peer/依赖 `@codent/core`）。
- **复用**：`@codent/core` 的 `AgentSessionHost`/`AgentSession`；`packages/server/src/messages-delta.ts` 的变更检测思路（part 级化）。
- **core 变更（纯新增）**：导出可枚举的内置 slash 命令目录；扩展命令摘要补 `description`。应用层命令注册表改为从该目录派生（单一事实来源）。
- **不影响**：既有 CLI、`im-bridge`、server 行为；ACP 是一条额外 host。
- **后续（本变更外）**：`im-bridge` 作为 ACP client 驱动任意 ACP agent；发布到 ACP Registry（需要 auth method）。
