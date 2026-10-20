## RENAMED Requirements

- FROM: `### Requirement: 会话标识一律使用磁盘会话 id`
- TO: `### Requirement: 会话标识使用稳定句柄`

## MODIFIED Requirements

### Requirement: 会话标识使用稳定句柄

agent SHALL 使用一个 client-facing `sessionId` 句柄，并在 `session/new` 时返回它（初始值等于磁盘会话 id `ses_…`）。句柄 SHALL 在会话生命周期内保持稳定：当会话内的 slash 命令（`/clear` / `/clone` / `/resume`）替换底层磁盘会话时，agent SHALL 把该句柄重绑到新的磁盘会话，MUST NOT 让 `session/update` 改用 client 不知道的新 id。`session/list` / `session/delete` SHALL 使用磁盘 id。`session/load` SHALL 接受句柄或磁盘 id；`session/resume`、`session/close`、`session/fork` 在会话 live 时 SHALL 接受句柄；冷恢复（非 live）的 `session/resume` / `session/fork` SHALL 使用磁盘 id。内部 `sessionId → live 会话` 的映射 SHALL 同时记录句柄与当前磁盘 id，`session_info_update` SHALL 在 `_meta.diskSessionId` 中报告当前磁盘 id。MUST NOT 把 agent 运行时 id 当作 ACP `sessionId` 暴露给 client。

#### Scenario: new 返回的句柄可用于 load

- **WHEN** client 调用 `session/new` 得到 `sessionId`，随后以同一个 `sessionId` 调用 `session/load`
- **THEN** agent SHALL 定位到同一会话并成功回放，MUST NOT 报会话未知

#### Scenario: new 返回的句柄可用于 resume 与 close

- **WHEN** client 以 `session/new` 返回的 `sessionId` 调用 `session/resume`，随后调用 `session/close`
- **THEN** 两次调用 SHALL 都定位到同一会话

#### Scenario: slash 命令替换会话后句柄保持稳定

- **WHEN** client 在会话内触发 `/clear`、`/clone` 或 `/resume`，底层磁盘会话 id 发生变化
- **THEN** 该会话的 ACP 句柄 SHALL 保持不变
- **AND** 后续 `session/update` SHALL 继续使用该句柄
- **AND** `session_info_update._meta.diskSessionId` SHALL 报告新的磁盘 id

#### Scenario: list 返回的 id 可用于其余方法

- **WHEN** client 以 `session/list` 返回的任一磁盘 `sessionId` 调用 `session/delete` 或 `session/load`
- **THEN** agent SHALL 定位到该会话，MUST NOT 因 id 空间不匹配而报"会话未知"

#### Scenario: load 接受句柄或磁盘 id

- **WHEN** client 用 `session/new` 得到的句柄（可能已重绑）或 `session/list` 得到的磁盘 id 调用 `session/load`
- **THEN** 两者 SHALL 都能定位到对应会话

### Requirement: 会话目录以磁盘会话为真源

agent SHALL 通过 `session/list` 返回**工作区磁盘上的可恢复会话**目录，而非仅本进程内的 live 会话；每条记录 SHALL 映射为 ACP `SessionInfo`（`sessionId`、`cwd`、`title`、`updatedAt`），`cwd` SHALL 为该会话的工作区根绝对路径，`updatedAt` SHALL 为 ISO 8601，`title` 缺失时 MAY 省略或为 `null`。`session/list` 携带 `cwd` 时 SHALL 只返回该根下的会话；未携带时 SHALL 返回进程默认根下的会话。列举 SHALL 复用 core 的会话列举能力（只读每个日志的最后一行状态），MUST NOT 在 ACP 层拼接存储路径。单条记录的 `updatedAt` 非法或缺失 SHALL 被跳过，MUST NOT 使整个 `session/list` 失败。

#### Scenario: 列表来自磁盘

- **WHEN** client 调用 `session/list`，且工作区内有由本进程创建过的会话与由更早进程创建的会话
- **THEN** 两者 SHALL 都出现在响应中
- **AND** 排序 SHALL 与 core 列举的 `updatedAt` 降序一致

#### Scenario: 空目录

- **WHEN** 工作区内没有任何已持久化会话
- **THEN** 响应 SHALL 为 `{ sessions: [] }`，MUST NOT 报错

#### Scenario: 请求带 cwd 时过滤

- **WHEN** `session/list` 的 `cwd` 与会话的工作区根不同
- **THEN** 响应 SHALL 只包含 `cwd` 匹配的会话
- **AND** 未带 `cwd` 时 SHALL 只列进程默认根下的会话

#### Scenario: 单条坏记录不拖垮整页

- **WHEN** 某条会话的 `updatedAt` 缺失或无法解析
- **THEN** 该条 SHALL 被跳过，其余会话 SHALL 正常返回
- **AND** MUST NOT 因 `toISOString()` 抛错而使 `session/list` 失败

### Requirement: 会话删除

agent SHALL 通过 `session/delete` 删除会话。删除 SHALL 经 core 的会话存储完成（宿主提供，agent MUST NOT 自行拼接存储路径）。**成功条件 SHALL 为「该会话本进程内 live（已先行关闭）、磁盘文件已删，或该 id 从未存在」**——ACP 要求删除一个已不存在的会话应当成功，因此一个既不 live、磁盘上也没有文件的 id SHALL 被视为幂等成功，MUST NOT 返回 not-found。删除 live 会话 SHALL 先行停止在飞运行并注销。

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

#### Scenario: 删除不存在的会话是幂等的

- **WHEN** client 对一个**既非 live、也从未持久化**的 `sessionId` 调用 `session/delete`
- **THEN** 响应 SHALL 成功（目标状态已成立）
- **AND** MUST NOT 返回 not-found

#### Scenario: 删除 live 会话

- **WHEN** 被删会话在本进程内存在 live 会话
- **THEN** agent SHALL 先行停止在飞运行、注销该会话，再删除持久化数据
- **AND** 该 `sessionId` 之后的 `session/prompt` SHALL 返回会话未知错误

### Requirement: 会话分支

agent SHALL 通过 `session/fork` 以既有会话为上下文创建一个新会话，源会话 SHALL 保持不变且仍可 resume。分支 SHALL 复用 core 的会话克隆语义（复制消息与模型设置），MUST NOT 截断历史（ACP 的 fork 请求不携带分支点）。源会话 MAY 不在本进程内 live：agent SHALL 先按 `session/resume` 的语义恢复它（不回放）再 clone。fork 完成后 SHALL 把同一 bridge 重绑到新磁盘 id：更新句柄、`bridges` 键、`runtime.bind(newId)`（client-env）并重置 `replayed`；clone dispatch 期间 SHALL 抑制投影，MUST NOT 以源 id 发出新会话的更新。

#### Scenario: 分支产生新会话

- **WHEN** client 对某 `sessionId` 调用 `session/fork`
- **THEN** 响应 SHALL 返回一个与源不同的新 `sessionId`
- **AND** 新会话的既有消息 SHALL 等于源会话在分支时刻的消息

#### Scenario: 源会话不受影响

- **WHEN** 一次 fork 完成
- **THEN** 源会话仍可通过 `session/resume` 继续，其持久化数据未被改写

#### Scenario: 分支后的事件归属

- **WHEN** fork 完成且 client 代表新会话继续 prompt
- **THEN** `session/update` SHALL 以新句柄送达
- **AND** 源 `sessionId` MUST NOT 再收到该会话的运行事件
- **AND** clone 期间 MUST NOT 有更新以源 id 发出

#### Scenario: 运行中拒绝

- **WHEN** 源会话有在飞运行时调用 `session/fork`
- **THEN** agent SHALL 返回错误且不创建任何东西，错误信息 SHALL 提示先停止运行

#### Scenario: 非 live 源先恢复再分支

- **WHEN** client 对一个由 `session/list` 返回、本进程未打开过的会话调用 `session/fork`
- **THEN** agent SHALL 先恢复该源会话（不回放），再 clone
- **AND** 响应 SHALL 返回新会话，MUST NOT 因源不在内存而报"会话未知"

#### Scenario: client-env 下 fork 重绑环境

- **WHEN** `--client-env` 开启时 fork 成功
- **THEN** 后续该会话的 `fs/*` / `terminal/*` 请求 SHALL 携带新句柄对应的 sessionId
- **AND** MUST NOT 继续携带源会话的 sessionId

## ADDED Requirements

### Requirement: 模型重选不改变模型元数据

重选当前模型（值不在 catalog 中，或与当前模型相同）SHALL 是一个 no-op：agent MUST NOT dispatch `model.set`，也 MUST NOT 用 `null` 清空 `modelInfo`（能力、上下文窗口与价格）。只有真正切换到不同模型时才 SHALL 重新解析元数据。

#### Scenario: 重选当前值不清空能力

- **WHEN** client 从 `configOptions.model` 选择与当前模型相同的值（包括不在 catalog 中的当前模型）
- **THEN** `modelInfo`、能力与上下文窗口 SHALL 保持不变
- **AND** MUST NOT 发生一次 `model.set` 或一次 metadata 清空
