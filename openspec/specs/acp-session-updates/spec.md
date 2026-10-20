# acp-session-updates Specification

## Purpose
TBD - created by archiving change add-acp-agent. Update Purpose after archive.
## Requirements
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

工具调用 SHALL 在其开始时以 `tool_call`（含 `toolCallId`、`title`、`kind`、`status`、可选 `rawInput`、`locations`）报告，并在执行中以 `tool_call_update` 更新 `status`（`pending`/`in_progress`/`completed`/`failed`）与 `content`/`rawOutput`。`status` SHALL 反映真实状态：输入仍在流式或等待审批 → `pending`；审批被拒绝 → `failed`；执行出错 → `failed`；完成 → `completed`。MUST NOT 在终态之后把一行降级回 `in_progress`。`kind` SHALL 由工具种类映射（如 `reads`→`read`、`edits`→`edit`、`searches`→`search`、`commands`→`execute`、web 工具→`fetch`，删除→`delete`，其余→`other`）。`locations[]` SHALL 携带绝对 `path`，并在输入含 0 基行位置时携带 1 基的 `line`（ACP 的 "Following the Agent"）。流式工具输出（`tool` 通道）SHOULD 作为 `tool_call_update` 的 `content` 增量转发。

写/编辑类工具（`write_file` / `edit_file`）的编辑预览 SHALL 以 `content: [{ type: "diff" }]` 发给 client：参数一经可解析即发（MUST NOT 等到调用结束），且终态内容 SHALL 同时携带 `diff` 与结果文本。覆盖已有文件时 `oldText` SHALL 是该文件的真实前文，MUST NOT 为 `null`（`null` 只表示新文件）；`edit_file` 的多个替换 SHALL 各自形成一个 diff（或一个忠实的合并 diff），并 SHALL 遵守 `replaceAll`。

#### Scenario: 工具生命周期

- **WHEN** 模型调用一个读文件工具并成功返回
- **THEN** agent SHALL 先发 `tool_call`（status pending，kind read），再发 `tool_call_update`（status in_progress），完成后发 `tool_call_update`（status completed，含结果 content）

#### Scenario: 流式命令输出

- **WHEN** `run_command` 在后台流式产出 stdout
- **THEN** agent SHOULD 以 `tool_call_update` 的 `content` 转发这些片段（可节流）

#### Scenario: locations 指向具体行

- **WHEN** 工具输入带有 0 基的行位置（`read_file` 的 `offset`、LSP 工具的 `line`）
- **THEN** 该 location SHALL 携带对应的 1 基 `line`
- **AND** 多路径输入 SHALL 只给主路径附行号，无位置信息时 MUST NOT 编造 `line`

#### Scenario: 失败工具

- **WHEN** 工具执行抛错
- **THEN** 对应的 `tool_call_update` SHALL 使用 `status: "failed"` 并携带错误文本

#### Scenario: 被拒绝的工具是 failed

- **WHEN** 用户拒绝了某工具调用
- **THEN** 该行 SHALL 以 `status: "failed"` 收束
- **AND** MUST NOT 显示为 `completed` 或在后续 tick 降级回 `in_progress`

#### Scenario: 输入流式期间是 pending

- **WHEN** 工具参数仍在流式到达（`input-streaming`）或等待审批
- **THEN** 该行 SHALL 为 `status: "pending"`，MUST NOT 报 `in_progress`

#### Scenario: 覆盖已有文件的 diff 带真实前文

- **WHEN** `write_file` 覆盖一个已存在的文件
- **THEN** 其 diff 的 `oldText` SHALL 是该文件的真实前文
- **AND** MUST NOT 为 `null`

#### Scenario: 编辑多个替换

- **WHEN** `edit_file` 替换多处文本，或带 `replaceAll`
- **THEN** 其 diff SHALL 忠实反映每一处替换（或一个忠实的合并 diff）
- **AND** MUST NOT 把非连续替换拼成一段虚假的连续文本

#### Scenario: 编辑预览的时机与两个写入方

- **WHEN** 一个 `write_file` 调用先以部分 `arguments` 出现、随后参数完整、最后结果落地
- **THEN** agent SHALL 在参数可解析时即发一条带 `diff` 的 `tool_call_update`
- **AND** client 最终持有的该调用 `content` SHALL 同时含 `diff` 与结果文本（无论结果 part 与调用终态谁先到）

#### Scenario: 重复 tick 不重发预览

- **WHEN** `messages` 通道就同一次调用重复上报（内容未变）
- **THEN** agent MUST NOT 重发预览或新增更新

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

agent SHALL 通过 `available_commands_update` 广告可用的 slash 命令（扩展命令来自 `extensions` 摘要的 `commands`，内置命令来自 core 导出的命令目录）。投影层 SHALL 订阅 `extensions` 与 `extension-ui` 通道，并在扩展集合变化时重新广告命令，MUST NOT 只在 attach 时发送一次。当 client 以 `/name args` 作为 prompt 发送时，agent SHALL 解析并以 `dispatch({type:"extension.invokeCommand"})` 或对应内置命令处理，MUST NOT 把它当作普通文本消息发给模型。会替换底层磁盘会话的命令（`/clear` / `/clone` / `/resume`）SHALL 按会话句柄重绑规则处理（见 `acp-session-catalog`），MUST NOT 让 client 持有失效的 id。

#### Scenario: 广告并执行命令

- **WHEN** 会话就绪且扩展注册了命令 `foo`
- **THEN** agent SHALL 发送 `available_commands_update` 含 `foo`
- **AND** 当 client 发送 `/foo bar` 作 prompt 时，agent SHALL 执行该命令并把结果作为 `agent_message_chunk` 返回

#### Scenario: 扩展变化后重新广告

- **WHEN** 运行中扩展注册或移除了命令
- **THEN** agent SHALL 再次发送 `available_commands_update`
- **AND** client 的命令菜单 SHALL 与新集合一致

#### Scenario: 替换会话的命令保持句柄有效

- **WHEN** client 调用 `/clear` `/clone` 或 `/resume`
- **THEN** 命令结果 SHALL 说明会话已切换，且会话句柄保持有效
- **AND** 后续 prompt 与 update SHALL 继续使用该句柄

### Requirement: 用量以 usage_update 报告

agent SHALL 在每轮结束（以及 `session/new`/`session/load`/模型切换后）发送 `usage_update`：`used`/`size` 取自会话上下文占用的 token 读法与模型窗口；`cost`（`amount`+`currency`）SHOULD 尽力提供（来自 usage 历史），无法可靠获得时 MAY 省略。

#### Scenario: 每轮后报告用量

- **WHEN** 一轮 prompt 结束
- **THEN** agent SHALL 发送 `usage_update`，`used` 与 `size` 非空
- **AND** `cost` 若提供则 `amount` 与 `currency` 同时存在

### Requirement: 压缩与通知按能力门控

仅当 client 声明 `session.compaction` 时，agent 才 SHALL 发送 `compaction_update`/`compaction_summary_chunk`（映射自动/反应式/手动压缩与 SUMMARY 流）；否则 SHALL 用普通 agent message 描述压缩。仅当 client 声明 `session.notices` 时，agent 才 SHALL 发送 `notice`；否则用 agent message。

压缩 SHALL 按 `compaction_update` 的 upsert 语义报告：同一行以 `in_progress` 开启，`compaction_summary_chunk` 按序追加摘要，最后以 `completed`（携带摘要正文）、`failed`（携带原因）或 `cancelled` 关闭。开启信号 SHALL 取自 `state` 通道的 `compacting` 状态（手动 `/compact` 不产生任何 lifecycle 事件，状态是它唯一的可见信号），或 SUMMARY 流的 `reset`；两者指向同一次压缩时 MUST NOT 开出第二行。每次压缩 SHALL 使用各自的 `compactionId` —— 协议里该 id 是 upsert 键，复用等于告诉 client 第二次压缩是第一次的补丁。仅属于缓存清理的失败（`phase: "cache-cleanup"`）MUST NOT 把压缩行标为 `failed`；手动压缩的失败/取消 SHALL 以 `failed` / `cancelled` 收尾，MUST NOT 报 `completed`。

#### Scenario: 未声明压缩能力时降级

- **WHEN** client 未声明 `session.compaction`，而会话发生自动压缩
- **THEN** agent MUST NOT 发送 `compaction_update`
- **AND** MAY 用一条 agent message 说明发生了压缩

#### Scenario: 声明后按生命周期报告

- **WHEN** client 声明 `session.compaction`，且会话开始一次自动压缩并产生 SUMMARY
- **THEN** agent SHALL 先发该 `compactionId` 的 `compaction_update`（`status: "in_progress"`）
- **AND** SHALL 以 `compaction_summary_chunk` 按序转发摘要片段（同一 `compactionId`）
- **AND** SHALL 以 `completed` 关闭该行，并在其中携带完整摘要正文
- **AND** MUST NOT 为该次压缩开出第二个 `compactionId`

#### Scenario: 手动压缩也可见

- **WHEN** client 声明 `session.compaction`，且用户或 client 触发一次手动 `/compact`（它不产生任何 lifecycle 事件）
- **THEN** agent SHALL 通过 `state` 通道的 `compacting` 状态开始该行，并在状态离开时关闭它

#### Scenario: 中止与失败的收尾

- **WHEN** 压缩过程中运行被中止，或压缩以错误收场
- **THEN** 对应行 SHALL 分别以 `cancelled` / `failed`（携带原因）关闭，MUST NOT 停留在 `in_progress`
- **AND** 手动压缩失败时 MUST NOT 以 `completed` 收尾

#### Scenario: 缓存清理失败不是压缩失败

- **WHEN** 压缩成功，但随后仅有 `phase: "cache-cleanup"` 的清理告警
- **THEN** 压缩行 SHALL 保持/收束为 `completed`
- **AND** MUST NOT 因该告警再开一条 `failed` 行

#### Scenario: 恢复会话时摘要不是用户发言

- **WHEN** `session/load` 回放一个含压缩摘要的会话
- **THEN** 摘要 MUST NOT 作为 `user_message_chunk` 出现
- **AND** client 声明 `session.compaction` 时 SHALL 作为 `compaction_update`（`completed`，`summary` 为去掉标记的正文，`compactionId` 取该消息 id）出现
- **AND** 未声明时 SHALL 退化为一条说明性 agent message，MUST NOT 回放摘要正文

#### Scenario: 两次压缩是两行

- **WHEN** 同一会话先后发生两次压缩
- **THEN** 两次的 `compaction_update` SHALL 使用不同的 `compactionId`

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

### Requirement: 会话 seed 在响应之后发送

`session/new` 的初始 `session/update`（`plan`、`current_mode_update`、`usage_update`、`session_info_update`、`available_commands_update` 等）SHALL 在该请求的响应帧之后发送。MUST NOT 在 client 还不知道新 `sessionId` 时先发这些通知，否则严格实现会按未知 id 丢弃，命令菜单可能永远为空。

#### Scenario: 新会话的 seed 不早于响应

- **WHEN** client 调用 `session/new` 并收到 `sessionId`
- **THEN** 初始 seed 通知 SHALL 在该响应之后到达
- **AND** `available_commands_update` SHALL 能被 client 关联到该 `sessionId`

