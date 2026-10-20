# Change: add-acp-subagents

## Why

ACP 侧目前把 subagent 完全丢弃，客户端既看不到子代理，也拿不到进度与可读的 task 结果：

- `task` 摘要流在 `projector.onSummary` 里按 `source !== "compact"` 直接 return；
- `subagents` 通道（core 默认订阅）在 projector 的 channel switch 里没有分支，落进 `default`；
- `initialize` 只声明 agent 能力，从不记录 `clientCapabilities.subagents`；
- task 结果以原始对象（`rawOutput`）发给客户端，core 已有的 `formatTaskOutput` 没被使用。

SDK `@agentclientprotocol/sdk@1.8.0`（已安装）已经提供 `subagent_update`、`session_message` /
`session_message_chunk` 与 `StateUpdate`（running / requires_action / idle+stopReason），并且
`AgentSessionHost.connect(subagentId)` 在本地与 remote-session 两种 host 上都能用。缺的是 ACP
host 这一层的协商、投影与生命周期边界，不是 core 的能力。

## What Changes

- **能力协商**：`initialize` 记录 `clientCapabilities.subagents`；不满足时**不发送任何 child
  流量**（公告、child session/update、session_message），但父会话的 task 行照常收尾。
- **公告与状态**：接 `subagents` 通道，对每个 child 在父会话上先发一次 `subagent_update`（之后再
  有任何 child 流量），`state` 由 `AgentStatus` 映射，`taskPhase` 作为 `_meta` 元数据而不是状态。
- **child transcript**：`host.connect(childId)` + 每 child 一个 projector，child 的
  messages / thoughts / tool calls / plan 以 child 的 sessionId 投递；父→子的 task prompt 用
  `session_message`（sender = parent），不冒充用户消息。
- **task 结果**：父会话 task 行的最终 content 用 core 的 `formatTaskOutput`（摘要 + 状态），不再
  发送原始对象；摘要流的增量复用 `tool_call_update` 的 content（同一行，不额外造消息行）。
- **子会话所有权**：child 不进入 `session/list`，不能作为 `session/close|delete|load|resume|prompt`
  的目标；父会话关闭时只停 child projector，不 `host.destroy(childId)`。
- **恢复语义**：`session/load` / `resume` 只公告仍然存活的 child，不回放 child 历史（child 没有
  磁盘会话，父侧 task 行已保留结果）。

## Impact

- 受影响 capability：新增 `acp-subagents`（交叉引用 `acp-agent-host` 的能力协商、
  `acp-session-updates` 的工具行投影、`acp-session-catalog` 的目录边界）
- 受影响代码：
  - `packages/acp/src/agent.ts` — 记录 subagent 能力、child bridge 生命周期、顶层方法拒绝
  - `packages/acp/src/projector.ts` — `subagents` 通道分支、task 行最终 content
  - 新增 `packages/acp/src/child-projector.ts` / `subagent-projection.ts`
  - `packages/acp/src/types.ts` — child 相关的窄接口
  - `packages/acp/README.md`、`docs/acp-im.md`、`AGENTS.md`
  - `packages/acp/scripts/validate-acp-subagents.mjs`（新增）与 `validate:acp` 链
- 外部 ACP 客户端（cc-connect / Zed）无需改动即可获得子代理公告；不支持的客户端行为与今天一致。

## 非目标

- 暂不开放 child mutation（`capabilities.cancel`）——`capabilities` 先以省略/`null` 起步。
- 不回放 child 历史、不把 child 放进会话目录。
- 不改 core 的 subagent 生命周期与 task 工具输出契约（只消费现有通道）。
