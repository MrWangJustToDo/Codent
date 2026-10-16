## MODIFIED Requirements

### Requirement: 发往 client 的路径必须是绝对路径

所有携带路径的 client 请求 SHALL 在发出前解析为**绝对路径**：`fs/read_text_file` / `fs/write_text_file`
的 `path`，以及 `terminal/create` 的 `cwd`。ACP 对三者的规范要求是「Absolute path to the file」与
「Must be an absolute path」，而 core 的调用方（`write_file` / `edit_file` / `read_file` / `execFile`）
传入的通常是**工作区相对路径** —— 相对路径无法归属任何根，client 会按**自身 cwd** 解析并拒绝。

该解析 SHALL 只有**一份实现**（`paths.ts` 的 `toWirePath`），由 `fs/*` 的两个 body、`terminal/create` 的
`cwd`，以及 `toolLocationsFor` / `toolDiffFor` 共用 —— `tool_call.location.path` 与随后的 `fs/*` 请求
描述**同一个文件**，MUST NOT 各有一份实现而拼出两个字符串。

#### Scenario: 相对路径按 rootPath 解析为绝对路径

- **WHEN** 一个工具以工作区相对路径（如 `packages/acp/README.md`）触发 `fs/read_text_file` 或
      `fs/write_text_file`
- **THEN** 该请求的 `path` SHALL 是绝对路径，且 SHALL 以 env 的 `rootPath` 为基准解析
      （MUST NOT 使用 `process.cwd()`）
- **AND** 每个相对路径 SHALL 保持各自的层级（MUST NOT 全部坍缩到根）

#### Scenario: 已经绝对的路径原样透传

- **WHEN** 调用方传入的路径本就是绝对路径
- **THEN** 该路径 SHALL 原样透传，MUST NOT 被再次解析到另一个基准
- **AND** 判定「是否绝对」SHALL 使用平台感知的判定，MUST NOT 用 `startsWith("/")`
      —— Windows 盘符（`C:\dev\x.ts`）与 UNC（`\\srv\share\x.ts`）都不以 `/` 开头，
      误判为相对会得到 `<root>/C:/dev/x.ts`，指向一个不存在的文件

#### Scenario: 规范化到唯一拼法

- **WHEN** 同一文件经不同写法到达（`packages/core/../acp/README.md`、`a//b.md`）
- **THEN** 解析结果 SHALL 折叠 `..` 与重复分隔符，得到规范化的绝对路径
- **AND** `tool_call.location.path`（`toolLocationsFor` / `toolDiffFor`）与实际发出的 `fs/*` 请求
      SHALL 对**同一文件**给出**同一个字符串** —— 二者是同一契约的两种呈现，MUST NOT 各有一份实现

#### Scenario: rootPath 前提为绝对，入口处归一化

- **WHEN** 调用方经 `bootstrapLocalAcp({ cwd })` 或 `createAcpAgent({ rootPath })` 传入一个**相对** root
- **THEN** 该入口 SHALL 把它归一化为绝对路径后再作为 `rootPath`，且两个入口 SHALL 经**同一个** helper
      （`paths.ts` 的 `resolveRoot`，与 `toWirePath` 相邻，使前提与前提的执行不会分家）
- **AND** 否则解析会经 `resolve` 间接落到 `process.cwd()`，即上一 scenario 明令禁止的回落；
      `createAcpAgent` 的 root 还会出现在 client 可见的输出里（`tool_call.location.path` 与
      `SessionInfo.cwd` —— 后者按 ACP 要求必须是绝对路径），因此它不是局部细节

备注：`toWirePath` 自身只护栏**空** root，不护栏**相对** root（`resolve("rel/ws", t)` 仍依赖
`process.cwd()`）。前提由接受 root 的入口负责成立，归一化是 `resolveRoot` 的职责。

#### Scenario: rootPath 为空时不回落到 process.cwd()

- **WHEN** env 的 `rootPath` 为空
- **THEN** 解析 SHALL 返回原路径，MUST NOT 用 `process.cwd()` 兜底
      （`pathe.resolve("", t)` 会静默回落到进程 cwd，而进程 cwd 在 host 被指定 root 后就是另一个工作区）

#### Scenario: 终端 cwd 同样绝对

- **WHEN** 一次 argv 型执行携带 `cwd`
- **THEN** `terminal/create` 的 `cwd` SHALL 是绝对路径

备注：本地 env 不需要这层处理（`native-fs.ts` 的 `resolvePath` 内部已解析），但 client-backed 环境把
文件系统**外包**给了 client，因此**必须**交出一个 client 能用的路径。缺失该解析时的可见症状不是报错而是
**挂起**：写入的审批提示（`session/request_permission`）永远等不到应答，`--client-env` 下所有 ACP 侧写入
全部失败。

### Requirement: rename 只在写入未路由到 client 时透传

client-backed env MUST NOT 在写入路由到 client（即 client 声明 `fs.writeTextFile`）时暴露 `rename`。

`rename` 是「整文件重写」的第二步（写同目录临时文件，再 rename 就位），而该重写的**写入**部分是一个
工作区文本文件、会被路由到 client。若此时仍无条件透传 `rename`，第二步会在**我们的**文件系统上执行，
而临时文件在 **client 的**盘上 —— 本地编辑器恰好共用同一块盘时看不出问题，真正的远端 client
（Zed over SSH、dev container、另一台机器）会得到 ENOENT（或跨设备 EXDEV），并遗留临时文件。

因此：当写入路由到 client 时，client-backed env SHALL **不**暴露
`rename`，使 `write_file` 走其文档化的直接写分支（对目标路径发**一次**写）。当写入仍属本地时
（`.agents/**`、工作区外、或 client 未声明写能力），`rename` SHALL 照常透传，原子重写的保证不失效。

备注：这是**能力级**门控，不是路径级 —— `fs.rename` 一旦不暴露，整个 env 都没有，因此该开关下**本地写入
也会失去原子替换**（`.agents/**` 在内）。core 自己记录了这一退化（`session-journal.ts`：*"Without
rename this degrades to a direct overwrite … best-effort"*），其 else 分支是普通 `writeFile`，所以**不丢
数据**，只是 compaction 折叠时的日志重写不再崩溃原子。要做到「本地路径仍有原子性」需要 core 的路径感知
能力（如 `atomicReplace(path, content)`），属 core API 变更，不在本变更内。

#### Scenario: 写入路由到 client 时不暴露 rename

- **WHEN** client 声明 `fs.writeTextFile`（工作区内写入经 client）
- **THEN** client-backed env 的 `fs.rename` SHALL 不存在
- **AND** `write_file` SHALL 因此直接写目标路径，MUST NOT 先写临时文件再调用本地 rename

#### Scenario: 写入仍属本地时保留 rename

- **WHEN** client 未声明 `fs.writeTextFile`（写入由回退环境执行）
- **THEN** `fs.rename` SHALL 照常透传，整文件重写仍为原子
