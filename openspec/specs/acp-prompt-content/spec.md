# acp-prompt-content Specification

## Purpose
TBD - created by archiving change add-acp-agent. Update Purpose after archive.
## Requirements
### Requirement: 入站 prompt 内容映射

agent SHALL 把 `session/prompt` 的 `ContentBlock[]` 映射为 AgentSession 的 `send` 内容（`string | ContentPart[]`）：`text` → 文本；`image`/`audio` → 对应的多模态 part；`resource`（内嵌文本或 blob）→ 文本/文档 part；`resource_link` → 引用文本（uri + name）。映射 SHALL 遵守协商的 `promptCapabilities`：接受已声明类型，对未声明类型 SHALL 返回明确 JSON-RPC 错误或降级为文本，MUST NOT 静默丢弃。

#### Scenario: 文本与图片

- **WHEN** client 发送含 `text` 与 `image`（已声明 `image` 能力）的 prompt
- **THEN** agent SHALL 以含文本 + 图片 part 的内容 `dispatch({type:"send"})`
- **AND** 图片 SHALL 保留 mimeType 与 base64 数据

#### Scenario: 未声明的音频

- **WHEN** client 发送 `audio` 而 agent 未声明 `audio` 能力
- **THEN** agent SHALL 返回 JSON-RPC 错误（或降级为文本提示），MUST NOT 静默丢弃该内容

### Requirement: 内嵌资源与 resource link

对 `resource`（内嵌）与 `resource_link`，agent SHALL 将资源内容/引用转成模型可读的文本或文档 part；`resource_link` SHALL 至少携带 `uri` 与 `name`，且当 `uri` 为 `file://` 且位于工作区内时 MAY 直接读取文件内容。绝对路径要求 SHALL 遵守 ACP 约定。

#### Scenario: 内嵌文本资源

- **WHEN** client 发送 `resource`（内嵌文本，`uri: file:///…`）
- **THEN** agent SHALL 把该文本作为上下文交给模型
- **AND** 引用信息（uri）SHOULD 保留在消息中

### Requirement: 出站文本内容块

agent 发送的 assistant 文本 SHALL 以 `ContentBlock::Text` 承载，并 MUST 是 Markdown；含图片/其它媒体时 SHALL 使用对应的 `ContentBlock`（`image` 等），MUST NOT 把二进制当作文本发送。

#### Scenario: 文本回答为 Markdown

- **WHEN** 模型回答包含 Markdown
- **THEN** `agent_message_chunk.content` SHALL 为 `{ type: "text", text: "<markdown>" }`

### Requirement: 工具内容含文件位置

当工具调用作用于文件时，`tool_call`/`tool_call_update` SHOULD 携带 `locations`（绝对 `path`，可推导时含 1-based `line`），以支持 client 的 follow-along。路径 SHALL 解析为相对工作区根的绝对路径。

#### Scenario: 读文件暴露位置

- **WHEN** 工具读取工作区内某文件
- **THEN** 对应 `tool_call` SHALL 含该文件的绝对 `path` 位置

### Requirement: 编辑工具携带结构化 diff

对于编辑/写入类工具，当能够可靠获得修改前后的文本时，agent SHALL 在 `tool_call_update` 的 `content` 中携带 ACP 结构化 `diff`（`path`、`oldText`、`newText`）；新建文件时 `oldText` SHALL 为 `null`。无法可靠获得前后文本时 MAY 退化为文本 content，但 MUST NOT 伪造 diff。

#### Scenario: 编辑产出 diff

- **WHEN** `edit_file` 成功修改一个已有文件
- **THEN** 对应 `tool_call_update` SHALL 含 `{ type: "diff", path, oldText, newText }`
- **AND** `path` SHALL 为绝对路径

#### Scenario: 新建文件

- **WHEN** `write_file` 新建一个此前不存在的文件
- **THEN** diff 的 `oldText` SHALL 为 `null`，`newText` 为新内容

