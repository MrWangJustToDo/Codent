## ADDED Requirements

### Requirement: 通道到 session/update 的投影

agent SHALL 通过订阅 `AgentSession` 的通道（`messages`/`tool`/`summary`/`todos`/`plan`/`mode`/`usage`/`state`/`extensions`/`interaction`）把状态变化投影为 ACP `session/update` 通知。由于 `messages` 通道以**全量** `UIMessage[]` 交付，投影层 SHALL 以**引用相等**做变更检测，并进一步做 **part 级**差分，只发送新增内容；投影层 MUST NOT 修改 `AgentSession` 契约。

#### Scenario: 全量数组中只有一条消息变化

- **WHEN** `messages` 通道推送一个数组，其中仅一条 assistant 消息因流式文本被替换为新对象
- **THEN** 投影层 SHALL 只针对该消息生成更新
- **AND** MUST NOT 重复发送未变化消息对应的内容

#### Scenario: 长会话不随规模放大帧体积

- **WHEN** 会话历史很长且一次事件只新增一个文本片段
- **THEN** 单帧体积 SHALL 与**变化量**成正比，而非与会话总长度成正比

### Requirement: assistant 文本以 agent_message_chunk 增量流式

assistant 文本 SHALL 以 `agent_message_chunk` 逐段发送；同一条 `UIMessage` SHALL 复用同一 `messageId`，新消息 SHALL 使用新 `messageId`。文本增量 SHALL 只包含自上次发送以来**追加**的部分，MUST NOT 重复前缀。

#### Scenario: 文本增量只发追加部分

- **WHEN** 某 assistant 消息文本从 `"Hello"` 增长到 `"Hello world"`
- **THEN** 投影层 SHALL 只发一条 `agent_message_chunk`，`text: " world"`
- **AND** 该 `messageId` 与之前发送该消息时一致

#### Scenario: 新回合产生新 messageId

- **WHEN** 用户发起新一轮并产生新的 assistant 消息
- **THEN** 其 `agent_message_chunk` 的 `messageId` SHALL 与上一回合不同

### Requirement: 推理内容以 agent_thought_chunk 发送

模型的思考/推理部分 SHALL 以 `agent_thought_chunk` 发送，语义与 `agent_message_chunk` 一致（增量、稳定 messageId），且 SHALL 与最终回答分开。

#### Scenario: 思考与回答分开

- **WHEN** 一条 assistant 消息同时含 thinking part 与 text part
- **THEN** 投影层 SHALL 先/分别发送 `agent_thought_chunk` 与 `agent_message_chunk`
- **AND** 思考内容 MUST NOT 混入回答内容

### Requirement: 工具调用以 tool_call / tool_call_update 报告

工具调用 SHALL 在其开始时以 `tool_call`（含 `toolCallId`、`title`、`kind`、`status: "pending"`、可选 `rawInput`、`locations`）报告，并在执行中以 `tool_call_update` 更新 `status`（`in_progress`/`completed`/`failed`）与 `content`/`rawOutput`。`kind` SHALL 由工具种类映射（如 `reads`→`read`、`edits`→`edit`、`searches`→`search`、`commands`→`execute`、web 工具→`fetch`，删除→`delete`，其余→`other`）。流式工具输出（`tool` 通道）SHOULD 作为 `tool_call_update` 的 `content` 增量转发。

#### Scenario: 工具生命周期

- **WHEN** 模型调用一个读文件工具并成功返回
- **THEN** agent SHALL 先发 `tool_call`（status pending，kind read），再发 `tool_call_update`（status in_progress），完成后发 `tool_call_update`（status completed，含结果 content）

#### Scenario: 流式命令输出

- **WHEN** `run_command` 在后台流式产出 stdout
- **THEN** agent SHOULD 以 `tool_call_update` 的 `content` 转发这些片段（可节流）

#### Scenario: 失败工具

- **WHEN** 工具执行抛错
- **THEN** 对应的 `tool_call_update` SHALL 使用 `status: "failed"` 并携带错误文本

### Requirement: 计划以 plan 更新（来自 todos）

agent SHALL 把 `todos` 通道投影为 ACP `plan` 更新：`TodoItem.content/status/priority` 与 `PlanEntry.content/status/priority` 一一对应（枚举完全一致）。每次 `plan` 更新 SHALL 发送**完整**的计划条目列表（ACP 要求 client 整体替换）。

#### Scenario: 计划同步

- **WHEN** todos 从 `[pending, pending]` 变为 `[completed, in_progress]`
- **THEN** agent SHALL 发送一条含完整两项目前状态的 `plan` 更新

### Requirement: 会话模式与切换

agent SHALL 在 `session/new` 响应中返回 `modes`（`availableModes` 与 `currentModeId`），把自身模式（`normal`/`auto`/`plan`）暴露为 ACP 模式；`session/set_mode` SHALL 映射为 `dispatch({type:"mode.set"})`；模式经 `mode` 通道变化时 SHALL 发送 `current_mode_update`。对于 `plan` 这类富生命周期模式，agent MAY 通过 `_meta` 或配置项附加阶段信息。

#### Scenario: 切换模式回传

- **WHEN** client 调用 `session/set_mode` 切到 `plan`
- **THEN** agent SHALL 应用该模式并发送 `current_mode_update`（`currentModeId: "plan"`）

### Requirement: 可用命令广告与调用

agent SHALL 通过 `available_commands_update` 广告可用的 slash 命令（扩展命令来自 `extensions` 摘要的 `commands`，内置命令来自 core 导出的命令目录）。当 client 以 `/name args` 作为 prompt 发送时，agent SHALL 解析并以 `dispatch({type:"extension.invokeCommand"})` 或对应内置命令处理，MUST NOT 把它当作普通文本消息发给模型。

#### Scenario: 广告并执行命令

- **WHEN** 会话就绪且扩展注册了命令 `foo`
- **THEN** agent SHALL 发送 `available_commands_update` 含 `foo`
- **AND** 当 client 发送 `/foo bar` 作 prompt 时，agent SHALL 执行该命令并把结果作为 `agent_message_chunk` 返回

### Requirement: 用量以 usage_update 报告

agent SHALL 在每轮结束（以及 `session/new`/`session/load`/模型切换后）发送 `usage_update`：`used`/`size` 取自会话上下文占用的 token 读法与模型窗口；`cost`（`amount`+`currency`）SHOULD 尽力提供（来自 usage 历史），无法可靠获得时 MAY 省略。

#### Scenario: 每轮后报告用量

- **WHEN** 一轮 prompt 结束
- **THEN** agent SHALL 发送 `usage_update`，`used` 与 `size` 非空
- **AND** `cost` 若提供则 `amount` 与 `currency` 同时存在

### Requirement: 压缩与通知按能力门控

仅当 client 声明 `session.compaction` 时，agent 才 SHALL 发送 `compaction_update`/`compaction_summary_chunk`（映射自动/反应式压缩与 SUMMARY 流）；否则 SHALL 用普通 agent message 描述压缩。仅当 client 声明 `session.notices` 时，agent 才 SHALL 发送 `notice`；否则用 agent message。

#### Scenario: 未声明压缩能力时降级

- **WHEN** client 未声明 `session.compaction`，而会话发生自动压缩
- **THEN** agent MUST NOT 发送 `compaction_update`
- **AND** MAY 用一条 agent message 说明发生了压缩

#### Scenario: 声明后可带摘要流

- **WHEN** client 声明 `session.compaction` 且压缩产生 SUMMARY
- **THEN** agent SHALL 发送带稳定 `compactionId` 的 `compaction_update`，并 MAY 以 `compaction_summary_chunk` 流式补充摘要

### Requirement: 会话元信息更新

会话标题（`rename`）变化时，agent SHALL 通过 `session_info_update` 通知新标题。

#### Scenario: 重命名回传

- **WHEN** 标题被生成或用户重命名
- **THEN** agent SHALL 发送 `session_info_update` 携带新标题

### Requirement: 增量的正确性与恢复

投影层 SHALL 合并/节流高频更新，SHALL 在检测到无法以增量表达的变化（顺序变化、变化超过阈值、基线缺失）时回退为**完整重建**（重新发送完整 plan/消息或等价 state），并 MUST NOT 产生重复、乱序或丢失片段。

#### Scenario: 顺序变化回退全量

- **WHEN** 会话消息顺序发生重排（增量无法表达）
- **THEN** 投影层 SHALL 触发一次完整重建
- **AND** 之后的增量以新基线继续
