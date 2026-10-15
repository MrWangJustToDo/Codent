## Context

MCP 在 core 里已经是 per-agent 的：`agent-factory.ts:201` 每个 ManagedAgent 建一个 `McpManager`，
`agent/mcp/extension.ts:31` 的 `createMcpExtension` 在 activate 时读配置并 `initialize`，工具以
`mcp__<server>_<tool>` 注册进 extension tool registry。**配置来源是唯一缺的一环**：只有
`mcpConfigPath`（一个文件路径），没有「直接给一份服务器列表」的入口。

ACP 侧对应的形状（`@agentclientprotocol/sdk` `types.gen.d.ts`）：

```
export type McpServer = (McpServerHttp & { type: "http" })
                      | (McpServerSse  & { type: "sse" })
                      | (McpServerAcp  & { type: "acp" })   // UNSTABLE
                      | McpServerStdio;

McpCapabilities = { http?: boolean; sse?: boolean; acp?: boolean /* UNSTABLE */ }
```

| ACP | 字段 | core 对应 |
|---|---|---|
| `McpServerStdio` | `name`、`command`（绝对路径）、`args: string[]`、`env: EnvVariable[]` | `{transport:"stdio", command, args, env}` |
| `McpServerHttp` | `name`、`url`、`headers: HttpHeader[]` | `{transport:"http", url, headers}` |
| `McpServerSse` | `name`、`url`、`headers: HttpHeader[]` | `{transport:"sse", url, headers}` |
| `McpServerAcp` | `name`、`serverId` | **无对应**（client 反向桥接，本 change 不实现） |

core 侧的既有形状（`agent/mcp/types.ts`）：`{transport:"stdio",command,args?,env?}` 与
`{transport:"sse"|"http", url, headers?}`，外层 `{mcpServers: Record<string, McpServerConfig>}`。
`McpServerConfig` 这个类型名**已被 core 占用**（它是单个服务器的联合，不是 map）—— 新选项的类型是
`Record<string, McpServerConfig>`，不要误写成同名。

## Goals / Non-Goals

- Goals：client 配的 MCP 真正连上（stdio / http / sse 全覆盖）；capability 声明与实现一致；
  配置错误明确报错而不是静默忽略。
- Non-Goals：不做 `acp` 形态的 MCP（client 反向桥接）；不做 per-session MCP 的变更通知
  （`McpServer` 只在会话创建时下发）；不改 `.agents/mcp.json` 的既有语义；
  **不支持通过 `session/fork` 更换服务器**（fork 复用源会话的 live agent，确实无法更换，故显式拒绝）。
  注：`session/load` / `session/resume` **会**按 `session/new` 相同方式接受并下发 `mcpServers` ——
  这两个请求与 `new` 一样经由 `Host.create` 建立 agent（`load` 的该字段甚至是必填），拒绝它们会让
  任何配了 MCP 的客户端无法恢复会话。

## Decisions

### 1. 新增 core 选项，而不是在 ACP 层落临时配置文件

备选方案是把 `params.mcpServers` `JSON.stringify` 到一个临时文件再传 `mcpConfigPath`。否决理由：

- 写盘多一次 I/O，且要处理临时文件的命名/清理/并发（多个会话并发创建时重名即互相覆盖）；
- 服务器名与 `env`/`headers` 里可能有凭据，落盘等于把 client 的密钥写到工作区旁；
- 每次会话创建都要落一个文件，属于把「wire 上的东西变成 durable」——正是仓库明确反对的方向
  （`AGENTS.md` 的 durability rule）。

因此让 core 的 create 直接接受列表（与 `toolConfig` 这种「host 传入的显式配置」同类）。

### 2. 显式 `mcpServers` 取代文件配置，而不是合并

若合并，出现同名服务器时必须以某一方为准，而两边的 `command`/`url` 可能完全不同，静默择一是最难排查的
失败模式。取代语义还与本仓库既有先例一致：显式 `--model`/`--base-url`/`--api-key` 会隔离
`.agents/config/models.json`（`AppConfig.modelExplicit`）。取代也更符合 client 的预期 —— 它在 UI 里
看到的 MCP 列表就是它传下来的那一份。

备选：合并且「显式覆盖同名」。否决理由：仍然无法表达「client 想关掉工作区里某个服务器」，
且同名冲突的可见性差。

### 3. `mcpCapabilities` 声明 `{ http: true, sse: true }`（`acp` 不声明）

ACP 的 `McpServer` 联合有**四种**形态，不是两种。逐一对齐：

- `stdio` —— core 支持（`createMCPStdioTransport`，Node env 提供）✓
- `http` —— core 支持（`manager.ts:52` 透传 `{type:"http", url, headers}`）✓
- `sse` —— **core 也支持**：`mcp/types.ts:19` 的 schema 就是 `z.enum(["sse","http"])`，
  `createTransportInput` 对非 stdio 一律透传 `config.transport`，下游 `@tanstack/ai-mcp` 有
  `SseTransportConfig` 与 `SSEClientTransport`。因此 `sse: false` 会是**新的**错误声明 ✓
- `acp` —— client 反向桥接（`serverId` 指向 ACP 连接上的一个 MCP server），core 无对应入口 ✗

所以声明 `{ http: true, sse: true }`，不声明 `acp`，并对 `type: "acp"` 的条目显式报错。

### 4. 校验收在 ACP 边界

`command` / `url` 缺失、`name` 为空或重复、`type` 为不支持的 `"acp"`，都在映射时返回 JSON-RPC 错误
（invalid params）。core 侧不重复校验 —— 它的入参类型已保证形状，重复校验会造成两处真相。

### 5. 单个服务器连接失败不阻塞会话

`McpManager.initialize` 的连接是异步且可能失败的（它自身已按「失败只记日志」处理）。保持该容错：
单服务器失败不阻塞会话创建，失败原因进 MCP 状态与日志。

### 6. 恢复路径上的 `mcpServers` 与 `session/new` 同等对待

`session/load` 与 `session/resume` 的请求类型**也带** `mcpServers`（`LoadSessionRequest` 中必填，
`ResumeSessionRequest` 中可选）。最初的设计是「非空列表显式拒绝」，理由是「服务器在 agent 创建时固定，
而这里只是恢复既有会话」——该理由对 fork 成立（它复用源会话的 live agent），**对 load/resume 不成立**：
这条路径本身就调用 `Host.create`（带 `resumeSessionId`）建立 agent，所以映射后下发即可真实生效。

因此两者复用 `session/new` 的映射与下发路径：显式列表取代工作区配置文件，空列表回落文件。
反方向的代价不对称：`load` 连省略该字段都做不到，拒绝会让**任何配了 MCP 的客户端都无法恢复会话**。

## Risks / Trade-offs

- **取代语义可能让用户困惑**（工作区 `.agents/mcp.json` 在 client 下发的会话里不生效）。→ 缓解：
  会话创建后经 `.agents/logs/<sessionId>/agent.log` 明确记录「MCP 配置来源 = client 下发（N 个服务器）」，
  使「为什么我的 mcp.json 没生效」在日志里有答案。
- **凭据进入日志**：`env` / `headers` 的值 MUST NOT 写入日志或会话持久化。→ 缓解：日志只记服务器名与
  transport，不记值；这一点写进 requirement 的 scenario。
- **配置来源的既有呈现被污染**：`setConfigSource(configPath, loadedFrom)`（`manager.ts:104`）两个参数都是
  **路径语义**（第二个是「实际加载的文件」），而 `/mcp` 会展示它。把 `"session-options"` 塞进
  `configPath` 等于让 UI 显示一个不存在的文件路径。→ 缓解：另加一个**明确的来源字段**，
  不动这两个路径参数的语义（见 tasks 1.4）。

## Migration Plan

纯新增，无数据迁移。上线顺序：core 选项 → factory 接线 → ACP 映射与能力位。
回滚：去掉 ACP 侧的读取与能力位，core 的新选项保留（provider 无害）。

## Open Questions

（无）
