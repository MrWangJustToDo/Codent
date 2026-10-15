# Implementation checklist

## 1. core: 补齐 `cwd()`（唯一需要新增的成员）

- [x] 1.1 `packages/core/src/env/index.ts`：`CoreEnv` 增加 `cwd?(): Promise<string>`，语义 =
      **本 env 执行命令的默认目录**；`resolveCoreEnv()`（:442）默认化为 `() => env.rootPath`
- [x] 1.2 ⚠️ **Node 不要实现 `cwd()`**：`native-run.ts:61` 的 `runCommand` 默认目录本来就是 `rootPath`
      （`options?.cwd ? resolvePath(options.cwd) : rootPath`）。实现成 `process.cwd()` 会在
      `--cwd <path>` 时与 `rootPath` 不一致 —— 而调用方拿 `cwd()` 正是要给它当默认值。
      吃 1.1 的默认即可。若将来确需"进程 cwd"语义，另起名（如 `processCwd()`）
- [x] 1.3 **不新增** `execFile` —— 它已存在（`env/index.ts:316` 声明、`node/src/index.ts:218` 实现、
      `exec-args.ts:99` 在用），本 change 只让 client env 提供实现

## 2. acp: client-backed env

- [x] 2.1 新增 `packages/acp/src/client-env.ts`：
      `createAcpClientEnv({ client, sessionId, rootPath, fallback })`
- [x] 2.2 守卫（唯一位置）：`isLocalOnlyPath(rootPath, path)` → `.agents/` 前缀或不在 `rootPath` 内
      ⇒ 委托 `fallback`
- [x] 2.3 `fs.readFile` → `fs/read_text_file`，**始终不携带 `line`/`limit`**（core 的 `readFile`
      本来就没有行参数，行窗口由 `read_file` 工具在返回内容上自行切分 —— 见 design #7）
- [x] 2.4 `fs.writeFile` → `fs/write_text_file`
- [x] 2.5 **省略 `fs.readFileRange`**（不定义），使调用方按既有契约回落整文件读
- [x] 2.6 必选 fs 成员（`readdir`/`stat`/`remove`/`mkdir`/`exists`）→ **委托 `fallback`**，
      不得抛错、不得返回空结果
- [x] 2.7 `execFile` → `terminal/create`（形状天然对齐：`command` + `args`）；
      **client 未声明 terminal 时省略该成员**，不要定义成抛错
- [x] 2.8 **`exec` 与 `runCommand` 一律委托 `fallback`**（不要用 `sh -c` 包装 `terminal/create`
      自造第二条自由文本路径；这同时保证审批分析与实际执行是同一个 shell）
- [x] 2.8b 终端输出读取：有界轮询（间隔 + 退避）取最终结果即可 —— `execFile` 是**完整返回**，
      **不要**为它写增量投递逻辑
- [x] 2.9 client 未声明的可选能力（`createLspConnection`/`createMCPStdioTransport`/
      `createIsolateDriver`）→ **不定义**（`createIsolateDriver` 若必须存在则返回 `null`）
- [x] 2.10 `cwd()` 返回**会话的工作目录**（客户端 `terminal/create` 的默认 cwd；由 `initialize` 的
      client 根/会话 cwd 推出），语义与 1.1 一致 —— 不得返回 `process.cwd()`
- [x] 2.11 `path` 用既有的 `defaultPath`

## 3. acp: 接线与开关

- [x] 3.1 `packages/acp/src/bin.ts` + `bootstrap.ts`：新增 `--client-env`；开启时**不**为整个进程
      注册单一 env，改为按会话 `CodentAgent.create({ env: clientEnv })`（fallback = 既有本地 env）
- [x] 3.2 `agent.ts`：在 `initialize` 保存 `clientCapabilities`（已有 `initCaps`），
      按会话构造 client env（能力按方法粒度探测）
- [x] 3.3 ⚠️ 记一笔待实现时**必须验证**的事（本 change 不修，但要在验证里覆盖）：
      `resolveShellKind()` 走的是 `getEnv()`（**ambient 注册表**，`command-parser.ts:68`），
      不是 session 的 `coreEnv`。client-env 下要先确认 agent 侧注册的是哪一个 env，
      并断言「审批用的 shell 判定」与「实际执行命令的 env」一致
- [x] 3.4 每次构造记录一条日志：测得的能力矩阵与全部**回退点**（不含敏感值）
- [x] 3.5 `packages/acp/README.md`：新增开关说明、`.agents` 本地不变量、
      **授权方转移只适用于文件访问与 argv 型执行**（自由文本命令的审批仍在本地）、
      **自由文本命令仍跑本地 shell** 这一能力边界

## 4. 验证

- [x] 4.1 `pnpm --filter @codent/acp run validate:acp`：新增
      a) 开关关闭态：断言零 `fs/*`、零 `terminal/*` 请求（与今天一致）
      b) 开启 + 全能力 client：读/写/`execFile` 都经 client，且携带正确 `sessionId`
      c) 开启 + 只声明读：写回落本地（**断言不抛错**）
      d) 开启 + 未声明 fs/terminal：`readdir`/`stat`/命令全部由 fallback 服务，
         且 `execFile` **不被定义**（`Boolean(env.execFile)` 为 false）
      e) `.agents` 守卫：断言 `.agents/**` 的读写零 client 请求
      f) 工作区外路径：断言零 client 请求
      g) 行参数：断言 `fs/read_text_file` 请求**不含** `line`/`limit`
      h) 自由文本：断言 `exec`/`runCommand` 零 client 请求（全部走本地），
         且 `execFile` 才是唯一经 `terminal/create` 的路径
      i) `cwd()`：断言它等于 `rootPath`（而非 `process.cwd()`），
         且在 `--cwd` 与 `process.cwd()` 不同的启动参数下仍如此
- [x] 4.2 断言 `execFile` 经终端时**完整返回** `{stdout, stderr, code}`（不做增量断言）；
      无输出时不忙等；并断言 `run_command` 的增量仍来自本地环境（与今日一致）
- [x] 4.1k 可选成员转发：`appendFile`/`rename`/`startCommand`/`getShellInfo` 存在且写 `.agents/**` 时零 client 请求
- [x] 4.1j 授权方转移（`approvals.ts` + `agent.ts`）：
      a) 开关关态：写审批仍经 `session/request_permission`（行为不变）
      b) 工作区内写 + `fs.writeTextFile`：**零** permission 请求（且答案是放行，不是静默拒绝）
      c) `.agents/**`、工作区外、缺 `fs.writeTextFile`：仍提示
      d) `delete_file` / `kill_command` / `run_command`：**永不**转移（`fs/*` 无删除方法）
      e) `plan` 模式：仍提示
      变异取证：E（`delete_file` 也转移）抓 2 条；F（去掉路径/能力守卫）抓 7 条；G（去掉 plan 守卫）抓 1 条
- [x] 3.7 转发回退环境的**可选**成员（`appendFile` / `rename` / `startCommand` 等），使
      `.agents/**` 的落盘与会话日志不受影响：`appendFile` 缺失会让日志 sink 静默拒绝挂载
      （`jsonl-file-sink.ts:67`），即整个会话失去日志文件。同步三件套（`appendFileSync` 等）**不**转发，
      sink 本就退化为异步 flush。变异 H（不转发 `appendFile`）抓 1 条
- [x] 3.6 `packages/acp/src/approvals.ts`：授权转移的唯一判定处（工具→能力映射 + 路径判定），
      并在 README 写清「哪些转移、哪些不转移、为什么」
- [x] 4.3 `pnpm build && pnpm lint && pnpm typecheck`、`pnpm --filter @codent/app test`
- [x] 4.4 `pnpm --filter @codent/core run` 既有守卫（新增 env 成员不得引入第二份实现）
- [x] 4.5 `openspec validate add-acp-client-env --strict`

## 5. 第五轮审计（--client-env 通读）—— 逐条核实并修

审计结论：报告 3 个 bug + 6 项小问题、以及「校验脚本看不见 create 期间的读取」这一共同盲点，**全部属实**。

- [x] 5.1 🔴 **Bug A：`session/new` 静默丢掉项目指令**。`host.create` 期间会读工作区文件
      （`AGENTS.md`/`CLAUDE.md`、`.lsp.json`、`.mcp.json`），而 `sessionId` 尚未绑定 → 旧的
      「未绑定即抛错」被 `instruction-files.ts:113` 的裸 `catch` 吞掉 → 报「没有指令文件」→
      每个新会话都没有 `<project_instructions>`；load/resume 因为先 bind 而正常（不对称即掩盖点）。
      **修法（报告首选）**：`sessionId()` 改为返回 `string | undefined`，未绑定时
      **委托 fallback** 并计一条 `no-session-yet`。不变量从「必须保持顺序」变为「永不失败」。
- [x] 5.2 🟠 **Bug B：`execFile` 忽略 `signal`**。`exec-args.ts:99` 确实在透传，client-env 从未读它
      → Esc 停不掉，一直轮询到 10 分钟 deadline。**修法**：轮询每轮检查 `signal`；中止时
      `terminal/kill` + release 并抛 `ExecutionError("aborted", …)`（与本地 env 契约一致）；
      已中止的信号**不再创建终端**。
- [x] 5.3 🟠 **Bug C：超时/截断被当成「成功、零匹配」**。deadline `break` 落到
      `{ stdout, stderr: "", code: null }`，无 `killed` → `exec-args.ts:155` 放行部分输出。
      **修法**：deadline 与 truncated 均返回 `killed: true` + stderr 说明 + `terminal/kill`，
      让调用方回落到进程内实现。
- [x] 5.4 小问题：① `routesWriteToClient` 改为纯查询（不再经 `mustFallback` 污染计数）；
      ② `note()` 分桶改为 `localOnlyPath` / `localNoCapability` / `other`（字节读、自由文本、
      二进制写属**有意本地路由**，不再算作「缺能力」）；③ `session/new` 失败时
      `runtime.dispose()`（新增 try/catch，避免泄漏 per-session env）；
      ④ 补注释说明 argv 路径 stderr 恒空（ACP 单缓冲）；
      ⑤ 修正 `approvals.ts` 中「argv 执行自带审批」的措辞（无此分支）；
      ⑥ 修正 env 工厂关于「create 期间只有 `.agents/**` 会跑」的旧注释。
- [x] 5.5 **补端到端用例（盲点）**：新增 `validate-acp-client-env-bootstrap.mjs`，
      真 `createNodeEnv` + 真 `CodentAgent` + 真 `host.create` + 含 `AGENTS.md` 的工作区，
      断言 `session:doc` 事件带上项目指令；另有一条「client 拒绝一切请求仍能创建成功」。
- [x] 5.6 变异取证：I（去掉未绑定守卫）抓 3 条；J（轮询忽略 signal）抓 1 条；
      K（超时伪装成功）抓 2 条；L（终端不 kill）抓 2 条

## 6. 第六轮审计（修复回归）—— 逐条核实并修

结论：报告 5 项**全部属实**，其中 #1 是**本次修复新引入的回归**。类型层发现也已实证。

- [x] 6.1 🟠 **回归：进程已退出且输出被截断时，截断信号丢失**。`endedBy` 重构让 exit 先赢，
      而 `TerminalOutputResponse.truncated` 与 `exitStatus` **可以同时存在**（进程已结束 + 缓冲区被
      字节上限裁过）→ 被裁的 stdout 当作完整结果（grep 少报匹配、静默）。修复前的代码在循环**外**
      用 `if (truncated)` 兜住，所以这是回归。**修法**：`endedBy = truncated ? "truncated" : "exit"`。
      变异 M 抓 2 条。
- [x] 6.2 🟠 **`execFile` 是唯一没有「未绑定即降级」守卫的 client 路径**。四处直接发
      `sessionId: sessionId()` → 未绑定时发出 `undefined`，与「can never fail」不变量矛盾。
      当前不可达（create 期间无 argv 调用），属潜在洞。**修法**：补 `!hasSession()` ⇒ 委托
      `fallback.execFile`；无回退则返回 `missing: true`（`execArgsCapture` 既有的「不支持」形状），
      而非抛错。变异 N 抓 2 条。
- [x] 6.3 **类型层发现（已实证）**：`pnpm typecheck` 拦不住这类错误 —— `AgentContext.request` 有第二个
      宽松重载（`method: string, params?: unknown`，`acp.d.ts:176`），收窄重载匹配失败后被它吞掉。
      我用 `sessionId: 12345` 写了个探针，`tsc` 通过 ⇒ 这四处请求的参数**不受 schema 校验**。
      结论记入 tasks，不改代码（属 SDK 形状，非本 change 范围）。
- [x] 6.4 🟠 **`instruction-files.ts` 裸 catch 仍会掩盖「client 拒绝」**。新增
      `InstructionDiscoveryOptions.onReadError` 钩子 + `AgentDocLoadResult.readErrors`；
      `agent-factory` 在无内容但有读错时 `log.warn`。并在
      `validate-instruction-imports.mjs` 加一节断言（存在但读失败 ≠ 不存在）。变异 O 抓 1 条。
- [x] 6.5 nit **`note()` 对同一请求记两次 + 桶名语义**。`readFile`/`writeFile` 改为「至多一条理由」；
      `no-session-yet` 从 `localOnlyPath` 移到 `localNoCapability`（理由是**何时**，不是**何处**）。
      变异 P 抓 3 条、Q 抓 2 条。
- [x] 6.6 nit **`resumeSession` 失败路径漏 runtime**。与 `session/new` 同样的 try/catch + dispose；
      并补两条断言（new 与 load 的失败都必须释放）。变异 R 抓 1 条、S 抓 1 条。
