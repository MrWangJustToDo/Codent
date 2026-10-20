## MODIFIED Requirements

### Requirement: ACP session/new 接入 client 下发的 MCP 服务器

agent SHALL 读取 `session/new` 的 `mcpServers` 参数，把 ACP `McpServer` 映射为 core 的服务器配置并随会话创建下发，且 SHALL 在 `initialize` 中按实现如实声明 `mcpCapabilities`。ACP 的 `McpServer` 联合有四种形态（`stdio` / `http` / `sse` / `acp`）。`McpCapabilities` 没有 stdio 位（只有 `http` / `sse` / `acp`）：stdio 是基线传输、无需声明也 SHALL 被支持，`http` 与 `sse` SHALL 被声明为支持。`session/load` / `session/resume` 命中一个**已 live** 的会话时，agent SHALL 比较请求的 `mcpServers` 与当前列表：相同（或都为空）时 SHALL 复用该会话；不同时 SHALL 返回 `invalidParams`，MUST NOT 静默忽略该列表后复用旧会话。

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

#### Scenario: live 会话的 mcpServers 不被静默替换

- **WHEN** `session/load` / `session/resume` 命中一个已 live 的会话，且请求的 `mcpServers` 与当前列表不同
- **THEN** agent SHALL 返回 `invalidParams`，说明无法在 live 会话上替换 MCP 服务器
- **AND** MUST NOT 静默复用旧会话

#### Scenario: live 会话的相同列表可复用

- **WHEN** `session/load` / `session/resume` 命中一个已 live 的会话，且请求的 `mcpServers` 与当前列表相同（或都为空）
- **THEN** agent SHALL 复用该会话
- **AND** MUST NOT 重建第二个 bridge
