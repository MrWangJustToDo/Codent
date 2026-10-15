# Implementation checklist

## 1. core: 统一 session id 空间（其余任务的前提）

- [x] 1.1 `packages/acp/src/agent.ts`：`attach` 的 `acpId` 参数一律使用**磁盘 session id**
      （`session.getSnapshot().activeSessionId`），`session/new` 返回它（`host.create` 经
      `managed.ensureSessionData()` 必然已 mint）—— 不修这条，后面三个方法都匹配不上 bridge
- [x] 1.2 ⚠️ **不要**通过重定义 `AgentSession.id` 来"统一"：`local-agent-session.ts:126` 把它定为
      `options.managed.id`（agent id），而 `host.destroy`/`host.connect` 要的正是它 ——
      `closeBridge` 末尾的 `options.host.destroy(bridge.session.id)` 依赖这一点。
      统一只发生在 **ACP 的 bridge 键与出站 `sessionId`** 这一层，core 侧的两个 id 各自含义不变
- [x] 1.3 断言 `session/new` 返回的 id 能直接喂给 `session/load` 与 `session/resume`（同一 id）
- [x] 1.4 修 `packages/acp/scripts/validate-acp.mjs`：去掉用 `"sess-old"` 制造 id 不一致的 mock
      （它正是这个 bug 被掩盖的原因），改为断言 id 空间一致

## 2. core: host 目录方法（可选成员）

- [x] 2.1 `packages/core/src/agent-session/host-types.ts`：`AgentSessionHost` 增**可选**
      `listPersistedSessions?(): Promise<SessionMeta[]>` 与 `deleteSession?(sessionId: DiskSessionId): Promise<boolean>`
      —— 类型是 `SessionMeta`（`agent/persistence/types.ts:67`），**不是** `DiskSessionMeta`（不存在）；
      `DiskSessionId` 在 `agent-session/types.ts:125`
- [x] 2.2 做成可选的**理由要如实写在注释里**：该接口有第二个实现者
      `createRemoteAgentSessionHost`（`packages/server/src/remote-session-host.ts:37`）返回
      `{create,connect,list,destroy}` 字面量且远端无本地 store —— 必选成员会让它编译失败。
      与既有 `getModelProvider?` / `getEnv?` 同风格
- [x] 2.3 `local-agent-session-host.ts`：实现两者 —— 内部
      `new SessionStore(this.manager.runtime?.env ?? getEnv())`（该文件 `resolveBootstrapSessionId`
      已有此模式），委托 `store.list()` / `store.delete(id)`
- [x] 2.4 `deleteSession` 必须先把该会话的所有权释放（`manager.releaseSessionOwnership`）并对
      在飞运行发 `stop`，否则留下写向已删 log 的 append 流
- [x] 2.5 **`deleteSession` 的语义是「live 已关 或 文件已删」**：
      `store.delete(id)` 对不存在的文件返回 `false`（`session-store.ts:351-353`），而
      `session/new` 刚 mint 的会话此时磁盘上**还没有文件**（`ensureSessionData` 只写内存）。
      因此实现里要先判 live：live 存在 ⇒ 关闭并返回成功；否则才委托 `store.delete`
- [x] 2.6 **不要**新增 `session.delete` dispatch 命令（无消费点）

## 3. acp: 能力位

- [x] 3.1 `initialize`：`sessionCapabilities` 增 `list: {}`、`delete: {}`、`fork: {}`（保留 `resume`、`close`），
      **但 `list`/`delete` 仅当宿主提供了对应可选成员时才声明**（见 design #3）
- [x] 3.2 宿主缺 `listPersistedSessions`/`deleteSession` 时，对应请求 SHALL 返回明确 JSON-RPC 错误，不得静默失败
- [x] 3.3 抽出 `sessionConfigOptions(snapshot)` 生成器（`category: "mode"` 的 select），
      供 `session/new` 与 `session/fork` 复用；`session/load`、`session/resume` 不变

## 4. acp: `session/list`

- [x] 4.1 新增 `packages/acp/src/sessions.ts`：`toSessionInfo(meta, rootPath)`；游标 = 复合键 `(updatedAt, id)`
      （单用 `updatedAt` 会在同毫秒丢行 —— 已由变异取证）
- [x] 4.2 `agent.ts` 注册 `methods.agent.session_list`：`options.host.listPersistedSessions()` → 排序/分页 →
      `{ sessions, nextCursor? }`；空目录返回 `{ sessions: [] }` 不报错
- [x] 4.3 不得在 ACP 层拼接 `.agents/sessions/...` 路径

## 5. acp: `session/delete`

- [x] 5.1 `agent.ts` 注册 `methods.agent.session_delete`：若该 id 有 live bridge，先 `closeBridge`
- [x] 5.2 经 `options.host.deleteSession(id)` 删除；仅当**既不 live 也无文件**时映射为 JSON-RPC not-found
- [x] 5.3 断言：删除已持久化会话后 `session/list` 不再包含它；删除**刚 new 未落盘**的会话也成功；
      后续 `session/prompt` 返回会话未知

## 6. acp: `session/fork`
- [x] 6.1 `agent.ts` 注册 `methods.agent.session_fork`：按**磁盘 id**取源 bridge，无则报错
- [x] 6.2 `ctx.params.mcpServers` 非空 → 显式 JSON-RPC 错误（本 change 的 Non-Goal，不得静默忽略）
- [x] 6.3 在源 bridge 上 `dispatch({type:"session.clone"})`；在飞运行会被 core 拒绝，错误文本原样透传
- [x] 6.4 bridge 重键：**先 `bridges.set(newId, bridge)` 再 `bridges.delete(oldId)`**，
      并更新 `bridge.acpId`（`emit` 闭包读它）——否则事件双发或丢帧
- [x] 6.5 返回 `{ sessionId: newId, configOptions }`

## 6b. acp: 未声明的 `additionalDirectories` 在**每个**可携带它的请求上被拒绝

- [x] 6b.1 抽出一处 `rejectAdditionalDirectories` 判定，接入 `session/new`、`session/load`、
      `session/resume`、`session/fork` 四者（fork 原先内联了一份重复实现，已收回）
- [x] 6b.2 **`session/new` 原先静默忽略该字段** —— 是四个入口里代价最大的一个（客户端默认入口），
      现已改为拒绝；检查顺序在创建会话**之前**，因此被拒绝的请求不留下任何会话
- [x] 6b.3 四条路径共用同一条错误文本（客户端无需知道自己发的是哪个请求就能匹配拒绝）
- [x] 6b.4 `session/list` / `session/delete` **不**接入：`ListSessionsRequest` 只有 `cwd?` / `cursor?`，
      `DeleteSessionRequest` 只有 `sessionId`（SDK 已核对），二者无该字段可拒

## 6c. acp: 工作区根在握手时固定（与既有 requirement 的 cwd 句冲突）

- [x] 6c.1 本 change SHALL 把 `acp-agent-host` 的「ACP agent 以 stdio 提供 JSON-RPC 服务」**一并 MODIFIED**：
      该 requirement 原写「`session/new` 的 `cwd` SHALL 作为工作区根」并有「新建会话使用 client 的 cwd」
      scenario，而实现（以及本 change 的 `session/list` scenario）用的是"根在握手时固定、请求的 `cwd` 仅提示"。
      不修的话 archive 后同一 capability 里会留下两条相反规定
- [x] 6c.2 新 scenario：`cwd` 与根不同时 SHALL 以自身固定的根创建会话、MAY 记 stderr 提示、MUST NOT 拒绝
- [x] 6c.3 在备注里写清与 `additionalDirectories` 的**区别**：后者是未声明能力（因此拒绝），
      裸 `cwd` 是每种请求类型的形状字段（无法"不声明"），所以选"固定根 + 提示"

## 6d. acp: `configOptions` 在 `set_mode` 后保持同步

- [x] 6d.1 `session/set_mode` 成功后 SHALL 追加一条 `session/update`（`config_option_update`），
      携带**完整**选项集（协议无增量形态）；原先只有 `session/new` / `session/fork` 的响应带 `configOptions`，
      客户端缓存在创建后就永远不动了
- [x] 6d.2 该值 SHALL 取自**会话状态**而非请求参数：core 的 `setAgentMode()` 返回 `getAgentMode()`，
      模式可能被拒/夹取；重设同一模式 SHALL NOT 重复广播
- [x] 6d.3 断言含"被拒绝的模式不被广播"一条（变异验证：改成回显请求参数会被抓）

## 7. 验证

- [x] 7.1 `pnpm --filter @codent/acp run validate:acp`：**串行跑三个脚本**（本体 + catalog + mcp），
      覆盖 id 统一、`session/list`（分页/空目录）、
      `session/delete`（not_found + live 删除 + **刚 new 未落盘**）、
      `session/fork`（源不动 + 事件只发新 id + 拒绝 mcpServers）、
      **宿主缺目录成员时不声明能力且请求报错**
- [x] 7.2 `pnpm --filter @codent/core run <既有 session 校验>` 与 `pnpm --filter @codent/app test`
- [x] 7.3 **`pnpm --filter @codent/server typecheck`**（确认可选成员没有破坏
      `remote-session-host.ts` 的实现）
- [x] 7.4 `pnpm build && pnpm lint && pnpm typecheck`
- [x] 7.5 `openspec validate add-acp-session-catalog --strict`
