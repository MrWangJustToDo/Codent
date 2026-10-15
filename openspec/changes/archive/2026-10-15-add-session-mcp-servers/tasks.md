# Implementation checklist

## 1. core: 会话创建选项接受 MCP 服务器

- [x] 1.1 `packages/core/src/agent-session/host-types.ts`：`AgentSessionCreateOptions` 新增
      `mcpServers?: Record<string, McpServerConfig>`（注意 `McpServerConfig` 是**单个**服务器的联合，
      已被 core 占用；这里不要新造同名类型），文档注明「显式传入时取代默认配置文件」
- [x] 1.2 `packages/core/src/agent/mcp/`：导出一个由该 map 构造 `McpConfig`（`{ mcpServers: map }`）的小工具，
      避免 factory 手搓外壳
- [x] 1.3 `packages/core/src/managers/agent-factory.ts`：当 create 选项带 `mcpServers` 时，
      MCP extension 的 activate **跳过** `loadMcpConfig`（`mcp/extension.ts:57`），改用显式 map 走同一条
      `McpManager.initialize` + 工具注册路径
- [x] 1.4 **不要**把 `"session-options"` 塞进 `setConfigSource(configPath, loadedFrom)`
      （`manager.ts:104`，两个参数都是路径语义且会被 `/mcp` 呈现）：
      另加一个来源字段（如 `setConfigSourceKind(kind)`）或等价的显式来源表示
- [x] 1.5 日志：记录来源与服务器名/transport，MUST NOT 记录 `env` / `headers` 的值
- [x] 1.6 单服务器连接失败不抛出到会话创建；失败进既有 MCP 状态与日志
- [x] 1.7 断言 `sse` transport 不被 core 拒绝（`mcp/types.ts:19` 已含它，
      `createTransportInput` 透传 `config.transport`）

## 2. acp: 映射与校验

- [x] 2.1 新增 `packages/acp/src/mcp.ts`：`mapAcpMcpServers(servers)` →
      `Record<string, McpServerConfig>`；`env: EnvVariable[]` / `headers: HttpHeader[]` →
      `Record<string,string>`；ACP `type`（`"http"`/`"sse"`，stdio 无该字段）→ core 的 `transport`
- [x] 2.2 校验（返回错误字符串而非抛）：`type: "acp"`（未实现的形态）、`name` 空、`name` 重复、
      stdio 缺 `command`、http/sse 缺 `url`
- [x] 2.3 `packages/acp/src/agent.ts` 的 `createOptions()`：接受并按需注入 `mcpServers`；
      `session/new` 读取 `ctx.params.mcpServers`，映射失败即返回 JSON-RPC 错误（不创建会话）
- [x] 2.4 `session/fork` 已由 `add-acp-session-catalog` 决定**拒绝** `mcpServers`
      （MCP 在 agent 创建时固定）；此处不新增支持，仅确认两条 change 不冲突

## 3. acp: 能力位

- [x] 3.1 `initialize` 的 `mcpCapabilities` 改为 `{ http: true, sse: true }`（`acp` 不声明）
- [x] 3.2 同步更新 `packages/acp/README.md` 的 Known limitations（去掉「未接线」那条）

## 4. 验证

- [x] 4.1 `pnpm --filter @codent/acp run validate:acp`：覆盖
      stdio 服务器注册为 `mcp__<name>_<tool>`、http 服务器连接、**sse 服务器连接**、
      无 `mcpServers` 时回落文件、`type:"acp"` / 缺 `command` / 重复名返回 JSON-RPC 错误且不产生会话
- [x] 4.2 断言 `initialize` 的 `mcpCapabilities` 为 `{ http: true, sse: true }`
- [x] 4.3 凭据不入日志的断言：给一个带 `env` 的服务器，断言 agent 日志中不含该值
- [x] 4.4 断言 `/mcp` 的来源展示不出现非路径字面量
- [x] 4.5 `pnpm build && pnpm lint && pnpm typecheck`、`pnpm --filter @codent/app test`
- [x] 4.6 `openspec validate add-session-mcp-servers --strict`
