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

