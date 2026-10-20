# acp-agent-host Specification

## Purpose
TBD - created by archiving change add-acp-agent. Update Purpose after archive.
## Requirements
### Requirement: ACP agent 以 stdio 提供 JSON-RPC 服务

系统 SHALL 提供一个 agent 侧 ACP 入口（`codent acp`），通过 `@agentclientprotocol/sdk` 在 **stdio** 上提供 ACP v1 的 JSON-RPC 服务，可作为子进程被 ACP client（编辑器或 IM bot）拉起。该进程 SHALL 自带模型配置解析（复用 CLI local bootstrap：`.agents/config/models.json` / `.env`），MUST NOT 要求 client 传入模型或密钥。`session/new`、`session/load`、`session/resume` 的 `cwd` SHALL 成为该会话的工作区根（`CoreEnv.rootPath`）：相对路径解析、`.agents/**` 的位置与 `session/list` 的过滤 SHALL 都以它为准。`cwd` 缺省时 SHALL 回落到进程默认根；`cwd` 与默认根不同时 MUST NOT 只写 stderr 提示后继续使用默认根。进程默认根 SHALL 只用于握手前/无会话时的读取，以及 `session/list` 未带 `cwd` 时的默认范围。

#### Scenario: 握手成功

- **WHEN** client 拉起 `codent acp` 并发送 `initialize`（`protocolVersion: 1`）
- **THEN** agent SHALL 返回 `protocolVersion: 1`、`agentInfo`（name/title/version）与 `agentCapabilities`
- **AND** MUST NOT 向 stdout 写入任何非 JSON-RPC 内容（日志走 stderr/agent log）

#### Scenario: 每个会话使用自己的 cwd 作为根

- **WHEN** client 调用 `session/new`（或 `load` / `resume`）并传入 `cwd`
- **THEN** 该会话的 `CoreEnv.rootPath` SHALL 等于该 `cwd`
- **AND** 该会话的 `.agents/**`、相对路径与工具的工作目录 SHALL 以它为准
- **AND** 同一进程内另一个带不同 `cwd` 的会话 SHALL 使用它自己的根，两者 MUST NOT 串扰

#### Scenario: 缺省 cwd 回落默认根

- **WHEN** client 创建/恢复会话时未传 `cwd`
- **THEN** 该会话 SHALL 使用进程默认根（`codent acp` 的启动目录 / `createAcpAgent` 的 `rootPath`）

#### Scenario: 无法服务的 cwd 显式失败

- **WHEN** `cwd` 指向不存在或不可访问的目录
- **THEN** 会话创建 SHALL 返回 JSON-RPC 错误（`invalidParams`），MUST NOT 静默改用默认根
- **AND** MUST NOT 留下半创建的会话

### Requirement: 能力协商如实声明

agent SHALL 在 `initialize` 响应中如实声明其 v1 能力，且 MUST NOT 声明未实现的能力。至少覆盖：`loadSession`、`promptCapabilities`（`image`/`audio`/`embeddedContext`）、`mcpCapabilities`（`http`，可选 `sse`）、`sessionCapabilities`（`list`/`fork`/`resume`/`close`/`delete`/`additionalDirectories` 中已实现者）、`agentCapabilities.auth`（`authMethods`；无交互鉴权时为空数组）。其中 `sessionCapabilities.fork` 在 SDK 中标注为 UNSTABLE，声明它 SHALL 以本实现覆盖其**全部**请求参数为前提（含对不支持参数的显式拒绝）。目录能力（`list`/`delete`）SHALL 与宿主实际能提供的目录能力一致 —— 宿主不具备时 MUST NOT 声明。

#### Scenario: 不声明未实现的能力

- **WHEN** 某能力（如 `sessionCapabilities.additionalDirectories`）尚未实现
- **THEN** `initialize` 响应中该能力字段 SHALL 省略或为 `null`
- **AND** 对应的 client 请求 MUST NOT 被接受（返回 JSON-RPC 错误）

#### Scenario: prompt 内容按能力门控

- **WHEN** agent 声明 `promptCapabilities.image: true`
- **THEN** client 发送含 `ContentBlock::Image` 的 prompt SHALL 被接受
- **AND** 未声明的类型（如 `audio`）进入时 SHALL 返回明确错误或降级（见 `acp-prompt-content`）

#### Scenario: 目录能力已实现才声明

- **WHEN** agent 已实现 `session/list`、`session/delete`、`session/fork`，且宿主提供目录成员
- **THEN** `initialize` 响应 SHALL 含 `sessionCapabilities.list`、`.delete`、`.fork`
- **AND** 三者对应的请求 SHALL 可被接受（见 `acp-session-catalog`）
- **AND** 未实现的 `additionalDirectories` SHALL 仍不被声明

#### Scenario: 宿主不具备目录能力时不声明

- **WHEN** 宿主未提供 `listPersistedSessions` / `deleteSession`（例如仅由 agent HTTP 平面支撑的远端宿主）
- **THEN** `initialize` 响应 MUST NOT 声明 `sessionCapabilities.list` / `.delete`
- **AND** 若 client 仍调用它们，agent SHALL 返回明确的 JSON-RPC 错误（MUST NOT 静默失败）

### Requirement: 会话生命周期映射到 AgentSession

agent SHALL 将 ACP 会话方法映射到 `AgentSessionHost`/`AgentSession`：`session/new` → `Host.create`，`session/load` → 恢复并回放，`session/resume` → 恢复不回放，`session/close` → 关闭并释放，`session/prompt` → `dispatch({type:"send"})`，`session/cancel` → `dispatch({type:"stop"})`，`session/set_mode` → `dispatch({type:"mode.set"})`，`session/list` → `Host.listPersistedSessions`，`session/delete` → `Host.deleteSession`，`session/fork` → 源会话的 `dispatch({type:"session.clone"})` 并把该会话的映射重键到返回的新会话 id。`sessionId` ↔ 一个 live `AgentSession` 的映射 SHALL 由 agent 持有，且其键 SHALL 是磁盘会话 id（见 `acp-session-catalog` 的「会话标识一律使用磁盘会话 id」）。

#### Scenario: load 回放历史

- **WHEN** client 调用 `session/load`（`loadSession` 为 true）指向一个已持久化的会话
- **THEN** agent SHALL 通过 `session/update` 回放历史消息（user/agent/tool）后再返回 load 结果
- **AND** 回放期间 MUST NOT 触发模型调用

#### Scenario: resume 不回放

- **WHEN** client 调用 `session/resume` 指向一个已存在的会话
- **THEN** agent SHALL 恢复上下文、重连 MCP、直接返回，MUST NOT 回放历史

#### Scenario: fork 复用同一会话订阅

- **WHEN** client 调用 `session/fork` 且分支成功
- **THEN** agent SHALL 保持同一条到 AgentSession 的订阅，仅把该会话的 id 由其源 id 改为新 id
- **AND** MUST NOT 为新旧 id 各保留一条订阅（否则事件会双发）

#### Scenario: delete 不要求先打开会话

- **WHEN** client 调用 `session/delete` 指向一个本进程未打开过的已持久化会话
- **THEN** agent SHALL 经 `Host.deleteSession` 删除，MUST NOT 先 `Host.create`

### Requirement: prompt turn 以 stop reason 收束

每次 `session/prompt` SHALL 在有界时间内以 ACP `StopReason` 收束。agent SHALL 将 AgentSession 的终态映射为 stop reason：正常完成 → `end_turn`，运行以 `finishReason === "length"` 结束 → `max_tokens`，因工具调用续轮耗尽单轮模型请求预算 → `max_turn_requests`，用户取消 → `cancelled`，拒绝 → `refusal`。运行以 `error` 结束时，agent SHALL 在返回前通过 `notice`（client 声明 `session.notices` 时）或一条 `agent_message_chunk` 暴露错误文本，MUST NOT 静默返回 `end_turn`。挂起的审批/elicitation SHALL 在超时、客户端断开或 `session/cancel` 时结算，使 prompt 不会无限等待。

#### Scenario: 正常完成

- **WHEN** 一次 prompt 的运行以 `completed` 结束
- **THEN** `session/prompt` 响应 SHALL 为 `{ stopReason: "end_turn" }`

#### Scenario: 输出上限映射为 max_tokens

- **WHEN** 运行的 finish reason 为 `length`
- **THEN** 响应 SHALL 为 `{ stopReason: "max_tokens" }`

#### Scenario: 达到迭代上限

- **WHEN** 运行因工具调用续轮耗尽 `maxIterations` 预算而终止
- **THEN** 响应 SHALL 为 `{ stopReason: "max_turn_requests" }`
- **AND** 一个恰好用完预算但正常收尾的轮次 MUST NOT 被误报为 `max_turn_requests`

#### Scenario: 运行失败对客户端可见

- **WHEN** 运行以 `error` 结束
- **THEN** agent SHALL 先发送一条携带错误文本的 `notice`（声明了 `session.notices`）或 `agent_message_chunk`
- **AND** 随后 MUST 返回一个明确的结束（`end_turn` 或 JSON-RPC 错误），MUST NOT 让客户端只看到空回复

#### Scenario: 客户端不响应时仍有界

- **WHEN** 一个 prompt 停在审批/elicitation 上，客户端既不回答也不断开，且超过配置的等待上限
- **THEN** agent SHALL 以拒绝/取消结算该交互，并发送一条说明超时的 notice
- **AND** `session/prompt` SHALL 最终收束，MUST NOT 永久占用该会话的 prompt 链

#### Scenario: 连接断开时收束

- **WHEN** ACP 连接在 prompt 进行中断开
- **THEN** agent SHALL 取消该运行并释放会话，MUST NOT 留下永久挂起的 prompt

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

