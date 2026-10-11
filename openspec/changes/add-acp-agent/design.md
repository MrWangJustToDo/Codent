## Context

ACP（Agent Client Protocol）正在成为“编辑器和任意 agent 之间的标准接口”，并且已经有一整层 **client** 生态：编辑器（Zed/JetBrains/ACP Registry）与 **ACP→IM bot**（Kiro 式 Telegram bot、`acpx`、OpenClaw）。这些 client 的共同假设是：**把 agent 当作一个可 spawn 的、自带鉴权与模型配置的子进程，通过 stdio 说 ACP**。

我们现有的分层是：

- `@codent/core` 提供进程内 `AgentSessionHost` / `AgentSession`（`getSnapshot` / `dispatch` / `subscribe` + 通道）。
- `@codent/cli`（`LocalAgentAdapter`）与 `@codent/server`（`/api/agent/*` SSE）各自驱动它。
- `packages/server/src/messages-delta.ts` 已实现**整条消息级**的 SSE 差分编码（引用相等 + 合并 + 安全网），`remote-session-transport` 已为其立规。

我们缺的不是引擎能力，而是 **ACP 适配层**：一个 agent 侧协议服务 + 出站/入站投影。

## Goals / Non-Goals

**Goals:**

- 提供 `@codent/acp`（agent 侧）与 `codent acp` 入口，覆盖 ACP v1 **全部**方法/通知。
- 让编辑器与现成 ACP→IM bot 无需我们编写任何 host 代码即可驱动我们的 agent。
- 出站为**增量**（长会话帧体积与变化量成正比），入站正确映射内容、权限、结构化输入。
- 不改 `AgentSession` 契约；缺口全部在 ACP 层补齐。

**Non-Goals:**

- 本变更不实现 ACP **client**（`im-bridge` 驱动任意 ACP agent）——列为后续。
- 不实现 ACP remote（HTTP/WS）传输——ACP 侧仍为实验态。
- 不改变既有 CLI / im-bridge / server 行为。
- 不在本变更内实现 ACP Registry 的交互鉴权（可选后续）。

## Decisions

### 决策 1：新建 `@codent/acp` 包，agent 侧、进程内驱动

- `packages/acp` 导出 `createAcpAgent()` 与 `runAcpAgentStdio()`；依赖 `@agentclientprotocol/sdk` + `@codent/core`。
- `codent`（release host）新增 `acp` 子命令与 `codent-acp` bin；stdio framing 用 SDK 的 `ndJsonStream(process.stdin, process.stdout)`。
- **不同于 pi-acp**：pi 是子进程 RPC，需要跨进程桥接；我们有进程内 `AgentSession`，直接驱动，无需第二套 RPC。

**Alternatives considered**：仿 pi-acp 用子进程 RPC —— 我们本来就是进程内，多一层无收益；把 ACP 塞进 `@codent/server` —— server 是 HTTP plane，ACP 是 stdio plane，职责不同。

### 决策 2：投影层（AcpProjector）——整条→part 级增量

- 订阅 `AgentSession` 通道，维护每个 `sessionId` 的**投影游标**：`messageId → { messageRef, textCursor, parts[] }`。
- **一级差分**复用 `messages-delta.ts` 的思路：对 `messages` 全量数组做引用相等比对，得到“哪条变了”。
- **二级差分**（ACP 独有）：对变化的 assistant 消息，按 `(messageId, partIndex)` 对比：
  - text part：比较已发送长度 → 只发追加子串（`agent_message_chunk`）；
  - thinking part：同法 → `agent_thought_chunk`；
  - tool part：对比 `state`/`output` → `tool_call`（首见）/`tool_call_update`。
- 顺序变化 / 变化超阈值 / 基线缺失 → **完整重建**（重新发 plan、重置游标）。
- 合并/节流（尾沿窗口，与 client 渲染节流匹配）。

> `remote-session-transport` 的消息级 delta 与 ACP 的 part 级投影是**同一思路的两层**；本变更不修改该 spec，只在 ACP 层实现更细粒度。

### 决策 3：工具 kind / locations / diff 在 ACP 层派生

- `kind` 映射表（不改 `tool-presentation`）：`reads→read`、`edits→edit`、`searches→search`、`commands→execute`、`websearch`/`webfetch`→`fetch`、`delete_file`→`delete`、`run_command`→`execute`、其余→`other`；允许按工具名覆盖。
- `title` 来自 `present.label/summary`，缺失时回退工具名。
- `locations`：从工具输入里的路径字段（`path`/`file`/`files`）解析为相对 `rootPath` 的绝对路径；行号可推导时带上。
- `diff`：编辑/写入类工具，从工具输出或 `previewEdit` 产出 `oldText`/`newText`；不可靠时退化为文本 content。

### 决策 4：能力矩阵（如实声明）

| 能力 | 声明 | 说明 |
|---|---|---|
| `protocolVersion` | `1` | v2 仍为 draft，不采用 |
| `promptCapabilities.text/resource_link` | 基线 | 必须 |
| `promptCapabilities.image/audio/embeddedContext` | 按 CoreEnv/模型能力 | 与既有多模态能力对齐 |
| `loadSession` | `true` | 有持久化与 `session.resume` |
| `sessionCapabilities.resume/close` | `true` | 有 resume / 可关闭 |
| `sessionCapabilities.delete/additionalDirectories` | 视实现 | 未实现则不声明 |
| `mcpCapabilities.http` | 按 CoreEnv | stdio MCP 必支持 |
| `authMethods` | `[]` 或终端 auth | 无交互鉴权时为空数组 |
| client `fs`/`terminal` | **不使用** | 我们用自有 CoreEnv，正确忽略其声明 |

### 决策 5：权限与结构化输入

- approvals（`interaction` 通道）→ `session/request_permission`；outcome → `respondApproval`；`session/cancel` → 全部以 `cancelled` 收束。
- `ask_user` → `elicitation/create`（form）；client 未声明 `elicitation` 时降级为 agent message + 取消式收束，避免永久挂起。

### 决策 6：`AgentSession` 契约——充分，仅一处 ADDED

**完整核对（现状）**：`AgentSession` 提供

- 快照 `AgentSessionSnapshot`：`status`/`name`/`sessionId`/`error`/`pendingApprovalCount`/`mode`/`model`/`messages`/`queues`/`usage`（含 `contextFillTokens`/`tokenLimit`/`cost`）/`todos`/`plan`/`autoMode`/`mcp`/`extensions`/`toolDescriptors`/`interactions`（approvals + ask_user 的 `question`/`options`/`multiSelect`）/`iteration`/`subagents`。
- 通道：`state`/`messages`/`queues`/`usage`/`todos`/`plan`/`tool`/`summary`/`lifecycle`/`extension-ui`/`extensions`/`tool-presentation`/`mcp`/`mode`/`interaction`/`iteration`。
- 命令：`send`/`steer`/`followUp`/`forceSubmit`/`stop`/`clear`/`respondApproval`/`addToolResult`/`setClientToolWaiting`/`compact`/`rename`/`rename.generate`/`mode.set`/`mode.toggle`/`plan.*`/`mcp.refresh`/`extension.toggle`/`extension.invokeCommand`/`extension.getCommandOptions`/`session.resume`/`session.list`/`session.new`/`session.clone`/`session.fork`/`usage.history`/`effort.set`/`model.set`。
- Host：`create`/`connect`/`list`/`destroy`。

**逐条映射结论**：ACP 的全部出站变体与入站方法都能落到上述表面；**stop reason** 也够——`lifecycle` 通道已带 `agent:stop.reason` 与 `llm:response.finishReason`（`length` → `max_tokens`，`current==max` → `max_turn_requests`）。

**唯一缺口（需 ADDED 到 `session-host-api`）**：

- **slash 命令目录不可枚举**：内置命令元数据只在 `@codent/app`（`getAllCommands`），headless 宿主（ACP）不应 import app；扩展命令摘要只有 `{name, hasOptions}`，缺 `description`。→ 新增需求：core 导出内置命令目录（单一事实来源，app 派生），会话扩展摘要补 `description`。见 `specs/session-host-api/spec.md`。

**其余缺口（全在 ACP 层，不改 core）**：

1. **part 级增量**：新增 `AcpProjector`（本包）。
2. **tool kind/locations/diff**：新增映射表与派生（本包）。
3. **usage mapping**：`used/size/cost` 从 `usage` 快照映射。
4. **modes 元数据**：`availableModes` 的 name/description 用 ACP 层静态表（`normal`/`auto`/`plan` 稳定），非 session 契约。
5. **elicitation 答案**：`ask_user` 经 `addToolResult` 注入（输出为 `askUserOutputSchema`），ACP 层负责 elicitation 结果到该输出形状的映射。

> 因此 `Modified Capabilities` 恰为 `session-host-api` 一条（ADDED 需求），其余均为新增 ACP 能力。

### 决策 7：入口与进程卫生

- 严格保证 **stdout 只写 JSON-RPC**；日志走 stderr（可汇聚到 agent log），避免污染协议。
- 处理 `SIGINT`/`SIGTERM`/stdin 关闭，优雅关闭所有会话（`Host.destroy`）。

## Risks / Trade-offs

- **协议漂移（ACP v2 draft）** → 只实现稳定 v1；把版本/能力集中在一处便于升级。
- **remote 传输是实验态** → 本变更只做 stdio（local-first），复用场景限定在“同机 spawn”。
- **Registry 需要鉴权** → 无 auth 时进不了策展表，但可用 `"type":"custom"` 手动配置；交互鉴权列为后续。
- **长会话帧体积** → part 级增量 + 节流 + 重建安全网；有测试兜底（帧体积与变化量成正比）。
- **工具 diff 保真度** → 从输出/`previewEdit` 尽力；不可靠时退化文本，MUST NOT 伪造 diff。
- **取消语义** → 必须捕获所有中止异常并返回 `cancelled`，不能冒泡成 JSON-RPC error。
- **并发 prompt** → 每会话串行；跨会话隔离，用按 `sessionId` 的映射与游标保证。

## Migration Plan

- 纯新增，默认不影响任何现有 host；无需迁移。
- 发布：`codent` release host 增加 `acp` 子命令；用户/编辑器配置 `command: codent, args: ["acp"]`（或 `npx codent acp`）。
- 回滚：删除该命令/包即可，无数据迁移。

## Open Questions

- 内置命令目录以何种形态从 core 导出（常量 vs 函数）？——实现阶段定。
- `session/load` 回放的粒度：逐条消息回放 vs 折叠压缩后回放？——倾向按持久化 UIMessage 逐条回放，压缩摘要用 `compaction_update`。
- `plan` 模式（explore→review→build→retro→verify）如何在 ACP 呈现：`_meta` 还是 config option？——先 `_meta`，跟进 ACP Config Options 稳定后迁移。
- 是否/何时实现 ACP client（`im-bridge` 驱动任意 agent）——本变更外，单独提案。
