## 1. 协议面与类型（无行为）

- [x] 1.1 `agent.ts`：`initialize` 记录 `clientCapabilities.subagents`（absent/`null` = 不支持，
  对象含 `{}` = 支持），与 `notices` / `compaction` / `elicitation` 一起进入 session 的 client 配置。
- [x] 1.2 `types.ts`：新增内部窄类型（`SubagentProjection`：child id / title / description /
  state / taskPhase），不把 SDK 的实验类型扩散到 host 其余部分。
- [x] 1.3 校验：能力解析（absent / null / `{}`）的单测，确认 `{}` 被视为支持、`null` 视为不支持。

## 2. 纯投影（可单测）

- [x] 2.1 新增 `packages/acp/src/subagent-projection.ts`：
  `AgentSessionSubagentSummary` → `SubagentUpdate`（`title` 取 description → name → prompt 摘要；
  `description`；`state` 按 design D3 的映射；`_meta.taskPhase`；`capabilities` 省略）。输入先用
  `isUserVisibleTaskRow` 过滤：只有带 `parentTaskToolCallId` 的 task 委派会被公告，compaction /
  memory summarizer 等内部 worker 不公告。
- [x] 2.2 同一模块维护 announce/patch 差分：首次出现发公告，之后只发变化字段；销毁的行不发伪造的
  `idle`（保留最后状态）。
- [x] 2.3 门禁：状态矩阵（running/thinking/… → `running`；waiting/awaiting_user →
  `requires_action`；completed/aborted/error → `idle` + stopReason）与"不重复公告"的纯断言。
  依赖 1.2。

## 3. 父会话公告（projector + host）

- [x] 3.1 `projector.ts`：`onEvent` 增加 `subagents` 分支，调用 2.1/2.2 并把 `subagent_update`
  发到父 `acpId`。
- [x] 3.2 `agent.ts`：处理 `subagents` 快照时**先发公告、再 attach child projector**（design D2），
  不依赖 channel 投递顺序。
- [x] 3.3 门控：能力不支持时 `subagent_update` 一个字都不发；父会话 task 行不受影响。
- [x] 3.4 校验：公告先于 child 首帧、能力缺失时零 child 帧（mock client 两种能力）。依赖 2.x、3.1。

## 4. child transcript（每 child 一个 projector）

- [x] 4.1 新增 `packages/acp/src/child-projector.ts`：用 `AcpProjector`，`emit` 绑定 child 的
  sessionId；`commands` 为空、`compaction` 跟随 client 能力（子代理继承父的压缩配置）、无
  `onInteraction`、`start({ seedState: false })`（design D4）。
- [x] 4.2 task prompt 以 `session_message`（sender = parent，recipient = child，
  `messageId` 由 row 上的 `parentTaskToolCallId` 派生）发布，并抑制该 user 消息的
  `user_message_chunk`；在 projector 里按 message id 做转换（不是事后过滤），live 与 child 初始
  replay 共用同一转换。
- [x] 4.3 `agent.ts`：`childBridges`（按 parent 分组）；announce 后 `host.connect(childId)`、启动
  projector（`seedState: false`）并用 `replayFrom(childSnapshot)` 回放消息；child 销毁时停止；
  父关闭时统一清理。
- [x] 4.4 emit 检查父 bridge 的 `closed` 与能力门控，关闭竞态下丢弃。
- [x] 4.5 校验：child 的 text / thinking / tool / usage 更新带 child sessionId；prompt 是
  `session_message`；无能力时零帧。依赖 3.x。

## 5. task 结果（父会话唯一结果面）

- [x] 5.1 `projector.ts`：task 输出的终态 `tool_call_update` content 使用 core 公开的
  `formatToolOutput(output, "task")`（内部委派到 task 格式化：摘要 + `limit reached` / `cancelled` /
  `stalled` / `cached` 状态行）；task 行永不回退到 `rawOutput`（即使格式化文本为空），也不再发原始
  对象。
- [x] 5.2 task 摘要流的增量复用同一行的 `tool_call_update` content（design D5）：缓冲累计后整段
  重发（ACP 的 tool content 是替换语义），流结束只停止流；最终结果只发一次（与 `end` 先后无关），
  结果已发出后的迟到增量必须丢弃（不得覆盖终态）。
- [x] 5.3 校验：格式化内容、单行、非 task 工具结果路径不变。可与 4.x 并行。

## 6. 所有权边界

- [x] 6.1 `session/list` 不包含 child（child 无磁盘会话；断言而非改动）。
- [x] 6.2 `session/load|resume|prompt|fork` 以 child id 调用时返回 `invalid params`；
  `close`/`delete` 可以按幂等语义返回，但必须在进入存储层前识别 child id 并拒绝/短路
  （判据：已公告的 `childBridges`，或 `AgentSessionHost.list()` 中 `parentId` 非空的条目）。
  `deleteSession` 用 `manager.getAgent(id)` 查 live agent，透传会销毁 child；`load`/`resume`/
  `fork` 也会把 child id 当磁盘 id 恢复。任何路径都不得 `host.destroy(childId)`。
- [x] 6.3 父 `closeBridge`：停止 child projectors、清空 `childBridges`，child 的销毁交给 core。
- [x] 6.4 `session/load` / `resume`：只从 retained `subagents` 公告仍存活的 child；attach child
  projector 时不调用 `replayFrom`（只继续接收实时更新），不回放历史。依赖 3.x、4.x。

## 7. 文档

- [x] 7.1 `packages/acp/README.md`：能力门控、两个可见面（child 会话 = 探索视图，task 行 = 结果）、
  resume 限制、`capabilities.cancel` 暂不开放。
- [x] 7.2 `docs/acp-im.md`：外部 IM/ACP 客户端因此获得子代理进度，无需协议外扩展。
- [x] 7.3 `AGENTS.md`：ACP 段与文件结构补 `child-projector.ts` / `subagent-projection.ts`、
  `validate:acp-subagents`。

## 8. 验证

- [x] 8.1 新增 `packages/acp/scripts/validate-acp-subagents.mjs`，接入 `validate:acp` 链：
  能力两种状态、公告顺序、状态矩阵、child 流、task 结果、顶层方法拒绝、父关闭清理。
- [x] 8.2 变异验证：去掉公告前置 / 去掉能力门控 / 把 taskPhase 塞进 state / 重复发送最终摘要
  —— 各自必须被断言抓住。
- [x] 8.3 `pnpm typecheck`、eslint、完整 `validate:acp`、`build:codent` + `codent acp` 冒烟。

## 依赖与并行

- 1 → 2 → 3 → 4 → 6；5 可与 4 并行；7、8 跟随实现。
- 8.1 的场景按 3、4、5、6 分组编写，先有 mock 两种 client 能力的 harness。
