## MODIFIED Requirements

### Requirement: 入站 prompt 内容映射

agent SHALL 把 `session/prompt` 的 `ContentBlock[]` 映射为 AgentSession 的 `send` 内容（`string | ContentPart[]`）：`text` → 文本；`image`/`audio` → 对应的多模态 part；`resource`（内嵌文本或 blob）→ 文本/文档 part；`resource_link` → 引用文本（uri + name）。映射 SHALL 保持块在数组中的相对顺序：文本与媒体交替时 MUST NOT 把所有文本合并到最前或最后，MUST NOT 改变用户表达的图文顺序。映射 SHALL 遵守协商的 `promptCapabilities`：接受已声明类型，对未声明类型 SHALL 返回明确 JSON-RPC 错误或降级为文本，MUST NOT 静默丢弃。

#### Scenario: 文本与图片

- **WHEN** client 发送含 `text` 与 `image`（已声明 `image` 能力）的 prompt
- **THEN** agent SHALL 以含文本 + 图片 part 的内容 `dispatch({type:"send"})`
- **AND** 图片 SHALL 保留 mimeType 与 base64 数据

#### Scenario: 图文顺序被保留

- **WHEN** client 发送 `[text A, image, text B]`
- **THEN** 交给模型的内容 SHALL 保持 A → image → B 的顺序
- **AND** MUST NOT 变成 `A\n\nB` + image

#### Scenario: 未声明的音频

- **WHEN** client 发送 `audio` 而 agent 未声明 `audio` 能力
- **THEN** agent SHALL 返回 JSON-RPC 错误（或降级为文本提示），MUST NOT 静默丢弃该内容
