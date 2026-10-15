# Change: ACP 会话目录（session/list + session/delete + session/fork）

## Why

`codent acp` 现在只 advertise `sessionCapabilities: { resume, close }`（`packages/acp/src/agent.ts:321`），
会话目录、删除、分支在协议层完全缺失。后果是 ACP client 的会话列表只能退化为它自己的本地缓存
（formulahendry/acp-client 的 README 明确写了这个 fallback），已删除的磁盘会话在 client 侧既看不见也删不掉，
而「基于当前会话开一个分支」这种常见动作在 VS Code 里根本没有入口。

而 core 早已具备这三件事的底层能力：`SessionStore.list()` / `SessionStore.delete()`
（`persistence/session-store.ts:250,368`）、`AgentSessionHost.list()`（`agent-session/host-types.ts:100`）、
`session.list` dispatch（`agent-session/types.ts:218`）、以及 `branchSession`（`session-lifecycle-commands.ts:227`）。
缺的是 ACP 侧的映射与能力位。

## What Changes

- **统一 ACP `sessionId` 为磁盘 session id**（本 change 的前提）。今天 `session/new` 返回的是
  `session.id`（= `agent_…`），而 `session/load`/`resume` 要求客户端回传 `ses_…` —— 同一个字段两个 id 空间，
  client 从 `session/new` 拿到的 id 根本喂不进 `session/load`。统一为磁盘 id 后，目录/删除/分支才谈得上。
- **host 补两个目录方法**：`AgentSessionHost.listPersistedSessions()`（磁盘目录）与 `deleteSession(id)`，
  **均为可选成员**。`session.list`/`session.delete` 是会话命令，必须在活着的 `AgentSession` 上 dispatch，
  但今天没有任何**已存在**的会话可 dispatch（`AgentSessionHost` 只有 `create`/`connect`/`list()`/`destroy`，
  `host-types.ts:80-94`）。用一个只为列目录而创建的 ManagedAgent 兜底不可接受（会拉起扩展+MCP+system prompt）。
  做成可选是因为该接口有**两个**实现者：`LocalAgentSessionHostImpl`（有本地 store）与
  `createRemoteAgentSessionHost`（`packages/server/src/remote-session-host.ts:37`，返回
  `{create,connect,list,destroy}` 字面量、且远端没有本地 store）—— 加上必选成员会让后者直接编译失败。
  这与既有可选成员 `getModelProvider?` / `getEnv?` 是同一个模式。
- 新增 `session/list`：以磁盘会话目录为真源，返回 `SessionInfo[]` + 游标分页（`nextCursor`）。
- 新增 `session/delete`：经 host 删除磁盘会话；若该会话在本进程内仍是 live 会话，先关闭再删除。
- 新增 `session/fork`：**对齐 core 的 `session.clone`（整段上下文复制）**，不映射 core 的 `session.fork`
  （后者要求 `upToMessageId`，ACP 的 `ForkSessionRequest` 没有对应字段）。**不携带 `mcpServers`**
  （见 Non-Goals 与 design #4）。
- `session/new` 与 `session/fork` 的响应补上 `configOptions`（`mode` select）。
  `session/load` 与 `session/resume` 的响应形状**本 change 不为其新增该字段**（协议里两者都有
  `configOptions` 字段，这里说的是"我们不新增"，不是"协议没有"）。

## Non-Goals

- **不新增 `session.delete` dispatch 命令**：删除经宿主方法（`Host.deleteSession(id)`）完成。
  经核实全仓库没有任何 `session.delete` 命令的消费点，且 app 的 `/resume` picker 也没有删除入口 ——
  为一件事同时提供「宿主方法」与「dispatch 命令」两条路径是投机 API。若将来 app 侧需要
  会话内删除，再单独开 change 并把确切消费点写进去。
- `session/fork` **不接受 `mcpServers`**：MCP 服务器在 agent 创建时固定
  （`agent-factory.ts:201` 建 `McpManager`、`:350` 建 extension），而按 `add-session-mcp-servers` 的
  requirement 服务器凭据不得持久化 —— 因此 fork 无法"复用原 agent 且换服务器"，也无法事后从磁盘重建。
  在本 change 里 fork 只复制**会话**（消息 + 模型设置），MCP 配置继承源会话；`mcpServers` 参数被显式拒绝
  而不是静默忽略。带 `mcpServers` 的 fork 留作后续（届时形态是"新建 runtime 而不是复用 bridge"）。
  对照：`session/load` / `session/resume` 各自经 `Host.create` 新建 agent，因此它们**接受并下发**
  `mcpServers`（见 `add-session-mcp-servers`）。
- 未声明的 `additionalDirectories` 在**每一个**可携带它的请求上被拒绝（`session/new`、`session/load`、
  `session/resume`、`session/fork`），共用一处判定与同一条错误文本 —— 原先 `session/new` 静默忽略该字段，
  而它正是客户端的默认入口，代价最大。`cwd` 仅作提示（根在握手时固定），不拒绝也不转发。
- 不做 `providers/*`、不做 `session/set_config_option`、不做远端 transport、
  不为远端宿主新增目录路由（见 Impact）。

## Impact

- 受影响 specs：`acp-agent-host`（MODIFIED ×2 — 能力协商 + 会话生命周期映射）、
  `session-host-api`（MODIFIED ×1 — host catalog）、`acp-session-catalog`（ADDED，新 capability）
- **不触碰 `acp-session-updates`**：`configOptions` 是新增内容，写进新 capability 的 ADDED requirement；
  该 spec 既有的「会话模式与切换」（负责 `modes`/`set_mode`/`current_mode_update`）与「会话元信息更新」
  （负责 rename）都保持不变
- 受影响代码：
  - `packages/core/src/agent-session/host-types.ts` + `local-agent-session-host.ts` —
    **可选**的 `listPersistedSessions?()` / `deleteSession?()`
  - `packages/acp/src/agent.ts` — 能力位；`session/list`、`session/delete`、`session/fork` handler；
    **`sessionId` 一律用磁盘 id**（`attach` 按磁盘 id 建映射）；宿主缺目录能力时不声明、调用时明确报错
  - `packages/acp/src/sessions.ts`（新）— 磁盘会话 ↔ ACP `SessionInfo` 映射与游标分页
  - `packages/acp/scripts/validate-acp.mjs` — 覆盖新增面；**并修掉既有 mock host 用 `"sess-old"`
    制造 id 不一致、从而掩盖「id 空间不一致」这一问题的地方**
- **对外 API 影响**：`AgentSessionHost` 在 core 公开导出（`packages/core/src/index.ts:122`）。
  因为两个新成员是**可选**的，这次新增对现有实现者（含 `packages/server/src/remote-session-host.ts`）
  **不构成编译期破坏**；但远端宿主不会具备目录能力，直到它新增对应的 `/api/agent/*` 路由 ——
  那是一个独立的后续 change（本 change 不实现），届时 `packages/server/src/*` 才进入改动范围。
  因此本 change 是「接口向后兼容、能力按宿主而异」，而非对 server 侧的 breaking change。
- 不涉及 core 的 fork/clone 语义变更；不触碰投影层（`projector.ts`）
- **行为变更（唯一一条）**：ACP `sessionId` 统一为磁盘 id —— 见 Migration Plan
