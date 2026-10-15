# acp-session-mcp Specification

## Purpose
TBD - created by archiving change add-session-mcp-servers. Update Purpose after archive.
## Requirements
### Requirement: ACP session/new 接入 client 下发的 MCP 服务器

agent SHALL 读取 `session/new` 的 `mcpServers` 参数，把 ACP `McpServer` 映射为 core 的服务器配置并随会话创建下发，
且 SHALL 在 `initialize` 中按实现如实声明 `mcpCapabilities`。ACP 的 `McpServer` 联合有四种形态
（`stdio` / `http` / `sse` / `acp`）。`McpCapabilities` 没有 stdio 位（只有 `http` / `sse` / `acp`）：
stdio 是基线传输、无需声明也 SHALL 被支持，`http` 与 `sse` SHALL 被声明为支持。

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

