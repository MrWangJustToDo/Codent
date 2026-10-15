## Context

ACP 的 client 能力面（`@agentclientprotocol/sdk` `types.gen.d.ts`）：

```
ClientCapabilities = { fs?: { readTextFile?: boolean; writeTextFile?: boolean }, terminal?: boolean, session?, ... }
ReadTextFileRequest   = { sessionId, path, line?, limit? }     // line/limit 是【行】语义
WriteTextFileRequest  = { sessionId, path, content }
CreateTerminalRequest = { sessionId, command, args?, env?, cwd?, outputByteLimit? }   // 无 shell
terminal/output       → { output, truncated, exitStatus? }
terminal/wait_for_exit → { exitCode?, signal? }
terminal/kill / terminal/release
```

core 侧现状（已核实，含几处与直觉相反的）：

| 事实 | 位置 |
|---|---|
| `CoreEnv` **没有** `cwd` 概念（`env/index.ts` 里的 `cwd` 只出现在 exec/runCommand 的 **option** 上）；只有 `rootPath` | `env/index.ts:167,200,244` |
| `execFile` **已经存在并已实现**（`env/index.ts:316` 声明、`node/src/index.ts:218` 实现、`exec-args.ts:99` 在用），`CoreEnvExecFileOptions` 也已导出（`:194`） | 同上 |
| 可选成员不止那 3 个同步 API：`readFileRange?`(:129)、`appendFile?`(:143)、`rename?`(:149)、 以及 `execFile?`/`startCommand?`/`getShellInfo?`/`createMCPStdioTransport?`/`createIsolateDriver?` 等 | `env/index.ts` |
| `jsonl-file-sink.ts` 的 `flushSync` **已有**「无 `appendFileSync` 就退回异步 `flush()`」分支 | `agent/log/jsonl-file-sink.ts:181-186` |
| `readFileRange` 是**字节半开区间** `[start,end)`，宽松解码；调用方按行锚点自行丢弃边缘 | `env/index.ts:111-129` |
| `createIsolateDriver?()` 的契约是**返回 `null`** 表示不支持，调用方判 falsy 后告警降级 | `env/index.ts:389`、`code-mode/extension.ts:170` |
| `createMCPStdioTransport` 缺失时由 `McpManager` 自己抛出可读错误（即"省略成员"是契约） | `mcp/manager.ts:44` |
| `createLspConnection` 缺失 → 告警「LSP tools will be unavailable」 | `lsp/extension.ts:200,210` |
| **command-safety 在工具/控制器层**（`run-command-tool.ts` 引入 `analyzeCommand`、 `agent-chat-controller.ts:653` 应用审批规则），**不在 `env.exec` 路径上** | `agent/tools/run-command-tool.ts:7-8`、`managers/controllers/agent-chat-controller.ts:653` |
| `env.exec`（必选成员）**全仓库零调用点**（`grep '\.exec('` 只命中 RegExp） | — |
| 每个 ManagedAgent 的 env 来自「拥有它的 runtime」 | `managers/agent-run-deps.ts:139` |
| ACP 目前 `registerCoreEnv` 一个进程级 env、只建一个 runtime | `packages/acp/src/bootstrap.ts:60,140` |

## Goals / Non-Goals

- Goals：让 client 的 fs/terminal 真正被用上（编辑器 diff、终端视图、权限）；默认行为零变化。
- Non-Goals：不做 `providers/*`；不重构 core 的 runtime 装配；不把 client 的 `fs/read_text_file`
  当作读 `.agents/**` 的通道；不新增 `execFile`（已存在）。

## Decisions

### 1. 每会话一个 env（不是每进程）

三个 ACP client 方法都带 `sessionId`，且 client 是按会话授权/展示的。因此 client-backed env 必须绑定单一会话。
好处是既有机制已经支持：`CodentAgent.create({ env })` 就是「一个 runtime 一个 env」
（`agent-runtime-instances` spec 已把这条写成 requirement）。代价是 ACP 不能再共用一个 runtime
（今天 `bootstrap.ts:140` 只建一次）—— 开启开关时改为按会话 `CodentAgent.create`，每个 runtime 仍是
「一个 env + 一个 provider + 一个 host」，契约不变。

### 2. `.agents/**` 永远走原 env（本 change 最重要的一条）

会话日志、媒体（`.agents/media`）、记忆、计划、扩展与配置文件都在 `.agents/` 下。把它们交给 client 有两个
独立的坏结局：

1. **可用性连续性被判给 client**。client 一旦拒绝（用户不授权、路径在 workspace 之外、把 agent 的
   `.agents/` 排除在可见范围外），agent 就无法持久化会话 —— 一个「看代码」的 agent 把「记住对话」弄丢了。
2. **`.agents` 不是工作区源码**。VS Code 类 client 的 `readTextFile` 实现通常带 workspace 可见性策略，
   隐藏目录常常不在其中；把核心存储押在它上面是把 agent 的存储可靠性外包给编辑器的 UI 决策。

因此 client-backed env 的 fs 方法对 `.agents/` 前缀（以及任何非 `rootPath` 内的路径）SHALL 直接委托给
原 env，且这条规则必须在实现里只有一个位置（不在每个工具里重复判断）。

### 3. 能力缺失 = 省略成员或委托回退（**不是**定义成抛错）

这是本 change 最需要对齐仓库既有教训的一条。`packages/server/src/client.ts:250-260` 记录了同一个坑：
早期版本「总是定义 `execFile`、让它失败」，结果工具按**成员存在性**探测后走了 argv 路径并抛出，
而不是回落到字符串路径 —— 「降级而不崩」的契约被反转。

本项目按存在性（或 falsy 返回）探测的成员，已核实：

| 成员 | 探测点 | 契约 |
|---|---|---|
| `execFile` | `canExecArgs() = Boolean(env.execFile)`（`exec-args.ts:175`）；`exec-args.ts:91` 判缺失后 `:99` 才调用 | 省略 |
| `fs.readFileRange` | `session-journal.ts:107,225`、`read-file-tool.ts:420` | 省略 → 整文件读 |
| `fs.rename` | `session-journal.ts:166`、`write-file-tool.ts:62` | 省略 → 就地截断重写 |
| `fs.appendFile` | — | 省略 |
| `createLspConnection` | `lsp/extension.ts:200,210` | 省略 → LSP 不可用（告警） |
| `createMCPStdioTransport` | `mcp/manager.ts:44` | 省略 → 由 manager 抛可读错误 |
| `createIsolateDriver` | `code-mode/extension.ts:170` | **返回 `null`** → 禁用 code mode |
| `appendFileSync` / `mkdirSync` / `existsSync` | `jsonl-file-sink.ts:181` | 省略 → 异步 flush |

因此 client-backed env 的策略是：

- **client 有能力**（且路径在工作区内、不在 `.agents/`）→ 路由到 client；
- **client 没有能力** → **委托给工厂已持有一个完整本地 env**（ACP 场景下 fallback 永远存在）。
  `readdir` / `stat` / `remove` / `mkdir` / `exists` 这些是 `CoreEnvFs` 的**必选**成员（不能省略），
  而 fallback 完全能服务它们 —— 委托是唯一不破坏降级的做法；
- **`not_supported` 只留给「client 与 fallback 都做不了」的成员**。配一个完整本地 fallback 时这个集合
  实际上是空的，所以它是一条逃生舱规则，不是默认策略。

`fs.readdir`/`stat` 若定义成抛错会更糟：`list_file`/`tree`/`glob`/`grep` 会在整个工作区不可用，
而 fallback 明明能服务它们。

### 4. `exec` 与 `runCommand` 一律委托回退；client 终端只服务 `execFile`

这是本 change 最容易自相矛盾的一处，必须一次说清。`terminal/create` **只接受 `command` + `args`（无 shell）**，
而 `exec` 与 `runCommand` 都是**自由文本**。若要经终端实现它们，就必须自己拼 `sh -c "…"`。

结论：**`exec` 与 `runCommand` 一律委托给回退（本地）env；client 终端只用于 `execFile`**
（`command` + `args`，与 `terminal/create` 形状天然对齐）。理由：

1. **不凭空发明一个我们控制不了的 shell**：拼 `sh -c` 等于在 client 通道上重建 shell 语义，
   而引号/展开/管道由谁负责在 client 侧并无保证。
2. **审批分析与实际执行必须是同一个 shell**。command-safety 的语法选择来自 `env.getShellInfo()`
   （`command-safety/command-parser.ts:67-76`，缺失时返回 `"unknown"`，调用方需保守处理）。
   若 client env 把 `runCommand` 交给一个未知 shell，而审批分析基于另一个 shell，两者就脱节了。
   委托回退让“分析的”与“执行的”始终是同一个。
3. **`exec` 全仓库零调用点**（只命中 RegExp 的 `.exec(`），风险本就很低，不值得为它开第二条路径。

**安全论证按事实重写**：命令安全检查**不在 `env.exec` 路径上** —— 它在工具/控制器层
（`run-command-tool.ts` 引入 `analyzeCommand`、`agent-chat-controller.ts:653` 应用审批规则）。
所以本 change 的安全性理由是：*不新增一条 shell 语义不明的自由文本执行路径，也不需要把
审批检查补到第二处*；而不是原文写的「检查位置因此不变」（那个前提是错的）。

> 后果：`--client-env` 下 client 的终端只承接 argv 型命令（glob/grep/tree 的 `execFile` 调用）。
> `run_command` 仍跑在本地 shell 上。这是一个**有意**的能力边界，不是遗漏 ——
> 它让「审批基准与执行基准一致」这个性质得以保持，而那个性质比「命令跑在编辑器终端里」重要得多。
> 将来若要真正把自由文本命令搬进 client 终端，必须先让 client env 能**如实回答 `getShellInfo()`**，
> 否则审批就是盲审。

### 5. `cwd()` 补为「命令的默认目录」，与既有默认一致（不引入 `process.cwd()`）

`CoreEnv` 没有「当前工作目录」概念（`env/index.ts` 里的 `cwd` 只是 exec/runCommand 的 **option**）。
而 ACP `CreateTerminalRequest.cwd` 是可选绝对路径，调用方需要一个默认值。

语义定为：**`cwd()` = 本 env 执行命令的默认目录**，默认实现返回 `rootPath` ——
这正是 Node 既有的 `runCommand`/`startCommand` 默认（`native-run.ts:61`：
`options?.cwd ? resolvePath(options.cwd) : rootPath`）。

⚠️ **不要让 Node 实现成 `process.cwd()`**：一旦 `--cwd <path>` 使 `rootPath ≠ process.cwd()`，
`cwd()` 就与 `runCommand` 实际使用的默认目录不一致，而调用方拿 `cwd()` 正是为了给它当默认值。
Node **不实现**这个成员（吃 `resolveCoreEnv` 的 `rootPath` 默认）即可。
需要一个“进程 cwd”语义的调用方应当另起名（如 `processCwd()`），不与本成员混用。

> 既有不对称（本 change 不修，只记录）：`exec`/`execFile` 的 native 实现**没有** rootPath 默认
> （`node/src/index.ts:192,227` 直接传 `options?.cwd`），所以只有 `runCommand` 一族默认到 rootPath。
> `cwd()` 以 `runCommand` 为基准定义，因为那才是工具命令行走的路径。

`execFile` **已存在且已实现**（`env/index.ts:316`、`node/src/index.ts:218`），本 change 不新增它，
只是让 client env 提供实现（走 `terminal/create`）。

### 6. 逐域降级按方法粒度

`clientCaps.fs.readTextFile` / `.writeTextFile` 各自独立；`clientCaps.terminal` 是单一布尔。
未声明的域回退到 fallback（见 Decision 3）。

### 7. 行选择参数：core 从不发送它们（不是“透传”）

`CoreEnvFs.readFile` 的签名是 `readFile(path)` / `readFile(path, "buffer")` —— **没有行参数**；
`read_file` 工具在读到内容后**自己**按行切（`read-file-tool.ts:263` 的 `startIdx = (offset ?? 1) - 1`），
从不把 `line`/`limit` 交给 env。

所以事实是：**ACP `fs/read_text_file` 的 `line`/`limit` 永远不会被 core 使用。**
client env 因此 SHALL：

- 总是发出**不带** `line`/`limit` 的 `fs/read_text_file` 请求（一次读全文，与 `readFile` 语义一致）；
- **不得**自行发明行窗口（那会与工具自己的行切重复，且边定义不一致）；
- **不实现 `fs.readFileRange`**（可选成员不定义），使调用方按既有契约回落整文件读。

这样服务的是真实存在的调用（`CoreEnvFs.readFile`），而不是一个臆想的带行参调用。

### 8. client 终端只服务 argv 型执行（无增量投递）

按 decision 4，经 client 终端的只有 `execFile`（argv 型），其契约是返回**完整**的
`{ stdout, stderr, code }`（`exec-args.ts` 的 `ExecArgsResult`）—— grep/glob/tree 拿到结果就返回，
没有增量投递。因此：

- client 终端的输出读取用**有界轮询**（间隔 + 退避）拿到最终结果，MUST NOT 忙等；
- **不存在**「经 client 终端执行、会产生 tool 通道增量」的命令；
- `run_command` 的 stdout/stderr 增量仍由**本地**环境提供（decision 4 的结果），
  与本变更之前逐字一致 —— `acp-session-updates` 的「流式命令输出」行为**不受影响，没有被砍**。

它没有被写成本 change 的目标，是因为它本来就没变；写在这里是为了避免读者把
「client 终端不产生增量」误读成「流式能力被移除了」。

## Risks / Trade-offs

- **两条路径漂移**（本地 env 与 client env 的行为差异）。→ 缓解：两者都实现同一个 `CoreEnv` 接口，
  且 `validate:acp` 对开关的两态都跑；client env 不新增任何 CoreEnv 语义。
- **`cwd()` 触达每个 CoreEnv 实现**。→ 缓解：默认实现返回 `rootPath`，因此只需 client env 覆盖；
  不引入必须实现的成员（放进 `resolveCoreEnv` 的默认化）。
- **权限模型反转**：走 client env 后，**写文件与 argv 型执行**的审批由 client 侧负责，我们的
  `session/request_permission` 在这两类动作上会显著减少。自由文本命令（`exec` / `runCommand`）不在此列
  —— 它们仍在本地执行，审批也仍在本地。→ 缓解：写进 spec（「审批授权方转移」），并在 README 说明
  `--client-env` 的后果。
- **调试变难**（工具不再本地可复现）。→ 缓解：`.agents/**` 仍本地；每次都记录能力探测结果与回退点。

## Migration Plan

1. core：补 `cwd()`（默认化，不改变任何既有实现的行为）。
2. acp：新增 client-backed env 与开关，默认关闭。
3. 验证两态：开关关（与今天一致的行为断言）+ 开关开（mock client 的能力矩阵，含缺能力时的回退断言）。
4. 回滚：去掉开关即回到今天；client env 代码可整体删除，core 的 `cwd()` 保持（有默认值）。

## Open Questions

- `.agents/**` 守卫是否应该做成一个可复用的守卫函数（例如 `isLocalOnlyPath(rootPath, path)`），
  以便将来 ACP 之外的 client-backed env（如 server 侧代理）复用？倾向是，但放在实现阶段定。
- 是否需要为 `--client-env` 增加一个「仅读」的中间档（只用 `fs/read_text_file`）？本 change 不做；
  能力探测已经提供了按域回退的机制，中间档可以作为后续增量。
