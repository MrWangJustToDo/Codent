# Spec Delta

## ADDED Requirements

### Requirement: MCP server 的 elicitation 经 client 表单作答

当 client 在 `initialize` 声明了 `elicitation.form` 能力，**且**会话宿主接受 hook 时，agent SHALL 为
每个会话向 core 提供 `mcpElicit` hook，把 MCP server 的 `elicitation/create` 转成一次 ACP
`elicitation/create`（form），并把 client 的作答映射回 MCP 的三种 action 之一。

两个条件缺一不可：core 以「有无 hook」作为是否向 server 声明 `elicitation` 的唯一依据，所以提供 hook
等于声称「用户可以被问到」。client 未声明该能力时 agent MUST NOT 提供 hook（不定义成总是拒绝的 stub）；
宿主明确拒绝该 hook 时（`AgentSessionHost.acceptMcpElicit === false`，例如 remote session host —— hook
是可行代码，无法过线）agent MUST NOT 提供 hook，也不得把 hook 交给它而引发 `create` 抛错：那会让每个
`session/new` / `load` / `resume` 都失败，只为了一个本来可以缺失的能力。

hook SHALL 在 `host.create` **之前**构造（MCP server 在 `host.create` 内连接，握手时就要用到该能力），
并在会话 bridge 存在后绑定。请求发送时 SHALL 按调用时刻读取该 bridge 的 handle，而不是在绑定时缓存 id：
`/new` 会保留 handle 而更换磁盘 id，`session/fork` 会把同一个 bridge 重键到新 handle
（`bridge.acpId = newId`），读取式绑定使 clone 的提问天然归属 clone，MUST NOT 继续向源会话的 id 发请求。

hook MUST NOT 抛出，也 MUST NOT 悬挂：会话尚不存在或已关闭时 SHALL 返回 `decline`（不发请求）；
请求已经发出后被中止——超时、`session/cancel`、连接关闭、client 拒绝或返回非 form 结果——SHALL 返回
`cancel`。等待时长 SHALL 与审批 / `ask_user` 使用同一个 `interactionTimeoutMs`，且该请求 SHALL 与其它
挂起交互一同被取消/关闭中止；由于 client 对取消通知的响应不可依赖，到期 SHALL 由本地判定结束，
MUST NOT 依赖「abort 之后请求自己会结束」。

MCP 的 URL 模式请求（`mode: "url"`，用户被送去一个 URL 在带外作答）SHALL 返回 `decline`，
MUST NOT 折叠成一个空表单。

#### Scenario: client 声明 form elicitation

- **WHEN** client 在 `initialize` 声明 `elicitation.form`，宿主接受 hook，且会话配置了一个请求用户输入的 MCP server
- **THEN** 会话创建时 SHALL 带上 `mcpElicit`，core SHALL 在 MCP 握手时向该 server 声明 `elicitation`
- **AND** `session/new`、`session/load`、`session/resume` 三条路径 SHALL 都带上它
- **AND** server 的 `elicitation/create` 消息与 `requestedSchema` SHALL 到达 client 的同一次 `elicitation/create`
- **AND** 该请求的 `sessionId` SHALL 是 client 用于该会话的 ACP handle

#### Scenario: client 未声明 elicitation

- **WHEN** client 未声明 `elicitation.form`
- **THEN** agent MUST NOT 提供 `mcpElicit`（不定义成总是拒绝的 stub）
- **AND** core SHALL 不向 MCP server 声明该能力，询问该能力的请求 SHALL 得到协议错误

#### Scenario: 宿主不接受 hook

- **WHEN** 会话宿主声明 `acceptMcpElicit === false`，而 client 声明了 `elicitation.form`
- **THEN** agent MUST NOT 提供 `mcpElicit`，`session/new` / `load` / `resume` SHALL 正常成功
- **AND** MUST NOT 把 hook 交给该宿主而让其 `create` 抛错

#### Scenario: 会话尚不存在或已结束

- **WHEN** hook 在 ACP handle 绑定前被调用，或所属会话已关闭
- **THEN** SHALL 返回 `decline`，MUST NOT 抛错或悬挂
- **AND** MUST NOT 向 client 发出 `elicitation/create`

#### Scenario: client 不回答

- **WHEN** client 在同一 `interactionTimeoutMs` 内没有作答（即使它忽略取消通知）
- **THEN** 到期 SHALL 由本地判定返回 `cancel`，且不得留下挂起的等待者

#### Scenario: 请求进行中被取消或关闭

- **WHEN** 一条已发出的请求在等待期间遇到 `session/cancel` / 会话关闭 / 连接断开
- **THEN** SHALL 返回 `cancel`；此后 client 若才提交 `accept`，MUST NOT 把该 `content` 当作同意交回 server

#### Scenario: fork 后的提问归属

- **WHEN** 会话被 `session/fork` 重键到新 handle 后，MCP server 请求用户输入
- **THEN** 该 `elicitation/create` SHALL 以 **clone 的** handle 作用域发出
- **AND** MUST NOT 使用源会话的 id（那会把对话框挂到被恢复的源会话上）

#### Scenario: URL 模式的请求

- **WHEN** MCP server 发来 `mode: "url"` 的 `elicitation/create`
- **THEN** SHALL 返回 `decline`，MUST NOT 向 client 发出一条没有字段的空表单请求

#### Scenario: client 作答映射

- **WHEN** client 返回 `accept` 且带 `content`
- **THEN** MCP 侧 SHALL 收到 `{ action: "accept", content }`
- **AND** `decline` / 非标准 action SHALL 映射为 `decline`、`cancel` SHALL 映射为 `cancel`，
      且 MUST NOT 携带 `content`

#### Scenario: schema 需满足 ACP 的严格校验

- **WHEN** server 的 `requestedSchema` 含 ACP 未定义的 `format`、或使用 `enum` + `enumNames`
- **THEN** 未定义的 `format` SHALL 被剔除（否则整条请求会被 client 的校验拒绝，用户看不到表单）
- **AND** `enumNames` SHALL 转成等价的 `oneOf` const/title，使选项标签不丢失
