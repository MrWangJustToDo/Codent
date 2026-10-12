## ADDED Requirements

### Requirement: ACP agent 以 stdio 提供 JSON-RPC 服务

系统 SHALL 提供一个 agent 侧 ACP 入口（`codent acp`），通过 `@agentclientprotocol/sdk` 在 **stdio** 上提供 ACP v1 的 JSON-RPC 服务，可作为子进程被 ACP client（编辑器或 IM bot）拉起。该进程 SHALL 自带模型配置解析（复用 CLI local bootstrap：`.agents/config/models.json` / `.env`），MUST NOT 要求 client 传入模型或密钥；`session/new` 的 `cwd` SHALL 作为工作区根（`rootPath`）。

#### Scenario: 握手成功

- **WHEN** client 拉起 `codent acp` 并发送 `initialize`（`protocolVersion: 1`）
- **THEN** agent SHALL 返回 `protocolVersion: 1`、`agentInfo`（name/title/version）与 `agentCapabilities`
- **AND** MUST NOT 向 stdout 写入任何非 JSON-RPC 内容（日志走 stderr/agent log）

#### Scenario: 新建会话使用 client 的 cwd

- **WHEN** client 发送 `session/new`，`cwd` 为某绝对路径
- **THEN** agent SHALL 以该路径作为工作区根创建一个 AgentSession
- **AND** 返回不透明且唯一的 `sessionId`

### Requirement: 能力协商如实声明

agent SHALL 在 `initialize` 响应中如实声明其 v1 能力，且 MUST NOT 声明未实现的能力。至少覆盖：`loadSession`、`promptCapabilities`（`image`/`audio`/`embeddedContext`）、`mcpCapabilities`（`http`，可选 `sse`）、`sessionCapabilities`（`resume`/`close`/`delete`/`additionalDirectories` 中已实现者）、`agentCapabilities.auth`（`authMethods`；无交互鉴权时为空数组）。

#### Scenario: 不声明未实现的能力

- **WHEN** 某能力（如 `sessionCapabilities.delete`）尚未实现
- **THEN** `initialize` 响应中该能力字段 SHALL 省略或为 `null`
- **AND** 对应的 client 请求 MUST NOT 被接受（返回 JSON-RPC 错误）

#### Scenario: prompt 内容按能力门控

- **WHEN** agent 声明 `promptCapabilities.image: true`
- **THEN** client 发送含 `ContentBlock::Image` 的 prompt SHALL 被接受
- **AND** 未声明的类型（如 `audio`）进入时 SHALL 返回明确错误或降级（见 `acp-prompt-content`）

### Requirement: 会话生命周期映射到 AgentSession

agent SHALL 将 ACP 会话方法映射到 `AgentSessionHost`/`AgentSession`：`session/new` → `Host.create`，`session/load` → 恢复并回放，`session/resume` → 恢复不回放，`session/close` → 关闭并释放，`session/prompt` → `dispatch({type:"send"})`，`session/cancel` → `dispatch({type:"stop"})`，`session/set_mode` → `dispatch({type:"mode.set"})`。`sessionId` ↔ 一个 live `AgentSession` 的映射 SHALL 由 agent 持有。

#### Scenario: load 回放历史

- **WHEN** client 调用 `session/load`（`loadSession` 为 true）指向一个已持久化的会话
- **THEN** agent SHALL 通过 `session/update` 回放历史消息（user/agent/tool）后再返回 load 结果
- **AND** 回放期间 MUST NOT 触发模型调用

#### Scenario: resume 不回放

- **WHEN** client 调用 `session/resume` 指向一个已存在的会话
- **THEN** agent SHALL 恢复上下文、重连 MCP、直接返回，MUST NOT 回放历史

### Requirement: prompt turn 以 stop reason 收束

每次 `session/prompt` SHALL 在有界时间内以 ACP `StopReason` 收束；agent SHALL 将 AgentSession 的终态映射为 stop reason：正常完成 → `end_turn`，token 上限 → `max_tokens`，用户取消 → `cancelled`，拒绝 → `refusal`，超过单轮模型请求上限 → `max_turn_requests`。

#### Scenario: 正常完成

- **WHEN** 一次 prompt 的运行以 `completed` 结束
- **THEN** `session/prompt` 响应 SHALL 为 `{ stopReason: "end_turn" }`

#### Scenario: 达到迭代上限

- **WHEN** 运行因达到 `maxIterations` 预算而终止（工具调用截断）
- **THEN** 响应 SHALL 为 `{ stopReason: "max_turn_requests" }`（或按 token 上限映射为 `max_tokens`）

### Requirement: 取消语义

收到 `session/cancel` 时，agent SHALL 尽快中止正在进行的模型请求与工具调用，并在所有挂起的 `session/request_permission` 以 `cancelled` 收束后，以 `stopReason: "cancelled"` 响应原 `session/prompt`。agent MUST NOT 把取消作为 JSON-RPC 错误返回。

#### Scenario: 取消返回 cancelled

- **WHEN** 运行中收到 `session/cancel`
- **THEN** agent SHALL `dispatch({type:"stop"})`，把未完成工具调用标记为 cancelled
- **AND** 原 `session/prompt` SHALL 以 `{ stopReason: "cancelled" }` 返回（非 error）

### Requirement: 多会话并发与单会话串行

单个 agent 进程 SHALL 能同时服务多个 `sessionId`；同一 `sessionId` 的 `session/prompt` SHALL 串行（一个在飞时，后续 prompt 排队或返回忙错误），MUST NOT 并发驱动同一 AgentSession。

#### Scenario: 两个会话互不干扰

- **WHEN** client 在一个进程内创建两个会话并分别 prompt
- **THEN** 两个会话的 `session/update` SHALL 只发往各自的 `sessionId`
- **AND** 每个会话的状态、消息、工具调用互不串扰

### Requirement: authenticate 与 logout

agent SHALL 实现 `authenticate`（在无交互鉴权时 no-op 成功，或按声明的 auth method 处理）与 `logout`（当声明 `auth.logout` 能力时）。两者 MUST NOT 破坏已有会话。

#### Scenario: 无鉴权时 authenticate 为 no-op

- **WHEN** client 调用 `authenticate` 而 agent 未声明任何 auth method
- **THEN** agent SHALL 返回成功且不改变会话

#### Scenario: 声明 logout 能力后可用

- **WHEN** agent 声明 `agentCapabilities.auth.logout` 且 client 调用 `logout`
- **THEN** agent SHALL 清除其本地鉴权状态并返回成功
