## Context

ACP v1 的会话方法集里，`session/list` / `session/delete` / `session/fork` 三者与 `session/load` /
`session/resume` 不同：它们**不产生新的 live 会话上下文**（`fork` 例外，它产生一个新的 live 会话），
而是围绕"磁盘上已有哪些会话"这个问题展开。本 change 把这层目录能力接到 ACP 上。

决策前已核实的事实：

| 事实 | 位置 |
|---|---|
| agent 目前只 advertise `resume` + `close` | `packages/acp/src/agent.ts:321` |
| `AgentSessionHost.list()` 返回 `{agentId,name,status,createdAt,updatedAt,activeSessionId}`（**live agent** 目录，不是磁盘目录） | `agent-session/host-types.ts:100` |
| host 接口只有 `create`/`connect`/`list()`/`destroy`（+ 可选 `getModelProvider`/`getEnv`），**没有磁盘目录，也没有 store 入口** | `agent-session/host-types.ts:80-94` |
| `session.list` dispatch 已存在，返回 `{sessions:[{id,name,model,updatedAt,createdAt}]}` | `agent-session/local-session-dispatch.ts:225` |
| 磁盘真源在 `SessionStore.list()` / `.delete(id)`；构造只吃一个 env | `persistence/session-store.ts:239,350,100` |
| `branchSession({mode:"clone"})` 复制整段上下文并切换；`{mode:"fork"}` 需要 `upToMessageId` | `agent-session/session-lifecycle-commands.ts:227` |
| `host.create` 经 `managed.ensureSessionData()` **必然** mint 磁盘 id ⇒ `toListEntry` 的条目**必定**有 `activeSessionId` | `local-agent-session-host.ts:47-57,142` |
| 磁盘元数据类型是 `SessionMeta`（**没有** `DiskSessionMeta`）；`DiskSessionId` 在 `agent-session/types.ts:125` | `persistence/types.ts:67` |
| `SessionStore.delete(id)` 对不存在的文件返回 `false`；`ensureSessionData()` 只写内存不落盘 | `session-store.ts:351-353`、`session-service.ts:118-121` |
| `AgentSessionHost` 有第二个实现者 `createRemoteAgentSessionHost`（返回 `{create,connect,list,destroy}` 字面量，无本地 store） | `packages/server/src/remote-session-host.ts:37` |
| `AgentSessionHost` 在 core 公开导出 | `packages/core/src/index.ts:122` |
| ACP `ForkSessionRequest` 只有 `{sessionId,cwd,additionalDirectories?,mcpServers?}`，**无 fork 点字段** | `@agentclientprotocol/sdk` `types.gen.d.ts` |
| `SessionInfo = {sessionId,cwd,title?,updatedAt?,additionalDirectories?}`；`ListSessionsRequest = {cwd?,cursor?}` | 同上 |
| `NewSessionResponse` / `LoadSessionResponse` / `ResumeSessionResponse` / `ForkSessionResponse` **都有** `configOptions` | 同上 |
| ACP `session/new` 返回 `session.id`（= `agent_…`），而 `load`/`resume` 要求客户端回传 `ses_…` | `agent.ts:290` vs `:300` |

## Goals / Non-Goals

- Goals：client 的会话列表接真数据（含已删会话的可见性）；分支可在编辑器内完成；覆盖足够使
  client 能删掉一个不该存在的会话；**先修掉 id 空间不一致**，否则三件事都不可靠地实现。
- Non-Goals：不做 `providers/*`（provider 注册面）；不做 `session/set_config_option`（独立跟进）；
  不做远端 transport；不为远端宿主新增目录路由（目录能力是宿主相关的，见 Decision 3）；
  **不新增 `session.delete` dispatch 命令**（无消费点，见「不新增 dispatch 命令」一节）；
  **`session/fork` 不接受 `mcpServers`**（理由见 Decision 5）。

## Decisions

### 1. 先把 ACP `sessionId` 统一为磁盘 id（其余决策的前提）

今天同一个字段有两个 id 空间：

- `session/new` → `attach(session, initCaps, session.id)`，`session.id` 是 **agent id**（`agent_…`）；
- `session/load` / `session/resume` → `attach(session, clientCaps, sessionId)`，`sessionId` 是**磁盘 id**（`ses_…`）。

后果是：client 从 `session/new` 拿到的 id 喂不进 `session/load`；而 `session/delete`「若该 id 有 live
bridge 先关闭」与 `session/fork`「按 id 取源 bridge」对**从 `session/list` 来的磁盘 id** 永远匹配不上
（bridge 键是 `agent_…`）。现有校验脚本用 mock host + `"sess-old"` 把这个问题完全掩盖了。

因此 ACP 的 `sessionId` 一律用磁盘 id（`session.getSnapshot().activeSessionId`）。
`host.create` 经 `managed.ensureSessionData()` 必然已 mint 磁盘 id，所以这个统一在三个方法上都取得到锚点。

⚠️ 统一发生在 **ACP 的 bridge 键与出站 `sessionId`** 这一层，**不是**通过重定义 `AgentSession.id`：
后者被 `local-agent-session.ts:127` 定为 `options.managed.id`（agent id），而 `host.destroy`/`host.connect`
要的正是它 —— `closeBridge` 末尾的 `host.destroy(bridge.session.id)` 依赖这一点，改 `AgentSession.id`
会把会话销毁一起弄坏。

- 备选：保留 agent id 作 ACP id，另存一张 `acpId → ses_…` 映射。否决 —— 那等于把 id 空间不一致写进
  requirement，且 `session/list` 返回的是磁盘 id，client 仍会把两者混用。

### 2. 磁盘目录而非 live agent 目录作为 `session/list` 的真源

`Host.list()` 只覆盖本进程内活着的 agent，而 client 的会话列表期望的是「工作区里有哪些可恢复的会话」，
包含本进程从未创建过的历史会话。因此 `session/list` 读磁盘目录（经 core 的 store）。

- 备选：直接用 `Host.list()` — 否决，重启后 client 会看到空列表，正是当前 fallback 的成因。

### 3. host 补 `listPersistedSessions()` / `deleteSession(id)`（**可选**成员），不用幻影会话兜底

`session.list` / `session.delete` 是**会话命令**，必须在活着的 `AgentSession` 上 dispatch；但"列出目录"
与"删一个从没打开过的会话"恰恰发生在**没有任何 live 会话**的时候。用 `host.create` 造一个临时 ManagedAgent
兜底是不可接受的：它会拉起完整 ManagedAgent（扩展、MCP、system prompt），还需要一个 model —— 只为列个目录。

因此给 `AgentSessionHost` 加两个目录方法。它们是 store 的薄委托，与 `list()` 的差别是**数据来源**
（磁盘 vs live），一个 host 同时提供两者是合理的：`list()` 答"现在活着什么"，`listPersistedSessions()` 答"工作区里存了什么"。

**两者必须是可选成员**。该接口有两个实现者：`LocalAgentSessionHostImpl`（有本地 store）与
`createRemoteAgentSessionHost`（`packages/server/src/remote-session-host.ts:37`，返回
`{create,connect,list,destroy}` 字面量，且远端根本没有本地 store）。加上**必选**成员会让后者立刻编译失败，
而且 `AgentSessionHost` 在 core 公开导出（`index.ts:122`），对外同样是破坏性变更。
做成可选与既有 `getModelProvider?` / `getEnv?` 是同一个模式，并且它准确表达了事实：
**目录能力是宿主相关的**。ACP 侧因此要"有能力才声明、缺能力就明确报错"（见 decision 3 与 `acp-agent-host`）。

> 远端宿主要具备目录能力，需要新增 `/api/agent/sessions` 一类路由 —— 那是独立 change，不在本 change 范围。

### 3b. `session/delete` 的成功条件是「live 已关 或 文件已删」

`session/new` 返回的磁盘 id 由 `ensureSessionData()` 在**内存**里 mint，按仓库既有的「首个内容才落盘」
约定，此时磁盘上还没有文件；而 `SessionStore.delete(id)` 对不存在的文件返回 `false`
（`session-store.ts:351-353`）。若直接把 `false` 映射成 not-found，则
`session/new` → 立即 `session/delete` 会对一个**明明存在且刚被 `closeBridge` 关掉**的会话回"不存在"。

因此成功条件定义为：**该会话在本进程内 live（已先行关闭）或磁盘文件已删**。
仅当**既不 live、也从未落盘**时才返回 not-found。这是两个 change 的交集处必须定死的语义。

### 3c. 不新增 `session.delete` dispatch 命令

`add-acp-session-catalog` 的早期草稿同时引入了「宿主方法 `deleteSession(id)`」与「dispatch 命令
`session.delete`」。经核实：**全仓库没有任何 `session.delete` 命令的消费点**，app 的 `/resume` picker
也没有删除入口（只有 `SessionResumePicker.tsx` 的列表/恢复）。

为一件事提供两条路径属于投机 API，且会让「删除到底由谁负责」变成两个真源。
因此**只保留宿主方法**；若将来 app 侧需要会话内删除，再单独开 change 并把确切消费点写进去。

### 4. `session/fork` 映射 core 的 `clone`（整段复制）

ACP 的 fork 请求没有 fork 点，无法表达 core `session.fork` 的「截断到某条更早的 user 消息」。
core `session.clone` 的语义（复制全部消息 + 模型设置，源会话不动，记录 `forkedFrom`）与
ACP `fork` 的描述（"creates a new session based on the context of an existing one … without
affecting the original"）完全一致，因此映射到 clone。

- 备选：把 ACP fork 实现成「在最后一条 user 消息处 fork」 — 否决，语义是猜的。
- 备选：为 ACP 在 core 新增一个 clone 之外的命令 — 否决，core 已有等价能力，加命令是重复。

### 5. `session/fork` 不接受 `mcpServers`（否则两个 change 语义冲突）

MCP 服务器在 **agent 创建时**固定：`agent-factory.ts:201` 建 `McpManager`，`:350` 建 MCP extension。
而按 `add-session-mcp-servers` 的 requirement，服务器凭据**不得持久化**。于是"fork 带一份新列表"
既不能复用原 agent（服务器不可变），也不能事后从磁盘重建（凭据没存）—— 唯一实现是**新建 host.create**，
而这与 Decision 6「复用同一条 bridge」直接冲突。

所以本 change 里 fork 只复制**会话**（消息 + 模型设置），MCP 配置继承源会话；`mcpServers` 参数被
**显式拒绝**（JSON-RPC 错误）而不是静默忽略。带 `mcpServers` 的 fork 留作后续 —— 届时形态是"新建
runtime 而不是复用 bridge"，那是另一个 change 的事（它要决定新 runtime 的 env/provider 从哪来）。

### 6. bridge 重键而不是新建 bridge

`branchSession` 在内部已经 `restoreSession(newId)` 并切换了 ManagedAgent 的当前会话；ACP 侧若新建
一个 bridge，就会得到两个指向同一 ManagedAgent 的订阅者，`session/update` 双发。正确做法是把
**同一个 bridge 的 `acpId` 键**从旧 id 换成新 id（`bridges` 是 `Map<acpId, SessionBridge>`），
并同步 bridge 内部记的 id（`emit` 闭包捕获的是 `bridge.acpId`）。

顺序上必须**先建新键再删旧键**，否则中间态会丢一帧。

### 7. 删除路径不由 ACP 层拼接，也不经 dispatch 命令

ACP 层目前没有任何路径拼接（`rootPath` 只用于 `locations` 呈现）。引入
`await options.host.getEnv()` 再 `.agents/sessions/<id>.session.jsonl` 会把存储布局变成第二个
事实来源。因此删除经由**宿主方法** `Host.deleteSession(id)` 完成：

- 宿主内部委托 core 的 `SessionStore.delete()`，路径知识只有一处；
- 映射为 JSON-RPC 错误成为纯映射（`false` + 非 live ⇒ not-found）；
- **不**同时引入 `session.delete` dispatch 命令（无消费点，见「不新增 dispatch 命令」一节）—— 一件事只有一条路径。

### 8. 分页用 `(updatedAt, id)` 复合游标

`SessionStore.list()` 按 `updatedAt` 降序返回全量元数据（只读每个 log 的最后一行 `state`，不 fold 消息体）。
游标 SHALL 编码**复合边界** `(updatedAt, id)`（`"<epochMs>:<id>"`，与客户端无关的自解释 token），
下一页取全序（`updatedAt` 降序，同值时按 `id` 升序）中**严格晚于该边界行**的行。

只用 `updatedAt` 是错的：同一毫秒创建的两条会话在页边界上会被整页丢掉（第二页要求"严格小于该值"，
而同毫秒的另一条既不小于也不大于）。复合键让顺序成为全序，页间既无重复也无遗漏。

## Risks / Trade-offs

- **id 统一是行为变更**：现有 client 若缓存了 `agent_…` 形态的 id，统一后将无法 resume。
  缓解：这是 stdio agent 的进程级 id，重启即失效，且今天 `session/new` 的 id 本来就喂不进
  `session/load`（即"变了反而能用了"）。
- `session/fork` 依赖 SDK 的 UNSTABLE 能力位。风险是上游改名/改形 → 缓解：能力位命名与请求/响应
  形状集中在新模块里，改动面限于 `packages/acp/src/`，且 `validate:acp` 会断言该位已声明。
- 删除一个正在跑的会话：必须先 `closeBridge`（其内部会 `dispatch({type:"stop"})`）再删文件，
  否则会留下一个写向已删除 log 的 append 流。
- 游标分页对并发写入敏感（列举期间有新会话落盘）。→ 缓解：不以「总数」为前提，允许客户端拿到
  重复/遗漏的容忍度按 `sessionId` 去重；这是 ACP 游标的通用语义。
- ⚠️ **改名理由（曾用 `listSessions`）**：core 已有 `CodentAgent.listSessions()`，它返回 **live agents**
  （`runtime/codent-agent.ts` → `host.list()`，并由 `agent-runtime-instances` 的 requirement 固定）。
  同一个 host 上并列两个同名但语义相反的方法极易误用，因此本 change 的成员命名为
  `listPersistedSessions`，并在 requirement 里写明两者关系（`list()` = "现在活着什么"，
  `listPersistedSessions()` = "工作区里存了什么"）。
- `listPersistedSessions()` 与 `list()` 双入口有被混用的风险。→ 缓解：两者的 requirement 明确各自回答什么，
  且 scenario 断言 `listPersistedSessions()` 包含非 live 会话（这正是它区别于 `list()` 的性质）。

## Migration Plan

纯新增。上线顺序：**id 统一 → host 目录方法（可选）→ ACP 能力位 → 三个 handler**。
回滚即去掉能力位，client 会立刻退回本地缓存 fallback，无需数据迁移。

## Open Questions

- client 侧是否真的会在 `session/list` 之后调 `session/load`（而非自行复用列表项）？若它只缓存元数据，
  游标分页的价值主要体现在长历史工作区，可先按全量返回实现。
- `session/list` 的 `additionalDirectories` 是否值得填？——已收口：`ListSessionsRequest` **没有**该字段
  （只有 `cwd?` / `cursor?`），而 `SessionInfo`（响应侧）的那个字段描述的是会话**实际**激活的额外根，
  本 change 不实现该能力位，故两者都省略。
- 待办已收口：未声明的 `additionalDirectories` 到底哪些请求要拒？——**每一个**可携带它的请求
  （`new`/`load`/`resume`/`fork`），共用一处判定；原先只接了后三者，`session/new`
  （客户端默认入口）仍在静默忽略，是四个入口里代价最大的一个。
