# acp-session-mcp Specification

## Purpose
TBD - created by archiving change add-session-mcp-servers. Update Purpose after archive.
## Requirements
### Requirement: ACP session/new 接入 client 下发的 MCP 服务器

agent SHALL 读取 `session/new` 的 `mcpServers` 参数，把 ACP `McpServer` 映射为 core 的服务器配置并随会话创建下发，且 SHALL 在 `initialize` 中按实现如实声明 `mcpCapabilities`。ACP 的 `McpServer` 联合有四种形态（`stdio` / `http` / `sse` / `acp`）。`McpCapabilities` 没有 stdio 位（只有 `http` / `sse` / `acp`）：stdio 是基线传输、无需声明也 SHALL 被支持，`http` 与 `sse` SHALL 被声明为支持。`session/load` / `session/resume` 命中一个**已 live** 的会话时，agent SHALL 比较请求的 `mcpServers` 与当前列表：相同（或都为空）时 SHALL 复用该会话；不同时 SHALL 返回 `invalidParams`，MUST NOT 静默忽略该列表后复用旧会话。

#### Scenario: stdio 服务器被连接

- **WHEN** client 发送 `session/new`，`mcpServers` 含一个 `command` / `args` / `env` 的 stdio 服务器
- **THEN** 该会话 SHALL 连接该服务器，其工具 SHALL 以 `mcp__<name>_<tool>` 可用
- **AND** ACP 的 `env`（`{name,value}[]`）SHALL 被转换为 core 的 `Record<string,string>`

#### Scenario: http 服务器被连接

- **WHEN** client 发送 `session/new`，`mcpServers` 含一个 `url` / `headers` 的 http 服务器
- **THEN** agent SHALL 连接该服务器，`headers` SHALL 被转换后传入

#### Scenario: sse 服务器被连接且被如实声明

- **WHEN** client 发送 `session/new`，`mcpServers` 含一个 `type: "sse"` 的服务器
- **THEN** agent SHALL 连接该服务器（core 的 MCP transport 支持 sse）
- **AND** `initialize` 的 `mcpCapabilities.sse` SHALL 为 `true`

#### Scenario: 能力位与实现一致

- **WHEN** agent 已接入 `session/new` 的 `mcpServers`
- **THEN** `initialize` 的 `mcpCapabilities` SHALL 为 `{ http: true, sse: true }`
- **AND** `acp` SHALL 不被声明（该形态未实现）

#### Scenario: 无 mcpServers 时行为不变

- **WHEN** client 发送 `session/new` 且不含 `mcpServers`（或为空数组）
- **THEN** agent SHALL 回落到工作区配置文件，行为与本 change 之前一致

#### Scenario: live 会话的 mcpServers 不被静默替换

- **WHEN** `session/load` / `session/resume` 命中一个已 live 的会话，且请求的 `mcpServers` 与当前列表不同
- **THEN** agent SHALL 返回 `invalidParams`，说明无法在 live 会话上替换 MCP 服务器
- **AND** MUST NOT 静默复用旧会话

#### Scenario: live 会话的相同列表可复用

- **WHEN** `session/load` / `session/resume` 命中一个已 live 的会话，且请求的 `mcpServers` 与当前列表相同（或都为空）
- **THEN** agent SHALL 复用该会话
- **AND** MUST NOT 重建第二个 bridge

### Requirement: MCP 参数校验错误必须是显式失败
当 `mcpServers` 的条目不被支持或形状不合法时，agent SHALL 以 JSON-RPC 错误拒绝该请求，
MUST NOT 静默跳过该条目。至少覆盖：`type` 为未实现的形态（`acp`）、`name` 为空、`name` 重复、
stdio 条目缺 `command`、http/sse 条目缺 `url`。

#### Scenario: 未实现的 acp 形态
- **WHEN** 一个条目的 `type` 为 `"acp"`
- **THEN** `session/new` SHALL 返回 JSON-RPC 错误，说明该 transport 不被支持
- **AND** MUST NOT 静默忽略该条目后照常创建会话

#### Scenario: 缺 command 的 stdio 条目
- **WHEN** 一个 stdio 条目没有 `command`
- **THEN** `session/new` SHALL 返回 JSON-RPC 错误，且 MUST NOT 创建会话

#### Scenario: 重复名称
- **WHEN** 两个条目使用同一个 `name`
- **THEN** `session/new` SHALL 返回 JSON-RPC 错误，且 MUST NOT 创建会话

#### Scenario: 恢复与加载同样可按会话指定服务器
- **WHEN** `session/load` 或 `session/resume` 携带 `mcpServers`（`load` 的该字段在 ACP 类型中必填，`resume` 为可选）
- **THEN** agent SHALL 按 `session/new` 相同的方式映射并随会话创建下发（显式列表取代工作区配置文件）
- **AND** 空列表或无列表时 SHALL 回落工作区配置文件
- **AND** 条目不合法时 SHALL 返回 JSON-RPC 错误且不创建会话

备注：`load` / `resume` 与 `session/new` 一样经由 `Host.create`（带 `resumeSessionId`）建立
agent，所以服务端可以真实生效；这与 `session/fork` 复用源会话的 live agent、确实无法更换服务器不同。

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
