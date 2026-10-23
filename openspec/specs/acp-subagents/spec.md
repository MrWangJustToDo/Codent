# acp-subagents Specification

## Purpose

ACP 客户端在同一个父会话里通过 `subagents` 能力看到被委派的子代理：公告、工作状态、child transcript 与 task 行的结果。这个能力固定三件事：能力协商决定是否允许任何 child 流量，child 的 id 只是父会话的资源而不可以当顶层会话使用，以及子代理事件如何投影成协议帧而不改变 core 的状态、取消与日志。

## Requirements
### Requirement: 子代理能力协商门控全部 child 流量

`initialize` SHALL 记录 `clientCapabilities.subagents`：对象（包括 `{}`）表示客户端支持子代理，
缺失或 `null` 表示不支持。客户端不支持时，host MUST NOT 发送任何 child 流量——包括父会话上的
`subagent_update`、child 的 `session/update`、以及 `session_message` / `session_message_chunk`；
父会话的 `task` 工具行 MUST 照常收尾（它是普通的工具行投影，不受该能力门控）。
客户端支持时，任何 child 流量 MUST 出现在该 child 的首次 `subagent_update` 之后。
（agent 自身的 `agentCapabilities` 声明仍由 `acp-agent-host` 的"能力协商如实声明"约束；本条只约束 client 能力对 child 流量的门控。）

#### Scenario: 不支持的客户端只看到 task 行

- **WHEN** 客户端在 `initialize` 未声明 `subagents`
- **AND** 父会话执行一次 `task`
- **THEN** 客户端收到 task 行的 `tool_call` / `tool_call_update`（含格式化结果）
- **AND** 收不到任何 `subagent_update`、child `session/update` 或 `session_message`

#### Scenario: 空对象表示支持

- **WHEN** 客户端声明 `subagents: {}`
- **THEN** 父会话在 child 启动后收到 `subagent_update`
- **AND** 后续 child 的文本 / 思考 / 工具调用以 child 的 sessionId 投递

#### Scenario: 公告先于任何 child 流量

- **WHEN** 一个 child 首次出现在 `subagents` 快照中
- **THEN** host 先向父会话发送该 child 的 `subagent_update`
- **AND** 之后才 attach child projector（其 retained 消息在公告之后才被投递）

### Requirement: 子代理公告与工作状态快照

host SHALL 为 `subagents` 快照中 `parentTaskToolCallId` 非空的 child（用户可见的 task 委派）在
父会话上维护一个 ACP session id（即 child 的 agent id），并在首次出现时发送一次 `subagent_update`
公告；后续快照只发送变化的字段（patch），MUST NOT 重复公告。内部 worker（compaction / memory
summarizer 等没有 `parentTaskToolCallId` 的 child）MUST NOT 公告——它们是父代理的实现细节，不是
客户端可观察的委派。`title` SHALL 取任务的 description，缺失时回退到 name 或 task prompt 摘要；
`capabilities` SHALL 省略（本变更不开放 child mutation）。

`state` SHALL 由 child 的 `AgentStatus` 映射为整对象快照：`running` / `thinking` / `responding` /
`compacting` → `running`；`waiting` / `awaiting_user` → `requires_action`；`completed` →
`idle` + `stopReason: "end_turn"`；`aborted` → `idle` + `stopReason: "cancelled"`；`error` →
`idle` + `stopReason: "error"`；`idle` → `idle`（无 stopReason）。任务的 `taskPhase`
（`running` / `summary` / `limit`）MUST NOT 作为 state 的一部分，SHALL 放在 `_meta.taskPhase`：
`limit` 是任务结果而非 child 的工作状态（此时 child 的 status 已是 `completed`），`summary` 阶段
仍在由父侧生成进度报告。child 被销毁时 host MUST NOT 伪造 `idle`。

#### Scenario: 首次公告

- **WHEN** 父会话的 `subagents` 快照第一次包含某 child
- **THEN** 父会话收到一次 `subagent_update`，带 title / description
- **AND** `state` 是该行当前的映射状态（运行中的 child 即 `running`，恢复时可能是终态）
- **AND** 其中 `capabilities` 未声明（child mutation 不可用）

#### Scenario: 需要用户处理

- **WHEN** child 的状态是 `waiting` 或 `awaiting_user`
- **THEN** 其 `subagent_update` 的 `state` 是 `requires_action`

#### Scenario: 结束状态带 stopReason

- **WHEN** child 以 `completed` / `aborted` / `error` 结束
- **THEN** `state` 分别为 `idle` + `end_turn` / `idle` + `cancelled` / `idle` + `error`

#### Scenario: taskPhase 不冒充工作状态

- **WHEN** child 的 status 是 `completed` 且 `taskPhase` 为 `limit`（预算耗尽后正在写进度报告）
- **THEN** `state` 是 `idle` + `stopReason: "end_turn"`
- **AND** `_meta.taskPhase` 为 `limit`

#### Scenario: 重复快照不重复公告

- **WHEN** 同一 child 的 `subagents` 行在多次状态变化中出现
- **THEN** 只有第一次是公告，其余是 patch（仅变化字段）

#### Scenario: 内部 worker 不出现在客户端

- **WHEN** 父代理启动一个 compaction / memory summarizer（没有 `parentTaskToolCallId`）
- **THEN** 父会话收不到它的 `subagent_update`
- **AND** 客户端看不到该 child 的会话

### Requirement: 子代理 transcript 与 task 结果投影

host SHALL 为每个被公告的 child 建立独立的 projector，把 child 的 assistant 文本、thinking、
工具调用（以及其自身会话通道的更新，如 usage）以 child 的 sessionId 投递；child 的 task prompt（其首个 user 消息）SHALL 以
`session_message` 发布（`senderSessionId` = 父、`recipientSessionId` = child，`messageId` 由 task
toolCallId 派生），MUST NOT 伪装成该 child 的用户消息（`user_message_chunk`）。
child 的 projector MUST NOT 订阅 `interaction`（子代理没有审批与 `ask_user`）。

父会话 `task` 行的最终 content SHALL 使用 core 的 task 结果格式化（摘要 + 状态行），MUST NOT 发送
原始结果对象；摘要流的增量 SHALL 复用同一行的 `tool_call_update` content，且因为 ACP 的工具
content 是**替换**语义，每次增量 MUST 发送累计后的整段文本（不存在 append 形式），MUST NOT 新增
消息行。最终结果与摘要流结束的先后顺序 MUST NOT 导致同一段最终文本被发送两次；一旦该行已经发送过
最终结果，之后到达的摘要增量 MUST 被丢弃（否则会用部分文本覆盖结果）。非 task 工具结果的投影保持不变。

`session/load` / `resume` SHALL 只公告进程内仍然存活的 child，并可在不回放历史的前提下 attach
其 projector 以继续接收实时更新；MUST NOT 回放 child 历史（child 没有磁盘会话）。

#### Scenario: child 的工具调用归属 child

- **WHEN** child 执行一次 `read_file`
- **THEN** `tool_call` / `tool_call_update` 携带 child 的 sessionId
- **AND** 父会话的标识不用于该帧

#### Scenario: task prompt 是会话消息

- **WHEN** 父代理委派一个 task，child 开始运行
- **THEN** child 的 prompt 以 `session_message` 出现（sender = 父、recipient = child）
- **AND** 不以 `user_message_chunk` 冒充 child 的用户发言

#### Scenario: task 结果可读

- **WHEN** task 以 `reachedLimit=true` 或 `aborted=true` 结束
- **THEN** task 行的最终 content 含摘要与状态行（如 `limit reached` / `cancelled`）
- **AND** 客户端不再收到该结果的原始 JSON 对象

#### Scenario: 摘要只有一处

- **WHEN** task 摘要流产生多段增量
- **THEN** 每次更新都携带累计后的整段文本，且落在 task 行的 content 上
- **AND** 不存在第二条消息行承载同一段摘要

#### Scenario: 流结束与结果到达不重复

- **WHEN** 摘要流结束与 task 结果到达的先后顺序互换
- **THEN** task 行的最终 content 仍只有一份（格式化结果）
- **AND** 不出现两段相同的最终文本
- **AND** 结果之后到达的摘要增量被丢弃，不会覆盖终态

#### Scenario: 恢复不回放 child 历史

- **WHEN** 客户端 `session/load` 一个仍存活 child 的父会话
- **THEN** 该 child 被公告
- **AND** 不重放它过去的消息

### Requirement: 子代理会话是父会话的资源

child 的 ACP session id SHALL 只用于 `subagent_update`、child 自身的 `session/update` 与
`session_message`；它 MUST NOT 作为顶层会话句柄：`session/list` 不包含 child；
`session/load` / `resume` / `prompt` / `fork` 以 child id 调用时 SHALL 以 `invalid params` 失败；
`session/close` 以 child id 调用时 MAY 按已关闭幂等返回，`session/delete` MAY 按未知会话幂等返回，
但两者 MUST NOT 销毁 child。host SHALL 在进入会话存储前识别 child id（已公告的 child 映射，或 `AgentSessionHost.list()` 中
`parentId` 非空的条目都是判据）——存储层的 `deleteSession` 以 **agent id** 查 live agent，直接透传
child id 会销毁它；`load`/`resume`/`fork` 也会把 child id 当磁盘 id 去恢复。其余顶层会话请求（`set_mode` /
`set_config_option` / `set_model` 等）以 child id 调用时 SHALL 报 unknown session。父会话关闭时
host SHALL 停止该父会话下所有 child projector 并释放映射，child 的销毁由 core 负责。host MUST NOT
把 child id 当作磁盘会话 id 解析（child 没有磁盘会话）。

#### Scenario: 目录不含 child

- **WHEN** 一个父会话拥有运行中的 child
- **THEN** `session/list` 只返回磁盘会话
- **AND** child 的 id 不出现在列表中

#### Scenario: 顶层方法拒绝 child

- **WHEN** 客户端对 child id 调用 `session/load`、`resume`、`prompt` 或 `fork`
- **THEN** 请求以 `invalid params` 失败
- **AND** child 继续运行

#### Scenario: close / delete 不销毁 child

- **WHEN** 客户端对 child id 调用 `session/close` 或 `session/delete`
- **THEN** 请求可以按幂等语义成功（或按未知会话报错）
- **AND** child 没有被 host 销毁，仍继续运行

#### Scenario: 关闭父会话

- **WHEN** 客户端关闭父会话
- **THEN** 该父会话下的 child projector 停止，客户端不再收到它们的更新
- **AND** child 的销毁交给 core，host 不调用 `host.destroy(childId)`
