# Change: 可选的 client-backed CoreEnv（fs/* + terminal/*）

## Why

VS Code 里用 ACP client 驱动我们时，编辑器的原生能力是"看得见的"：diff 视图、终端输出、文件诊断。
但 `codent acp` 现在把一切读写与命令都走自己的本地 CoreEnv（`packages/acp/src/bootstrap.ts:60`
建 `createNodeEnv` 并 `registerCoreEnv`），因此：

- `fs/read_text_file` / `fs/write_text_file` / `terminal/*` 一条都不发（client 侧只有纯文本流，
  编辑无法进原生 diff 审批与撤销栈）；
- client 声明的 `clientCapabilities.fs` / `.terminal` 完全被忽略。

Zed、JetBrains 这类 client 期望「agent 借用编辑器的 fs/终端」，这也是 ACP 设计里 `fs/*`、`terminal/*`
存在的理由。本 change 提供一条**可选**的 client-backed CoreEnv 通路。

## What Changes

- **opt-in，默认行为不变**：新增启动开关（`codent acp --client-env`）。未开启时，env 的构造与
  使用路径与本 change 之前逐字节相同。
- **每会话一个 env**：ACP 的 `ReadTextFileRequest` / `CreateTerminalRequest` 都携带 `sessionId`，
  因此 client-backed env 必然绑定单个会话；绑定方式沿用既有「一个 runtime 绑定一个 env」的机制
  （`CodentAgent`），不新增环境注册路径。
- **`cwd()` 语义 = 命令的默认目录**，与 Node 既有默认一致（`native-run.ts:61`）。
  **Node 不实现它**（吃默认），因为实现成 `process.cwd()` 会在 `--cwd <path>` 时与 `rootPath` 不一致。
- **`.agents/**` 永远本地**：会话日志、媒体、记忆、计划、扩展与配置目录的读写 SHALL 在原 CoreEnv 上完成，
  永不发往 client。
- **能力缺失的模型是「省略或委托回退」，不是「定义成抛错」**：client 没有的能力要么委托给工厂已持有的
  本地 fallback env，要么维持该成员不定义。**MUST NOT 定义一个总是失败的可选成员** —— 仓内已有教训
  （`packages/server/src/client.ts:250-260`）：工具是按**成员是否存在**做特性探测的
  （`canExecArgs()` = `Boolean(env.execFile)`，`exec-args.ts:175`），定义成抛错会让探测翻成"有"，
  把优雅降级变成异常。
- **身份能力补齐**：`CoreEnv` 新增 `cwd()`（语义 = 本 env 执行命令的默认目录，默认 `rootPath`）。
  `execFile` / `readFileRange` / `rename` / `appendFile` **已经存在**（`env/index.ts:316,129,149,143`），
  本 change 只是把 client 侧的对应实现接上，不是新增成员。
- **自由文本命令不经 client 终端**：`terminal/create` 只接受 `command` + `args`（无 shell），
  因此 `exec` 与 `runCommand` 一律委托回退环境（本地 shell），client 终端只服务 `execFile`。
  这既避免发明一个我们控制不了的 shell，也保证命令审批分析所用的 shell 与实际执行的 shell 一致
  （command-safety 的语法选择来自 `env.getShellInfo()`，`command-parser.ts:67-76`）。

## Impact

- 受影响 specs：`acp-client-env`（ADDED，新 capability，含 core 级 CoreEnv 身份与降级契约补充）
- 受影响代码：
  - `packages/core/src/env/index.ts` — `cwd()`（经 `resolveCoreEnv` 默认化为 `rootPath`）
  - `packages/core/src/agent/persistence/session-journal.ts` / `read-file-tool.ts` / `write-file-tool.ts`
    — 不新增代码，但它们的既有探测路径是本 change 的契约依据
  - `packages/acp/src/client-env.ts`（新）— client-backed `CoreEnv` 实现（fs/terminal 桥 + `.agents` 守卫 + 回退）
  - `packages/acp/src/bootstrap.ts` / `bin.ts` / `agent.ts` — 开关、能力探测、按会话构造 env 与 runtime
  - `packages/acp/scripts/validate-acp.mjs` — 覆盖默认关闭与开启两条路径
- 不改 `session-host-api` / `agent-runtime-instances`：既有 requirement 已要求 runtime 携带自己的 env、
  工具从 `ToolRunContext.coreEnv` 读取（`agent/tools/runtime/define-tool.ts:38-43`），
  本 change 是在该契约下新增一个实现
- 无 breaking：默认关闭；开启后按域回退；所有回退点写日志
