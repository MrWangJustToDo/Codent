## 1. Discard primitive

- [x] 1.1 `TaskPreforkCoordinator.discard(toolCallId, cause)`：摘掉单个条目（排队中的同时出队并 openGate，让它以 stale stub 结束），调用取消句柄，`notify()`，返回 `PreforkDiscard`（toolCallId / cause / subagentIds）。
- [x] 1.2 `PreforkDiscardCause` 增加 `tool-rejected`。

## 2. Tool-phase trigger

- [x] 2.1 `task-prefork` 中间件新增 `onAfterToolCall`：`toolName === task` 且协调器仍持有该 toolCallId 时 discard（`tool-rejected`），并照常 emit `subagent:prefork-discarded`。
- [x] 2.2 注释写明为什么用"settled 但仍注册"而不是枚举拒绝来源（`event.skip` 在 @tanstack/ai 里走 `pushResultAndRunAfterHook`，`ok: true`，无法据 `ok` 判断）。

## 3. Verification

- [x] 3.1 新增 `validate:task-prefork-rejected-call`（`validate-task-prefork.mjs` 已到 800 行上限，故拆成独立脚本，套件按 glob 自动收录）：discard 单元语义（在跑 / 排队 / 不存在三种）、driven `onAfterToolCall`（拒绝即取消并上报）、非 task 工具与已 join 两种对照。
- [x] 3.2 变异验证：注释掉 `onAfterToolCall` 的 discard，新增用例必须失败；恢复后通过。
- [x] 3.3 `pnpm build` / `typecheck` / `lint` / `validate:task-prefork` / `validate:task-prefork-rejected-call` / `run-all-validators --dir packages/core`（237 passed / 1 failed = 既有的 `validate-tanstack-adapter` 环境问题）/ `@codent/app test` 145/145 全绿。
