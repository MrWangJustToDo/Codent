# Change: 会话级 MCP 服务器

## Why

client 在 ACP 里挂 MCP 是常规操作（formulahendry/acp-client 的 `acp.agents.*.mcpServers`、
ACP Patchbay 的 MCP 面板都往 `session/new` 的 `mcpServers` 上写），而 `codent acp` 目前**完全不读这个参数** ——
`packages/acp/src/agent.ts:260` 的注释就写着 "Per-session MCP servers are not wired yet — do not over-claim"，
`initialize` 也如实声明 `mcpCapabilities: { http: false, sse: false }`。用户在编辑器里配好的 MCP 静默失效，
且没有任何地方能看出原因。

根因在 core：MCP 配置只能来自文件路径 —— `AgentSessionCreateOptions` 只有 `mcpConfigPath?: string`
（`agent-session/host-types.ts:43`），`McpManager` 是 per-ManagedAgent 的（`managers/agent-factory.ts:201`），
服务器列表在 extension activate 时由 `loadMcpConfig` 从 `.agents/mcp.json` 读出
（`agent/mcp/extension.ts:57`）。所以 ACP 层要支持它，只能先让 core 的 session-create 直接接受服务器列表。

## What Changes

- **core**：`AgentSessionCreateOptions` 新增 `mcpServers?: Record<string, McpServerConfig>`。
  显式传入时**取代**（不是合并）`.agents/mcp.json` 的服务器集合，与仓库既有的「显式配置隔离磁盘配置」
  先例一致（`--model` 隔离 `models.json`）。经 `McpManager.initialize` 连接，工具的注册路径不变。
- **acp**：`session/new` 读取 `params.mcpServers`，映射为 core 的 `McpServerConfig` map 并随 create 下发。
- **acp**：`initialize` 的 `mcpCapabilities` 据实声明为 `{ http: true, sse: true }`：
  ACP 的 `McpServer` 联合是**四种**（stdio / http / sse / acp，见下），其中 stdio、http、sse 三者
  core 端到端支持（`mcp/types.ts:19` 的 `z.enum(["sse","http"])`、`manager.ts:42-60` 直接透传
  `{type, url, headers}`、下游 `@tanstack/ai-mcp` 有 `SseTransportConfig`/`SSEClientTransport`），
  因此 sse MUST NOT 被声明为不支持。`acp` 形态（client 反向桥接 MCP）本 change 不实现，故不声明。
- **acp**：不被支持的 transport（`type: "acp"`）与不合法的条目（空名 / 重名 / stdio 缺 command /
  http-sse 缺 url）一律返回 JSON-RPC 错误，MUST NOT 静默跳过。

## Non-Goals

- **remote-session 平面不转发 `mcpServers`**。`AgentSessionCreateOptions` 的新字段不会自动到达服务端：
  server 平面是**逐字段列举**的 —— `packages/server/src/remote-session-host.ts:73` 附近的 create 请求
  手写转发各字段，`packages/server/src/routes/agent-session.ts` 的 create schema 逐个列举（无 passthrough），
  因此未知键（含 `mcpServers`）会在客户端被漏掉、在服务端被丢掉。
  本 change 不做这一转发（ACP 是本地宿主，收益集中在本地平面）。
  将来若要补齐，**必须同时改两处并处理凭据**，参照 `toolConfig` 的既有先例：
  它既改了上述两个位置，又因带密钥而在 `routes/agent-session.ts:361-365` 增加了日志脱敏 ——
  而 MCP 的 `env` / `headers` 正是凭据，与本 change 自己的「不得进入日志」要求同类。
  只改转发而不改脱敏，等于把 client 的密钥写进服务端日志。

## Impact

- 受影响 specs：`session-host-api`（ADDED ×4 requirements）、`acp-session-mcp`（ADDED，新 capability）
- 受影响代码：
  - `packages/core/src/agent-session/host-types.ts` — `AgentSessionCreateOptions.mcpServers`
  - `packages/core/src/managers/agent-factory.ts` — 显式 `mcpServers` 时跳过 `loadMcpConfig`，直接 `McpManager.initialize`
  - `packages/core/src/agent/mcp/*` — 供 factory 复用的「选项 → McpConfig」构造 + 配置来源字段
    （来源 kind 的**声明**在 `runtime-types/mcp-status.ts`：`session:mcp` 事件载荷要命名它，
    而 `runtime-types` 不能反向依赖 `agent/mcp/`；`agent/mcp/options.ts` 再导出供 MCP 侧就近引用）
  - `packages/core/src/runtime-types/*` + `packages/core/src/agent/log/*` — 事件载荷与日志桥接记录来源 kind
  - `packages/core/src/agent/extension/*` — `ctx.logger.log(level, category, msg)`，让扩展诊断落到正确
    category（`info`/`warn`/`error` 便利方法的 `hooks` category 与行为不变）
  - `packages/acp/src/agent.ts` — `session/new` 读取并映射 `params.mcpServers`；`initialize` 能力位；
    `session/load` / `session/resume` 同样映射并下发
  - `packages/acp/src/mcp.ts`（新）— ACP `McpServer[]` → core `McpServerConfig` map 的映射与校验
- **未覆盖的平面**：`packages/server/src/*`（remote-session 的 create 转发与 schema）**不在本 change 范围内**
  —— 见 Non-Goals。新选项在本地平面（CLI / ACP / im-bridge）生效，在 remote-session 平面会被丢弃
- `acp-agent-host` 的「能力协商如实声明」**不需要改**：它已要求「如实声明、不得声明未实现的能力」，
  本 change 是让实现符合该既有要求（把 http/sse 由 false 变 true），不是改变要求本身
- 无 breaking：`mcpServers` 为可选字段；未传入时行为与今天完全一致
