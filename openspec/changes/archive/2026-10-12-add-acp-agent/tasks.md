## 1. 包骨架与入口

- [x] 1.1 新建 `packages/acp`（`@codent/acp`），配置 `package.json`/`tsconfig`/`tsdown.config.ts`，依赖 `@agentclientprotocol/sdk` 与 `@codent/core`（`workspace:*`）
- [x] 1.2 实现 `runAcpAgentStdio()`：用 `ndJsonStream(process.stdin, process.stdout)` 接 SDK `agent({ name })`，保证 stdout 只写 JSON-RPC
- [x] 1.3 处理进程卫生：SIGINT/SIGTERM/stdin 关闭时优雅关闭所有会话，日志走 stderr/agent log
- [x] 1.4 `createAcpAgent(options)`：接收一个 `AgentSessionHost`（默认 `createLocalAgentSessionHost`）与模型配置解析（复用 CLI local bootstrap）
- [x] 1.5 `codent` release host 增加 `acp` 子命令与 `codent-acp` bin（自包含打包）

## 2. ACP agent host（协议面）

- [x] 2.1 `initialize`：协商 `protocolVersion: 1`，返回 `agentInfo` 与如实声明的 `agentCapabilities`（`loadSession`/`promptCapabilities`/`mcpCapabilities`/`sessionCapabilities`/`auth`）
- [x] 2.2 `authenticate`（无鉴权 no-op）与 `logout`（声明能力时）
- [x] 2.3 `session/new`：`cwd` → 工作区根，`mcpServers` 接入（stdio 必支持，http 视 CoreEnv），返回 `sessionId` + `modes`
  > `cwd` 校验 + `modes` 已实现；**每会话 `mcpServers` 未接线**——Agent 使用自身的 `.agents/mcp.json`（见 README 已知限制）。
- [x] 2.4 `session/load`：恢复已持久化会话并回放历史（不回放时不触发模型调用）；`session/resume`：恢复不回放
- [x] 2.5 `session/close`：中止并释放会话（等价 cancel + 清理映射）
- [x] 2.6 `session/prompt`：入站内容映射（见第 4 组）→ `dispatch({type:"send"})`，await 运行终态 → 映射 `StopReason`
- [x] 2.7 `session/cancel`：`dispatch({type:"stop"})`，收敛挂起权限，返回 `stopReason:"cancelled"`（非 error）
- [x] 2.8 `session/set_mode`：`dispatch({type:"mode.set"})` 并回 `current_mode_update`
- [x] 2.9 多会话映射与并发控制：`sessionId ↔ AgentSession` 表；同会话 prompt 串行，跨会话隔离

## 3. 出站投影（AcpProjector）

- [x] 3.1 建立订阅层：订阅 `AgentSession` 通道，按 `sessionId` 维护投影游标
- [x] 3.2 一级差分：对 `messages` 全量数组做引用相等比对，得到变化集合（复用 `messages-delta.ts` 思路）
- [x] 3.3 二级差分：按 `(messageId, partIndex)` 对比，assistant 文本只发**追加子串**为 `agent_message_chunk`（稳定 `messageId`）
- [x] 3.4 `agent_thought_chunk`：thinking/reasoning part 增量投影，与回答分离
- [x] 3.5 `tool_call` / `tool_call_update`：首见建 `tool_call`，随后按 `state`/`output` 发 `tool_call_update`（status/content/rawOutput）；流式工具输出经 `tool` 通道转发
- [x] 3.6 `plan`：`todos` → 完整 `PlanEntry[]`（每次整体替换）
- [x] 3.7 `current_mode_update`：`mode` 通道变化时发送
- [x] 3.8 `available_commands_update`：扩展命令（`snapshot.extensions[].commands`）+ 内置命令目录（见第 6 组）；解析 `/cmd` prompt 并 `extension.invokeCommand`
- [x] 3.9 `usage_update`：`used/size` 取自上下文占用与窗口；`cost` 尽力（usage 历史）
- [x] 3.10 `compaction_update`/`compaction_summary_chunk`（门控 `session.compaction`）、`notice`（门控 `session.notices`），未声明时降级为 agent message
- [x] 3.11 `session_info_update`：标题变化
- [x] 3.12 合并/节流与**完整重建**安全网（顺序变化/超阈值/基线缺失），确保无重复/乱序/丢片
  > part 级游标 + 文本收缩重置已保证无重复/丢片；帧体积与变化量成正比。**帧合并/节流**作为性能优化未实现（正确性不需要）。

## 4. 内容与工具映射

- [x] 4.1 入站 `ContentBlock` → `string | ContentPart[]`（text/image/audio/resource/resource_link），按 `promptCapabilities` 门控，未声明类型返回错误或降级
- [x] 4.2 出站内容块：assistant 文本为 Markdown `text`；图片等用对应块；二进制不当文本
- [x] 4.3 tool `kind` 映射表（reads/edits/searches/commands/web→read/edit/search/execute/fetch；delete→delete；默认 other）+ 按名覆盖
- [x] 4.4 tool `locations`：从入参路径派生相对工作区的绝对路径与可推导行号
- [x] 4.5 结构化 `diff`：编辑/写入类工具产出 `oldText`/`newText`（新建时 `oldText: null`），不可靠时退化文本
- [x] 4.6 tool `title`：来自 `present.label/summary`，回退工具名；`rawInput`/`rawOutput` 透传

## 5. 权限与结构化输入

- [x] 5.1 approvals → `session/request_permission`（含 `toolCall` 描述 + `options`：allow_once/allow_always/reject_once/reject_always）
- [x] 5.2 outcome → `dispatch({type:"respondApproval"})`；reject 携带理由；`session/cancel` 使挂起请求以 `cancelled` 收束
- [x] 5.3 `ask_user` → `elicitation/create`（form，JSON Schema 形态）
- [x] 5.4 未声明 `elicitation` 时降级：agent message 呈现问题 + 取消式收束，MUST NOT 永久挂起
- [x] 5.5 交互到 `sessionId`/`toolCallId` 的归属与隔离（跨会话不串扰）

## 6. session 契约补齐（session-host-api ADDED）

- [x] 6.1 在 `packages/core` 新增内置 slash 命令目录（`name`/`description`/参数提示），作为**单一事实来源**
- [x] 6.2 `@codent/app` 的命令注册表改为从该目录派生（移除第二份权威列表，保持一致）
- [x] 6.3 扩展命令摘要补 `description`（`ExtensionInfo.commands`：`{name, hasOptions}` → 含 `description`），会话快照/通道随之携带
- [x] 6.4 ACP 层用“内置目录 + 会话扩展摘要”广告 `available_commands_update`，并把 `/name args` 调用映射回 `dispatch`（内置命令）/`extension.invokeCommand`（扩展命令）
- [x] 6.5 落 `specs/session-host-api/spec.md` 的 ADDED 需求，并新增/更新对应 validate 脚本

## 7. release host 与文档

- [x] 7.1 `packages/codent` 接入 `acp` 子命令与 bin，纳入自包含打包与 `validate:self-contained`
- [x] 7.2 文档：`npx codent acp` / 编辑器（Zed `agent_servers` custom 配置）接入示例
- [x] 7.3 AGENTS.md/README 增补 ACP 入口与能力矩阵

## 8. 验证

- [x] 8.1 `packages/acp` 单测：protocol 方法、stop reason 映射、取消语义、多会话隔离
- [x] 8.2 增量投影测试：帧体积与变化量成正比；文本只发追加；顺序变化触发重建；无重复/乱序
- [x] 8.3 内容/工具映射测试：ContentBlock 往返、kind 表、locations、diff（新建/编辑）
- [x] 8.4 权限/elicitation 测试：四类选项映射、取消收敛、elicitation 降级
- [x] 8.5 端到端 smoke：以 stdio 拉起 `codent acp`，走完 initialize → session/new → prompt（流式）→ cancel 的完整回合
- [x] 8.6 用 ACP SDK 的 client/测试套件（`@agentclientprotocol/sdk` examples / TCK）核对兼容性
- [x] 8.7 命令目录测试：内置目录可枚举且 app 派生一致；扩展命令摘要带 description；`available_commands_update` 含“内置 + 扩展”
- [x] 8.8 `pnpm build` / `pnpm typecheck` / `pnpm lint` 全绿；新增包的 validate 脚本接入 CI
