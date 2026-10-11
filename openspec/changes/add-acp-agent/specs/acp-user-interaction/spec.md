## ADDED Requirements

### Requirement: 审批映射为 session/request_permission

当会话产生待审批工具调用（`interaction` 通道的 approval）时，agent SHALL 调用 `session/request_permission`，携带 `toolCall`（含 `toolCallId`、`title`、`kind`、`status: "pending"` 及描述性 `content`）与候选 `options`。client 返回的 outcome SHALL 映射为 `dispatch({type:"respondApproval"})`：`selected` 且 option kind 为 allow_* → 批准；reject_* → 拒绝（携带拒绝理由，若有）；`cancelled` → 视为取消。

#### Scenario: 批准一次

- **WHEN** 一个需要审批的工具调用产生，client 选择 `allow_once`
- **THEN** agent SHALL `dispatch({type:"respondApproval", approved: true})`
- **AND** 对应工具 SHALL 继续执行

#### Scenario: 拒绝并带理由

- **WHEN** client 选择 `reject_once`（可选带理由）
- **THEN** agent SHALL `dispatch({type:"respondApproval", approved: false, reason})`

### Requirement: 权限选项与既有语义对应

agent SHALL 为每个权限请求提供 ACP `options`，其 `kind` 至少覆盖 `allow_once`/`allow_always`/`reject_once`/`reject_always`。`allow_always`/`reject_always` SHOULD 与已有“本会话记住该决定”的语义一致；若 host 不支持记忆，MAY 仅提供一次性选项。

#### Scenario: 提供四类选项

- **WHEN** 产生一个可审批的工具调用
- **THEN** `options` SHALL 至少包含一个 allow 类与一个 reject 类选项
- **AND** 每个选项 SHALL 有唯一 `optionId` 与 `kind`

### Requirement: 取消时收敛挂起权限

收到 `session/cancel` 时，agent SHALL 使所有挂起的 `session/request_permission` 以 `cancelled` outcome 收束，且 MUST NOT 因取消而抛出未捕获错误。

#### Scenario: 取消使权限收敛

- **WHEN** 存在挂起的权限请求且收到 `session/cancel`
- **THEN** 每个挂起请求 SHALL 以 `{ outcome: { outcome: "cancelled" } }` 收束

### Requirement: ask_user 映射为 elicitation/create

当工具需要结构化用户输入（`ask_user`）且 client 声明了 `elicitation` 能力时，agent SHALL 调用 `elicitation/create`（form 模式），把返回的结构化数据作为 `ask_user` 的答案。`ask_user` 的问题/字段 SHALL 映射为 elicitation 的 JSON Schema 形态。

#### Scenario: 支持 elicitation 时使用表单

- **WHEN** `ask_user` 需要用户选择，且 client 声明了 form elicitation
- **THEN** agent SHALL 调用 `elicitation/create` 并以其响应回答 `ask_user`

#### Scenario: 不支持 elicitation 时降级

- **WHEN** `ask_user` 需要输入但 client 未声明 `elicitation`
- **THEN** agent SHALL 以一条 agent message 呈现问题（说明当前 client 不支持结构化输入）
- **AND** SHALL 以“取消/默认”方式收束该交互，MUST NOT 使运行永久挂起

### Requirement: 挂起交互与会话归属

agent SHALL 把每个挂起交互关联到其 `sessionId` 与对应 `toolCallId`；client 的应答 SHALL 只作用于它所对应的会话与工具调用，MUST NOT 串扰其它会话。

#### Scenario: 多会话各自应答

- **WHEN** 两个会话各有挂起的权限请求
- **THEN** 对会话 A 请求的应答 SHALL 只解除 A 的挂起，B 保持挂起
