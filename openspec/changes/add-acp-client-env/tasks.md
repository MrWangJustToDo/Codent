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
