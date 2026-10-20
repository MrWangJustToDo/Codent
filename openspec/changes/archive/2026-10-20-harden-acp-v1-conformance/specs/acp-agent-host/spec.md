## MODIFIED Requirements

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
