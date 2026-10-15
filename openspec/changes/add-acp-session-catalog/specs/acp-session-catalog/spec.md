## ADDED Requirements

### Requirement: 会话标识一律使用磁盘会话 id

agent SHALL 在一切 ACP 会话方法中使用**磁盘会话 id**（`ses_…`）作为 `sessionId`：`session/new` 的响应
SHALL 返回它，`session/load` / `session/resume` / `session/fork` / `session/close` / `session/delete` /
`session/prompt` / `session/set_mode` 等出站请求与 `session/update` 通知 SHALL 携带它。
MUST NOT 把 agent 运行时 id 当作 ACP `sessionId` 暴露给 client。内部 `sessionId → live 会话` 的映射
SHALL 按该 id 建立，使任一由 `session/new` 或 `session/list` 得到的 id 都能直接用于其余方法。

#### Scenario: new 返回的 id 可用于 load

- **WHEN** client 调用 `session/new` 得到 `sessionId`，随后以同一个 `sessionId` 调用 `session/load`
- **THEN** agent SHALL 定位到同一会话并成功回放，MUST NOT 报会话未知

#### Scenario: new 返回的 id 可用于 resume 与 close

- **WHEN** client 以 `session/new` 返回的 `sessionId` 调用 `session/resume`，随后调用 `session/close`
- **THEN** 两次调用 SHALL 都定位到同一会话

#### Scenario: list 返回的 id 可用于其余方法

- **WHEN** client 以 `session/list` 返回的任一 `sessionId` 调用 `session/delete`
- **THEN** agent SHALL 删除该会话，MUST NOT 因 id 空间不匹配而报"会话未知"

### Requirement: 会话目录以磁盘会话为真源

agent SHALL 通过 `session/list` 返回**工作区磁盘上的可恢复会话**目录，而非仅本进程内的 live 会话；
每条记录 SHALL 映射为 ACP `SessionInfo`（`sessionId`、`cwd`、`title`、`updatedAt`），
`cwd` SHALL 为工作区根的绝对路径，`updatedAt` SHALL 为 ISO 8601，`title` 缺失时 MAY 省略或为 `null`。
列举 SHALL 复用 core 的会话列举能力（只读每个日志的最后一行状态），MUST NOT 在 ACP 层拼接存储路径。

#### Scenario: 列表来自磁盘

- **WHEN** client 调用 `session/list`，且工作区内有由本进程创建过的会话与由更早进程创建的会话
- **THEN** 两者 SHALL 都出现在响应中
- **AND** 排序 SHALL 与 core 列举的 `updatedAt` 降序一致

#### Scenario: 空目录

- **WHEN** 工作区内没有任何已持久化会话
- **THEN** 响应 SHALL 为 `{ sessions: [] }`，MUST NOT 报错

#### Scenario: 请求带 cwd

- **WHEN** `session/list` 的 `cwd` 与 agent 的工作区根不同
- **THEN** agent SHALL 仍以自身工作区根回答（stdio agent 的根在握手时已固定），并 MAY 在 `_meta` 中说明

### Requirement: 会话目录分页

`session/list` SHALL 支持游标分页：响应 SHALL 在还有更多结果时返回 `nextCursor`，请求携带 `cursor` 时
SHALL 仅返回全序中严格晚于该边界行的会话（全序 = `updatedAt` 降序、同值按 `id` 升序）。
游标 MUST 编码该全序的边界（即 `(updatedAt, id)` 复合键），MUST NOT 只用 `updatedAt` ——
否则同一毫秒的两条会话会在页边界上被整页丢弃。游标语义 SHALL 对客户端不透明。

#### Scenario: 首页与次页

- **WHEN** 会话数超过单页上限，client 先以无 `cursor` 请求、再以返回的 `nextCursor` 请求
- **THEN** 两页的 `sessionId` SHALL 不重叠
- **AND** 最后一页 SHALL 不返回 `nextCursor`

### Requirement: 会话删除

agent SHALL 通过 `session/delete` 删除会话。删除 SHALL 经 core 的会话存储完成（宿主提供，
agent MUST NOT 自行拼接存储路径）。**成功条件 SHALL 为「该会话本进程内 live（已先行关闭）或磁盘文件已删」**
—— 一个刚由 `session/new` 创建、尚未落盘的会话（`ensureSessionData()` 只在内存里 mint 了 id）
在磁盘上没有文件，删除它 SHALL 视为成功，MUST NOT 回「不存在」。仅当该会话**既不 live、磁盘上也无文件**时
才 SHALL 返回 not-found。

#### Scenario: 删除已持久化会话

- **WHEN** client 对 `session/list` 返回的 `sessionId` 调用 `session/delete`
- **THEN** 该会话的文件 SHALL 被移除，随后的 `session/list` MUST NOT 再包含它
- **AND** 响应 SHALL 成功

#### Scenario: 删除刚创建尚未落盘的会话

- **WHEN** client 先 `session/new`、随即对该 `sessionId` 调用 `session/delete`（此时磁盘上还没有该会话的文件）
- **THEN** 响应 SHALL 成功（该会话在本进程内 live）
- **AND** MUST NOT 返回 not-found

#### Scenario: 删除不需要先打开会话

- **WHEN** client 删除一个本进程从未打开过的已持久化会话
- **THEN** agent SHALL 直接删除成功，MUST NOT 需要先创建/连接一个会话
- **AND** MUST NOT 为此创建 ManagedAgent（不得拉起扩展开销）

#### Scenario: 删除不存在的会话

- **WHEN** client 对一个**既非 live、也从未持久化**的 `sessionId` 调用 `session/delete`
- **THEN** agent SHALL 返回 JSON-RPC 错误（not found），MUST NOT 静默成功

#### Scenario: 删除 live 会话

- **WHEN** 被删会话在本进程内存在 live 会话
- **THEN** agent SHALL 先行停止在飞运行、注销该会话，再删除持久化数据
- **AND** 该 `sessionId` 之后的 `session/prompt` SHALL 返回会话未知错误

### Requirement: 会话分支

agent SHALL 通过 `session/fork` 以既有会话为上下文创建一个新会话，源会话 SHALL 保持不变且仍可 resume。
分支 SHALL 复用 core 的会话克隆语义（复制消息与模型设置），MUST NOT 截断历史
（ACP 的 fork 请求不携带分支点）。

#### Scenario: 分支产生新会话

- **WHEN** client 对某 `sessionId` 调用 `session/fork`
- **THEN** 响应 SHALL 返回一个与源不同的新 `sessionId`
- **AND** 新会话的既有消息 SHALL 等于源会话在分支时刻的消息

#### Scenario: 源会话不受影响

- **WHEN** 一次 fork 完成
- **THEN** 源会话仍可通过 `session/resume` 继续，其持久化数据未被改写

#### Scenario: 分支后的事件归属

- **WHEN** fork 完成且 client 代表新会话继续 prompt
- **THEN** `session/update` SHALL 以新 `sessionId` 送达
- **AND** 源 `sessionId` MUST NOT 再收到该会话的运行事件

#### Scenario: 运行中拒绝

- **WHEN** 源会话有在飞运行时调用 `session/fork`
- **THEN** agent SHALL 返回错误且不创建任何东西，错误信息 SHALL 提示先停止运行

#### Scenario: 分支要求源会话在本进程内可用

- **WHEN** client 对某 `sessionId` 调用 `session/fork`，而该会话在本进程内没有 live bridge
      （例如它是 `session/list` 返回的、由更早进程创建的会话）
- **THEN** agent SHALL 返回 JSON-RPC 错误（会话未知）
- **AND** agent MUST NOT 为该请求创建会话

备注：分支复用源会话的 live agent（服务器等 agent 级配置随源会话固定），所以源必须已在本进程内可用；
“列出未打开的会话 → 直接 fork”不在本变更范围内。


### Requirement: 会话配置选项下发

agent SHALL 在 `session/new` 与 `session/fork` 的响应中携带 `configOptions`，其中 SHALL 含一个
`category: "mode"` 的 `select`（选项为 agent 的模式集合，当前值为该会话的当前模式）。
`session/load` 与 `session/resume` 的响应形状 MUST NOT 因本变更而改变。
模式仍经既有 `session/set_mode` 与 `current_mode_update` 通路同步，该 `configOptions` 项 SHALL 与该通路
保持一致，MUST NOT 成为第二个真源。

#### Scenario: 新会话下发模式选择器

- **WHEN** client 调用 `session/new`
- **THEN** 响应 SHALL 含一个 `category: "mode"` 的 `configOptions` 项，其 `type` 为 `select`
- **AND** 该项的当前值 SHALL 等于响应 `modes.currentModeId`（若同时提供）

#### Scenario: 分支会话下发模式选择器

- **WHEN** client 调用 `session/fork`
- **THEN** 响应 SHALL 含同样的 `category: "mode"` 项

#### Scenario: 模式切换后选择器保持同步

- **WHEN** client 通过 `session/set_mode` 切换到会话**实际接受**的另一个模式
- **THEN** agent SHALL 追加一条 `session/update`（`sessionUpdate: "config_option_update"`），其
      `configOptions` 为**完整**选项集，且 `category: "mode"` 项的当前值 SHALL 等于会话的实际模式
- **AND** 既有的 `current_mode_update` SHALL 照旧送达（本变更不改变该通路）
- **AND** 该更新 SHALL 取自会话状态而非请求参数：会话**拒绝**某模式（如 plan 不可用时）时
      MUST NOT 广播一个并未生效的当前值
- **AND** 重设同一模式 SHALL NOT 重复广播（客户端缓存已正确）

备注：**必须**补这条更新 —— `configOptions` 只随 `session/new` / `session/fork` 响应下发，
没有它客户端的缓存在创建后就永远不再变化。发送的是完整集合（协议的 `ConfigOptionUpdate` 只带
`configOptions`，无增量形态）。

#### Scenario: load 与 resume 形状不变

- **WHEN** client 调用 `session/load` 或 `session/resume`
- **THEN** 响应 MUST NOT 因本变更而新增 `configOptions`（保持既有形状）

### Requirement: 未声明的 additionalDirectories 在每个可携带它的请求上被拒绝

每一个可携带 `additionalDirectories` 的请求 SHALL 以 JSON-RPC 错误拒绝该字段，MUST NOT 静默忽略。
该能力未被声明（agent 只服务握手时获得的那个工作区根），而
`openspec/specs/acp-agent-host/spec.md` 要求「未声明的能力对应的 client 请求 MUST NOT 被接受」。

至少覆盖 `session/new`、`session/load`、`session/resume`、`session/fork` 四者 —— 四者 MUST 共用
同一处判定与同一条错误文本（客户端无需知道自己发的是哪个请求就能匹配该拒绝）。`session/new`
是客户端默认入口，它静默忽略的代价最大：客户端会得到一个“看不见那些路径、却什么都不说”的会话。

#### Scenario: session/new 拒绝额外工作区根

- **WHEN** client 发送 `session/new` 且 `additionalDirectories` 非空
- **THEN** agent SHALL 返回 JSON-RPC 错误，错误文本 SHALL 指明 `additionalDirectories`
- **AND** MUST NOT 创建会话（MUST NOT 静默丢弃该字段后照常创建）

#### Scenario: load / resume 拒绝额外工作区根

- **WHEN** client 发送 `session/load` 或 `session/resume` 且 `additionalDirectories` 非空
- **THEN** agent SHALL 返回 JSON-RPC 错误，且 MUST NOT 创建会话

#### Scenario: fork 拒绝额外工作区根

- **WHEN** client 发送 `session/fork` 且 `additionalDirectories` 非空
- **THEN** agent SHALL 返回 JSON-RPC 错误，且 MUST NOT 创建会话

#### Scenario: 四条路径的拒绝文本一致

- **WHEN** 四个请求各带一次非空 `additionalDirectories`
- **THEN** 四者返回的错误文本 SHALL 完全相同（同一处判定）

备注：`cwd` 仅作提示（根在握手时已固定，与 `session/new` 一致）。`ListSessionsRequest` **不含**
`additionalDirectories`（只有 `cwd?` / `cursor?`），因此 `session/list` 不在本条覆盖内；
`DeleteSessionRequest` 只有 `sessionId`，同样不在内。

### Requirement: session/fork 拒绝无法生效的 mcpServers

`session/fork` SHALL 以 JSON-RPC 错误拒绝非空 `mcpServers`，MUST NOT 静默忽略：
分支会话复用源会话的 live agent（fork 路径**没有** `Host.create`），因此 agent 级的 MCP 服务器
确实无法更换 —— 此时 agent SHALL 以 JSON-RPC 错误拒绝该请求，MUST NOT 静默忽略。

对照：`session/new`、`session/load`、`session/resume` 都各自经 `Host.create` **新建** agent，
因此它们 SHALL **接受并下发** `mcpServers`（见 `add-session-mcp-servers`）—— 拒绝在这三者上会是
对客户端的硬阻断，而不是保护。

#### Scenario: fork 携带非空 mcpServers

- **WHEN** `session/fork` 携带非空 `mcpServers`
- **THEN** agent SHALL 返回 JSON-RPC 错误，MUST NOT 静默忽略
- **AND** MUST NOT 为该请求创建会话
