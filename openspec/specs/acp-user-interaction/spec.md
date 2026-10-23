# acp-user-interaction Specification

## Purpose
TBD - created by archiving change add-acp-agent. Update Purpose after archive.
## Requirements
### Requirement: 审批映射为 session/request_permission

当会话产生待审批工具调用（`interaction` 通道的 approval）时，agent SHALL 调用 `session/request_permission`，携带 `toolCall`（含 `toolCallId`、`title`、`kind`、`status: "pending"` 及描述性 `content`）与候选 `options`。client 返回的 outcome SHALL 映射为 `dispatch({type:"respondApproval"})`：`selected` 且 option kind 为 allow_* → 批准；reject_* → 拒绝；`cancelled`（client 关闭对话框）→ **拒绝/取消并结算该 approval**，MUST NOT 什么都不做。审批等待 SHALL 有上限：超时、连接关闭或 `session/cancel` 时 SHALL 以拒绝/取消结算，使运行不会停在 `waiting`。

#### Scenario: 批准一次

- **WHEN** 一个需要审批的工具调用产生，client 选择 `allow_once`
- **THEN** agent SHALL `dispatch({type:"respondApproval", approved: true})`
- **AND** 对应工具 SHALL 继续执行

#### Scenario: 拒绝

- **WHEN** client 选择 `reject_once`
- **THEN** agent SHALL `dispatch({type:"respondApproval", approved: false})`
- **AND** MUST NOT 期待一个拒绝理由：ACP v1 的 `SelectedPermissionOutcome` 只携带 `optionId`，协议里没有 reason 字段（基线规范中的「携带拒绝理由」是与协议不符的声明，此次一并纠正）

#### Scenario: 关闭审批对话框也会结算

- **WHEN** client 以 `{ outcome: { outcome: "cancelled" } }` 结束 `session/request_permission`
- **THEN** agent SHALL dispatch `respondApproval({ approved: false })`（或等价的取消结算）
- **AND** 该 approval MUST NOT 继续留在 pending 状态

#### Scenario: 超时或连接关闭也会结算

- **WHEN** 审批在配置的等待上限内没有得到回答，或 ACP 连接断开
- **THEN** agent SHALL 以拒绝/取消结算该 approval
- **AND** 后续 `session/prompt` MUST NOT 因该挂起审批而永久停在 `waiting`

### Requirement: 权限选项与既有语义对应

agent SHALL 为每个权限请求提供 ACP `options`，其 `kind` 至少覆盖 `allow_once`/`allow_always`/`reject_once`/`reject_always`。`allow_always` / `reject_always` SHALL 与"本会话记住该决定"的语义一致：选择 `allow_always` 后，同一工具身份的后续审批 SHALL 自动批准而不再次询问 client；`reject_always` SHALL 自动拒绝。若 host 无法实现记忆，则 MUST NOT 广告 `*_always` 选项（只提供一次性选项），以免对用户作出无法兑现的承诺。记忆策略 SHALL 在会话关闭或会话被 `/new` 替换时清除。

#### Scenario: 提供四类选项

- **WHEN** 产生一个可审批的工具调用
- **THEN** `options` SHALL 至少包含一个 allow 类与一个 reject 类选项
- **AND** 每个选项 SHALL 有唯一 `optionId` 与 `kind`

#### Scenario: allow_always 真正记住

- **WHEN** client 对某工具选择 `allow_always`
- **THEN** 该会话内同一工具身份的后续审批 SHALL 自动批准，MUST NOT 再次调用 `session/request_permission`
- **AND** 工具调用 SHALL 仍以 `tool_call` / `tool_call_update` 出现在会话中

#### Scenario: reject_always 真正记住

- **WHEN** client 对某工具选择 `reject_always`
- **THEN** 该会话内同一工具身份的后续审批 SHALL 自动拒绝
- **AND** MUST NOT 再次调用 `session/request_permission`

#### Scenario: 记忆随会话结束清除

- **WHEN** 会话被 `session/close` 关闭或被 `/new` 替换
- **THEN** 该会话的 always 策略 SHALL 被清除，MUST NOT 影响其它会话或后续新会话

### Requirement: 取消时收敛挂起权限

收到 `session/cancel` 时，agent SHALL 中止所有未完成的 `session/request_permission` 请求（abort/cancel，即 ACP 请求取消，client 侧观察到取消），并把会话内对应的 approval 结算为拒绝/取消（`dispatch({type:"respondApproval", approved: false})` 或等价结算），且 MUST NOT 因取消而抛出未捕获错误。若 client 以 `{ outcome: { outcome: "cancelled" } }` 完成该请求，agent SHALL 按拒绝处理。该结算 SHALL 保证会话不会因为一个没有 client 会回答的审批而永久停在 `waiting`。

#### Scenario: 取消使权限收敛

- **WHEN** 存在挂起的权限请求且收到 `session/cancel`
- **THEN** agent SHALL 中止该未完成请求（ACP 请求取消，client 侧观察到取消；若 client 完成该请求，其 outcome SHALL 为 `{ outcome: { outcome: "cancelled" } }` 并被按拒绝处理）
- **AND** 会话内对应的 approval SHALL 被结算，MUST NOT 继续处于 pending

#### Scenario: 取消也结算会话内的审批

- **WHEN** 存在挂起的权限请求且收到 `session/cancel`，随后 client 再次调用 `session/prompt`
- **THEN** 该 approval SHALL 已被结算为取消/拒绝，MUST NOT 仍处于 pending
- **AND** 后续 prompt SHALL 正常开始，MUST NOT 停在 `waiting`

### Requirement: ask_user 映射为 elicitation/create

当工具需要结构化用户输入（`ask_user`）且 client 声明了 `elicitation` 能力时，agent SHALL 调用 `elicitation/create`（form 模式），把返回的结构化数据作为 `ask_user` 的答案。`ask_user` 的问题/字段 SHALL 映射为 elicitation 的 JSON Schema 形态。client 返回 `decline` / `cancel`，或请求本身失败（连接异常、client 未实现）时，agent SHALL 以 `cancelled: true` 的 tool result 结算该交互，MUST NOT 把它当作空字符串回答，也 MUST NOT 让运行永久停在 `awaiting_user`。

client 未声明 form elicitation 时，agent SHALL 把问题（含编号选项）作为一条 agent message 呈现，并 **把当前 `session/prompt` 以 `end_turn` 结算、同时保持该 tool 处于 pending**：答案由下一条纯文本 `session/prompt` 提供，并以 `addToolResult` 结算（编号映射到选项标签）。该应答 prompt SHALL NOT 进入会话的 prompt 队列（挂起的 `ask_user` 使状态保持 ACTIVE，排队在它之后的应答永远无法出队）；它以消息到达即处理的路径执行，并作为后续 prompt 的队列尾部。收到 `session/cancel`、连接关闭或等待上限时，仍 SHALL 以 `cancelled: true` 结算。

#### Scenario: 支持 elicitation 时使用表单

- **WHEN** `ask_user` 需要用户选择，且 client 声明了 form elicitation
- **THEN** agent SHALL 调用 `elicitation/create` 并以其响应回答 `ask_user`

#### Scenario: 不支持 elicitation 时降级

- **WHEN** `ask_user` 需要输入但 client 未声明 `elicitation`
- **THEN** agent SHALL 以一条 agent message 呈现问题（含编号选项）
- **AND** SHALL 以 `end_turn` 结算当前 prompt，并保持该 tool 为 pending，使 client 能够提交答案
- **AND** 下一条纯文本 `session/prompt` SHALL 作为该问题的答案（`addToolResult`），MUST NOT 排队在挂起的 turn 之后
- **AND** 若无答案且在等待上限内未收到，SHALL 以 `cancelled: true` 结算，运行 MUST NOT 停在 `awaiting_user`

#### Scenario: 用户取消表单

- **WHEN** client 对 `elicitation/create` 返回 `action: "decline"` 或 `action: "cancel"`
- **THEN** agent SHALL 以 `cancelled: true` 的 tool result 结算 `ask_user`
- **AND** MUST NOT 把空字符串当作答案

#### Scenario: 表单请求失败

- **WHEN** `elicitation/create` 因连接断开或 client 未实现而抛错
- **THEN** agent SHALL 以 `cancelled: true` 结算该 `ask_user`
- **AND** 运行 MUST NOT 停在 `awaiting_user`

### Requirement: 挂起交互与会话归属

agent SHALL 把每个挂起交互关联到其 `sessionId` 与对应 `toolCallId`；client 的应答 SHALL 只作用于它所对应的会话与工具调用，MUST NOT 串扰其它会话。

#### Scenario: 多会话各自应答

- **WHEN** 两个会话各有挂起的权限请求
- **THEN** 对会话 A 请求的应答 SHALL 只解除 A 的挂起，B 保持挂起

