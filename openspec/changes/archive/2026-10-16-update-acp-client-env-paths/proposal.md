# Change: client-bound 路径的唯一解析，与 root 的绝对性前提

## Why

`92f5a3bd` 改了 `openspec/specs/acp-client-env/spec.md` 的基线（+86 行）却没有对应 change，
违反「行为增补走 `changes/` → 归档 → 落 baseline」的流程（见 `openspec/AGENTS.md`）。本 change 把那次
改动补成正式 delta，并**顺势修正其中两处照实性问题**（原实现里已改对，spec 未覆盖到的口径）。

根因回顾：`--client-env` 把文件系统外包给 ACP client，却把调用方的**工作区相对路径**原样发过去。
ACP 对 `fs/read_text_file` / `fs/write_text_file` 要求「Absolute path to the file」，`terminal/create.cwd`
要求「Must be an absolute path」；相对路径无法归属任何根，client 会按**自身 cwd** 解析并以
`Path is outside workspace` 拒绝。可见症状不是报错而是**挂起**：写入的审批提示
（`session/request_permission`）永远等不到应答。

本地 env 从不暴露该问题（`native-fs.ts` 的 `resolvePath` 内部解析），所以这是 client-backed 环境
**独有**的义务：它是唯一把文件系统交给别人的层，必须交出 client 能用的路径。

## What Changes

- **唯一解析**：`src/paths.ts` 的 `toWirePath(target, rootPath)` 是发往 client 的路径的唯一来源，
  同时服务 `fs/*` 的两个 body、`terminal/create.cwd` 与 `toolLocationsFor` / `toolDiffFor`。
  此前是两份实现（`tools.ts` 的 `toAbsolute` 做**字符串拼接**、`client-env.ts` 另有一份 `resolve`），
  同一文件可能拼出两种字符串：location 给 `/ws/packages/core/../acp/README.md`，随后的读给
  `/ws/packages/acp/README.md` —— client 眼里是两个文件。归一化随 `resolve` 免费得到。
- **绝对性判定平台感知**：用 `defaultPath.isAbsolute`，不用 `startsWith("/")`。Windows 盘符
  （`C:\dev\x.ts`）与 UNC（`\\srv\share\x.ts`）都不以 `/` 开头，误判为相对会得到
  `<root>/C:/dev/x.ts` —— 指向一个不存在的文件。
- **空 root 不回落 `process.cwd()`**：`pathe.resolve("", t)` 会静默用进程 cwd 兜底，而 host 被指定
  root 后进程 cwd 就是**另一个工作区**。空 root 返回原路径。
- **root 的绝对性是前提，由入口强制**：`resolveRoot()` 与 `toWirePath` 相邻，`bootstrapLocalAcp({ cwd })`
  与 `createAcpAgent({ rootPath })` 两个入口都经它归一化。后者尤其重要：其 root 会出现在 client 可见的
  输出里（`tool_call.location.path` 与 `SessionInfo.cwd`，后者 ACP 也要求绝对）。相对 root 不会报错，
  只会把整会话的路径静默锚到本进程所在目录。
- **`rename` 只在写入未路由到 client 时透传**（能力级门控，代价照实记录，见 delta）。
- **一处口径修正**：`isLocalOnlyPath` 改用 `toWirePath`，把「是否绝对」从两种谓词收敛为一种。
  **照实说明**：这是**卫生改动**，不是可达缺陷 —— 两种实现在所有非空 root 输入下判定一致
  （唯一分歧需要 `rootPath === ""`，而入口归一化后不可达），因此**没有**、也不该有行为断言去钉它。

## Impact

- 受影响 spec：`acp-client-env`（MODIFIED：`发往 client 的路径必须是绝对路径`、
  `rename 只在写入未路由到 client 时透传`）
- 受影响代码：
  - `packages/acp/src/paths.ts`（新）— `toWirePath` + `resolveRoot`
  - `packages/acp/src/tools.ts` / `client-env.ts` — 共用唯一解析
  - `packages/acp/src/bootstrap.ts` / `agent.ts` — 入口经 `resolveRoot` 归一化
  - `packages/acp/src/index.ts` — 只导出 `toWirePath` / `resolveRoot`（**无** `toAbsolute` 别名）
  - `packages/acp/scripts/validate-acp-client-env.mjs` — §9–§11
  - `packages/acp/README.md` — 与注释/spec 对齐的说明
- 无 breaking：全部是「把已经外包出去的那一步补上」，默认关闭的开关语义不变
- **不在本 change 内**：`write-file-tool.ts` 的 `if (fs.rename)` 是「能力存在即可用」的假定，根因在
  core 调用方（它无法知道 env 把写入外包了）。做对需要 core 的路径感知能力（如
  `atomicReplace(path, content)`），属 core API 变更，单独立项
