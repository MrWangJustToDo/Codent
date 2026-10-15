## MODIFIED Requirements

### Requirement: ACP agent 以 stdio 提供 JSON-RPC 服务

系统 SHALL 提供一个 agent 侧 ACP 入口（`codent acp`），通过 `@agentclientprotocol/sdk` 在 **stdio** 上提供 ACP v1 的 JSON-RPC 服务，可作为子进程被 ACP client（编辑器或 IM bot）拉起。该进程 SHALL 自带模型配置解析（复用 CLI local bootstrap：`.agents/config/models.json` / `.env`），MUST NOT 要求 client 传入模型或密钥；工作区根 SHALL 在握手时固定，MUST NOT 由后续请求的 `cwd` 改变（见下）。

#### Scenario: 握手成功

- **WHEN** client 拉起 `codent acp` 并发送 `initialize`（`protocolVersion: 1`）
- **THEN** agent SHALL 返回 `protocolVersion: 1`、`agentInfo`（name/title/version）与 `agentCapabilities`
- **AND** MUST NOT 向 stdout 写入任何非 JSON-RPC 内容（日志走 stderr/agent log）

#### Scenario: 工作区根在握手时固定，请求的 cwd 仅是提示

- **WHEN** client 发送 `session/new`，`cwd` 与 agent 已固定的工作区根不同
- **THEN** agent SHALL 以**自身固定的根**（进程 `cwd`，或 `createAcpAgent` 的 `rootPath`）创建 AgentSession，MUST NOT 改用该 `cwd`
- **AND** MAY 在 stderr 记一条说明该差异的提示，MUST NOT 因此拒绝请求
- **AND** 返回不透明且唯一的 `sessionId`

备注：会话创建类请求（`new`/`load`/`resume`/`fork`）与 `session/list` 的 `cwd` 都只是同一语义的提示；这与
ACP 的 `additionalDirectories` 不同 —— 后者是**未声明**的能力，因此按「未声明的能力对应的 client 请求 MUST NOT 被接受」被**显式拒绝**（见 `acp-session-catalog`）。裸 `cwd` 则是每种请求类型的必填/可选形状字段，无法“不声明”，所以选“固定根 + 提示”而不是拒绝。

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
