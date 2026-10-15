# session-host-api Specification

## Purpose

The session handle a host is given: creation and lifecycle, how runs are driven, what state is observable, and the events a host may subscribe to.
## Requirements
### Requirement: Session snapshot covers app observation needs
The AgentSession snapshot SHALL include serializable fields sufficient for Footer, Debug, plan/MCP/extension panels, and subagent lists without reading ManagedAgent: at minimum `agentId`, `parentId`, `name`, `status`, `error`, `pendingApprovalCount`, `mode`, `lastStreamDurationMs`, `messages`, `queues`, `usage`, `todos`, `todosTitle`, `plan`, `autoMode`, `mcp` summary, `extensions` summary, and `subagents` summaries.

#### Scenario: Footer renders from snapshot alone
- **WHEN** the app holds only an AgentSession
- **THEN** it SHALL render model status, mode label, duration, queues, and plan progress from `getSnapshot()` and session channel events without importing ManagedAgent

### Requirement: Session commands cover app control needs
AgentSession.dispatch SHALL support all app-facing agent controls previously done via ManagedAgent / agentManager, including chat (`send`, `steer`, `followUp`, `forceSubmit`, `stop`, `clear` messages), approvals, tool-result injection, `compact`, plan enable/disable/toggle/execute/cancel/save/load/list/complete, `auto.set`, `rename`, MCP refresh, extension toggle/invoke, and session resume.

#### Scenario: Compact via dispatch
- **WHEN** the app dispatches `{ type: "compact" }`
- **THEN** the Host process SHALL run compaction and return `{ ok: true }` or a structured error
- **AND** messages/usage channels SHALL update without the app calling `autoCompact` directly

#### Scenario: Unsupported command is explicit
- **WHEN** a client dispatches an unknown or not-yet-implemented command
- **THEN** the result SHALL be `{ ok: false, code: "unsupported" | ... }` and MUST NOT throw across the HTTP boundary

### Requirement: AgentSessionHost catalog
The system SHALL provide an `AgentSessionHost` API with `create`, `connect`, `list`, and `destroy` so apps can manage sessions without `agentManager` or `SessionStore` imports. `list` SHALL report the live agents currently owned by the host. The host SHALL additionally support a persisted-session catalog through optional members `listPersistedSessions?` (enumerate the workspace's persisted sessions) and `deleteSession?` (remove one), which a host SHALL omit when its backing plane cannot serve them — mirroring the existing optional `getModelProvider?` / `getEnv?` convention. Because these two are optional, adding them SHALL NOT break existing host implementations, and a consumer SHALL treat their absence as "this host cannot enumerate/delete persisted sessions" rather than as an error to be papered over. Naming: this is deliberately NOT `listSessions` — `CodentAgent.listSessions()` already exists and returns the LIVE agents of a runtime, while `Host.list` returns the live agents of a host; both answer "what is running". `listPersistedSessions` answers "what is stored".

#### Scenario: Create and list
- **WHEN** the host creates a session and later calls `list()`
- **THEN** the new session metadata SHALL appear in the list result

#### Scenario: Connect to child session
- **WHEN** a root snapshot lists a subagent id
- **THEN** `host.connect(childId)` SHALL return an AgentSession for that id with the same interface as the root

#### Scenario: List persisted sessions without a live agent
- **WHEN** the host provides `listPersistedSessions` and the workspace holds persisted sessions created by an earlier process
- **THEN** it SHALL return them, MUST NOT return an empty list solely because nothing is live
- **AND** each entry SHALL carry the disk session id used by resume and delete

#### Scenario: Delete a persisted session directly
- **WHEN** `deleteSession(id)` is called for a persisted session that is not live
- **THEN** it SHALL remove the session's persisted data and report success
- **AND** it MUST NOT create an agent to do so

#### Scenario: Delete reports absence
- **WHEN** `deleteSession(id)` is called for a session that is neither live nor persisted
- **THEN** it SHALL report failure (not-found) rather than throwing or silently succeeding

#### Scenario: A host without the catalog compiles and reports absence
- **WHEN** a host implementation (e.g. a remote-session host backed only by the agent HTTP plane) does not provide `listPersistedSessions` / `deleteSession`
- **THEN** it SHALL still satisfy the `AgentSessionHost` contract
- **AND** a consumer SHALL detect the absence and degrade explicitly rather than calling a member that does not exist

### Requirement: Channels remain authoritative for live UI
Subscribed session channels (`state`, `messages`, `queues`, `usage`, `todos`, `plan`, `tool`, `summary`, `lifecycle`, optional `log`) SHALL remain the live update path; hosts MUST NOT require ManagedAgent subscriptions. The `lifecycle` channel payload SHALL use the typed AgentEvent envelope shared with AgentEventBus.

#### Scenario: Tool streaming without ManagedAgent
- **WHEN** `run_command` emits stdout chunks
- **THEN** the app SHALL receive them on the `tool` channel of the relevant AgentSession

#### Scenario: Lifecycle matches bus envelope
- **WHEN** `agent:stop` is emitted on the AgentEventBus and projected to Session
- **THEN** the Session `lifecycle` event payload SHALL carry the same typed envelope fields (`type`, `ts`, `agentId`, `payload`)

### Requirement: 可广告的 slash 命令目录

系统 SHALL 提供一个可枚举、可序列化的 slash 命令目录，作为“宿主可广告/可调用命令”的**单一事实来源**：

- **内置命令**：core SHALL 导出一份内置命令目录（至少含 `name` 与 `description`，并标明是否接受参数/选项），覆盖与 `AgentSessionCommand` 对应的内置命令（如 `mode`、`compact`、`clear`、`resume`、`rename`、`effort`、`model`、`mcp`、plan 相关、`usage`）。应用层的命令注册表 SHALL 从该目录派生，MUST NOT 维护第二份权威列表。
- **扩展命令**：`AgentSession` 暴露的扩展摘要 SHALL 包含每个扩展命令的 `name` 与 `description`（在现有 `hasOptions` 之外），使宿主无需读取 `ManagedAgent` 即可广告这些命令。

宿主（headless ACP、远程会话）SHALL 能仅凭该目录 + 会话扩展摘要枚举出“内置 + 扩展”的完整命令集合，用于 ACP `available_commands_update`。

#### Scenario: 内置命令目录可枚举

- **WHEN** 一个 headless 宿主（未加载 `@codent/app`）需要一个 slash 命令列表
- **THEN** 它 SHALL 能从 core 导出的内置命令目录取到每个内置命令的 `name` 与 `description`
- **AND** 应用层的命令注册表 SHALL 与该目录保持一致（同一事实来源）

#### Scenario: 扩展命令摘要携带描述

- **WHEN** 某会话启用了一个注册了命令 `memory` 的扩展
- **THEN** 会话扩展摘要 SHALL 含 `memory` 的 `name` 与 `description`
- **AND** 宿主 SHALL 能据广告该命令而不读取 `ManagedAgent`

#### Scenario: 命令仍经既有 dispatch 调用

- **WHEN** 宿主广告了某内置命令后收到调用
- **THEN** 该调用 SHALL 映射为对应的 `AgentSessionCommand`（如 `mode.set`/`compact`/`session.resume`）或 `extension.invokeCommand`
- **AND** 返回结果 SHALL 复用既有 `AgentSessionCommandResult` 约定

### Requirement: 会话创建可携带 MCP 服务器配置

系统的会话创建选项 SHALL 支持直接携带 MCP 服务器配置（一个「服务器名 → 服务器配置」的映射），
使宿主无需先写文件即可为单个会话指定 MCP 服务器。显式携带时该配置 SHALL 作为该会话 MCP 服务器的
唯一来源（取代默认配置文件中的同名集合），且连接的服务器 SHALL 以既有方式注册工具
（`mcp__<server>_<tool>`）。未携带时行为 SHALL 与今天完全一致。

#### Scenario: 显式配置取代文件配置
- **WHEN** 宿主以显式 MCP 服务器映射创建一个会话，且工作区存在 `.agents/mcp.json`
- **THEN** 该会话连接的 SHALL 只有显式映射中的服务器
- **AND** 文件中的服务器 MUST NOT 被连接

#### Scenario: 未携带时沿用文件
- **WHEN** 宿主创建会话时未携带 MCP 服务器映射
- **THEN** MCP 配置 SHALL 仍来自默认配置文件（含回退路径），行为与既有实现一致

#### Scenario: 三种受支持的 transport 都可下发
- **WHEN** 显式映射中的服务器分别是 stdio、http、sse transport
- **THEN** 三者 SHALL 都按各自的 transport 连接，MUST NOT 因 transport 而拒绝
- **AND** sse 与 http 的 `url`/`headers` 与 stdio 的 `command`/`args`/`env` SHALL 原样传入连接层

#### Scenario: 工具注册路径不变
- **WHEN** 一个显式服务器的 `tools` 列表非空
- **THEN** 其工具 SHALL 以 `mcp__<server>_<tool>` 注册进该会话的工具集
- **AND** 扩展/工具的既有注册与解绑路径 SHALL 不变

### Requirement: MCP 配置来源必须可观测且不污染既有字段

MCP 配置的来源 SHALL 可被观测（用于回答「为什么工作区的 mcp.json 没生效」），且该观测 SHALL NOT
通过把非路径值写入既有的路径语义字段（`configPath` / `configLoadedFrom`）来实现 —— 那两个字段的
语义是文件路径，会被 `/mcp` 呈现为路径。

#### Scenario: 显式配置的来源可观测
- **WHEN** 一个会话以显式 MCP 服务器配置创建
- **THEN** agent 日志 SHALL 记录配置来源为「会话创建选项」以及服务器数量
- **AND** MCP 状态中 MUST NOT 出现把 `"session-options"` 之类字面量当作文件路径的呈现

#### Scenario: 文件配置的来源不变
- **WHEN** 一个会话的 MCP 来自默认配置文件
- **THEN** 既有的 `configPath` / `configLoadedFrom` 语义与展示 SHALL 与本变更前一致

### Requirement: MCP 凭据不得进入日志或会话持久化

当 MCP 服务器配置由会话创建选项携带时，其中的环境变量值与 HTTP 头值 SHALL 视为凭据：
它们 MUST NOT 出现在会话日志、agent 日志或持久化的会话数据中。日志 SHALL 至多记录服务器名与其 transport。

#### Scenario: 日志只记录来源与服务器名
- **WHEN** 一个会话以显式 MCP 服务器配置创建，且某服务器带 `env` / `headers`
- **THEN** agent 日志 SHALL 记录服务器名与 transport
- **AND** MUST NOT 记录任何 `env` 值或 header 值

#### Scenario: 会话持久化不含配置
- **WHEN** 该会话被持久化到磁盘
- **THEN** 持久化数据 MUST NOT 包含 MCP 服务器的 `env` / `headers`

### Requirement: 单个 MCP 服务器连接失败不阻塞会话

当显式 MCP 服务器配置中有服务器连接失败时，会话创建 SHALL 仍然成功，失败原因 SHALL 可观测
（日志或 `/mcp` 状态），且其余服务器 SHALL 正常可用。

#### Scenario: 部分失败仍可会话
- **WHEN** 两个显式服务器中有一个连接失败
- **THEN** 会话 SHALL 创建成功，另一个服务器的工具 SHALL 可用
- **AND** 失败服务器 SHALL 在 MCP 状态中显示为未连接

