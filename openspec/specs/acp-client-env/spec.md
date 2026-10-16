# acp-client-env Specification

## Purpose
TBD - created by archiving change add-acp-client-env. Update Purpose after archive.
## Requirements
### Requirement: client-backed 环境按会话构造且默认关闭

`codent acp` SHALL 提供一个显式开关，使其在 ACP 会话上使用由 client 能力承载的 `CoreEnv`。
开关**默认关闭**；关闭时环境的构造与使用路径 SHALL 与本变更之前一致。
开启时，每个会话 SHALL 绑定到自己的 env（因为 ACP 的 `fs/*` 与 `terminal/*` 请求均按 `sessionId` 定位），
且 SHALL 沿用「一个 runtime 一个 env」的既有装配机制，MUST NOT 引入第二条环境注册路径。

#### Scenario: 默认关闭
- **WHEN** 未传入该开关启动 `codent acp`
- **THEN** 会话的 fs 与命令 SHALL 全部走本地 env，SHALL NOT 发出任何 `fs/*` 或 `terminal/*` 请求
- **AND** `initialize` 声明的能力 SHALL 与关闭态一致

#### Scenario: 开启后按会话绑定
- **WHEN** client 创建两个会话并各自读文件
- **THEN** 发往 client 的请求 SHALL 携带各自的 `sessionId`
- **AND** 两个会话 SHALL 互不共享 env

#### Scenario: 会话尚未存在时的读取
- **WHEN** 会话创建过程中（`sessionId` 尚未绑定）需要读取工作区文件
      （项目指令 `AGENTS.md`/`CLAUDE.md`、`.lsp.json`、`.mcp.json`）
- **THEN** 该读取 SHALL 由回退（本地）环境服务，SHALL NOT 向 client 发起请求
- **AND** MUST NOT 失败或抛错 —— 取不到 `sessionId` 是「本会话暂不可用 client」，
      不是「读不到文件」；项目指令 SHALL 正常进入 system prompt
- **AND** 该规则 SHALL 覆盖**每一条** client 路径（`fs/read_text_file`、`fs/write_text_file`、
      `execFile`），MUST NOT 出现某个入口在未绑定时把 `sessionId: undefined` 发出去

#### Scenario: 指令文件存在但读取被拒
- **WHEN** 项目指令文件存在，但读取失败（如 client 拒绝 `fs/read_text_file`）
- **THEN** 该失败 SHALL 被上报（日志或等价出口），MUST NOT 被静默吞掉
- **AND** MUST NOT 把「读取失败」表述为「没有指令文件」

### Requirement: client 未声明的能力回退而非失败

client-backed 环境 SHALL 在 client 未声明某能力时回退到其构建时的本地回退环境，
MUST NOT 表现为「成员存在但失败」。回退 SHALL 覆盖 `CoreEnvFs` 的必选成员
（`readdir` / `stat` / `remove` / `mkdir` / `exists` 等），以及 client 不提供的可选能力。

#### Scenario: 只声明读
- **WHEN** client 只声明 `fs.readTextFile` 而未声明 `fs.writeTextFile`
- **THEN** 读 SHALL 经 client 完成，写 SHALL 由回退环境完成（结果可见于本地文件系统）

#### Scenario: 未声明终端
- **WHEN** client 未声明 `terminal`
- **THEN** 命令执行 SHALL 由回退环境完成，MUST NOT 抛出「不支持」错误

#### Scenario: 目录列举始终可用
- **WHEN** client 未声明任何 fs 能力，但工具调用 `readdir` / `stat`
- **THEN** 两者 SHALL 由回退环境服务并返回真实结果
- **AND** 工作区的 `list_file` / `glob` 类工具 SHALL 保持可用

#### Scenario: 不定义总是失败的可选成员
- **WHEN** client 未声明终端能力
- **THEN** 该 env MUST NOT 定义一个总是抛错的 `execFile`
- **AND** 依赖 `Boolean(env.execFile)` 做特性探测的调用方 SHALL 得到「不支持」并走其回退路径

### Requirement: .agents 与工作区外路径永不发往 client

client-backed 环境的文件访问 SHALL 仅作用于工作区根之内、且 `.agents/` 之外的路径。
`.agents/**`（会话日志、媒体、记忆、计划、扩展与配置）以及任何位于工作区根之外的路径
SHALL 由回退（本地）env 处理，MUST NOT 发往 client。

#### Scenario: 会话日志本地落盘
- **WHEN** 一次运行需要写 `.agents/logs/<sessionId>/agent.log` 或 `.agents/sessions/*.session.jsonl`
- **THEN** 写入 SHALL 走本地 env
- **AND** MUST NOT 请求 client 的 `fs/write_text_file`

#### Scenario: 工作区外的路径
- **WHEN** 工具请求读取工作区根之外的绝对路径
- **THEN** 该访问 SHALL 走本地 env（及其既有的工作区约束），MUST NOT 发往 client

### Requirement: 行选择参数不由 core 发送

client-backed 环境 SHALL 总是发出**不携带** `line` / `limit` 的 `fs/read_text_file` 请求，
SHALL NOT 自行发明行窗口；并且 SHALL NOT 定义 core 的 `readFileRange`（`[start,end)` 字节半开区间），
使调用方按其既有契约回落到整文件读。依据：core 的 `CoreEnvFs.readFile` 不携带行参数
（`readFile(path)` / `readFile(path, "buffer")`），行窗口由 `read_file` 工具在返回内容上自行切分
（`read-file-tool.ts:263`）。

#### Scenario: 请求不带行参数
- **WHEN** 调用方经 `CoreEnvFs.readFile` 读取一个工作区文件
- **THEN** 发往 client 的 `fs/read_text_file` 请求 SHALL NOT 包含 `line` / `limit`
- **AND** 返回内容 SHALL 是该文件全文（行窗口由调用方自行切分）

#### Scenario: 不提供字节窗口
- **WHEN** 调用方探测 `readFileRange`
- **THEN** 该成员 SHALL 在 client-backed env 上不存在
- **AND** 调用方 SHALL 回落到整文件读

### Requirement: 发往 client 的路径必须是绝对路径

所有携带路径的 client 请求（`fs/read_text_file`、`fs/write_text_file` 的 `path`，`terminal/create` 的
`cwd`）SHALL 在发出前解析为**绝对路径**。ACP 对三者的规范要求是「Absolute path to the file」与
「Must be an absolute path」，而 core 的调用方（`write_file` / `edit_file` / `read_file` / `execFile`）
传入的通常是**工作区相对路径** —— 相对路径无法归属任何根，client 会按**自身 cwd** 解析并拒绝。

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

`rename` 是「整文件重写」的第二步（写同目录临时文件，再 rename 就位），而该重写的**写入**部分是一个
工作区文本文件、会被路由到 client。若此时仍无条件透传 `rename`，第二步会在**我们的**文件系统上执行，
而临时文件在 **client 的**盘上 —— 本地编辑器恰好共用同一块盘时看不出问题，真正的远端 client
（Zed over SSH、dev container、另一台机器）会得到 ENOENT（或跨设备 EXDEV），并遗留临时文件。

因此：当写入路由到 client（即 client 声明 `fs.writeTextFile`）时，client-backed env SHALL **不**暴露
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

### Requirement: 权限授权方随环境转移

当使用 client-backed 环境时，**文件访问**的授权 SHALL 由 client 侧承担
（client 可自行审批或拒绝 `fs/*`），agent SHALL NOT 对同一文件动作再发起一次
`session/request_permission`。**命令**的审批 SHALL 保持本地路径不变：自由文本命令
（`exec` / `runCommand`）仍在本地执行，其审批仍经既有的工具审批通路，因为 client 并未参与该命令的执行。

授权方转移 SHALL 以「该动作是否真的发往 client」为准，而不是以工具名为准：
仅当操作走 client 通道时授权才转移；若该操作因路径（`.agents/**`、工作区外）或能力缺失而由回退环境执行，
则审批 SHALL 留在本地。

#### Scenario: 写文件不重复审批
- **WHEN** 在 client-backed 环境下写工作区内文件、且 client 声明了 `fs.writeTextFile`
- **THEN** 该审批 SHALL 由 agent 侧直接放行，SHALL NOT 向 client 发起 `session/request_permission`

#### Scenario: 未走 client 的写仍由本地审批
- **WHEN** 同一次运行中写入 `.agents/**`、工作区外路径，或 client 未声明 `fs.writeTextFile`
- **THEN** 该写 SHALL 由回退环境执行，其审批 SHALL 保持本地提示
- **AND** MUST NOT 因「工具名属于写文件」而静默放行

#### Scenario: 删除与自由文本命令永不静默
- **WHEN** 待审批的调用是 `delete_file`、`kill_command` 或 `run_command`
- **THEN** 其审批 SHALL 保持本地提示
- **AND** MUST NOT 因 client 声明了 `terminal` 或 `fs.writeTextFile` 而放行

#### Scenario: plan 阶段不使用 client 的授权
- **WHEN** 会话处于 `plan` 模式且存在一个本可转移的写审批
- **THEN** 该审批 SHALL 保持本地提示
- **AND** MUST NOT 以 client 的授权替代 plan 阶段「未真正写入」的保证

#### Scenario: argv 型执行不重复审批
- **WHEN** 在 client-backed 环境下执行一个 argv 型命令（经 client 终端）且 client 未拒绝
- **THEN** agent SHALL NOT 另行发起 `session/request_permission` 作为该命令的执行前提

#### Scenario: 自由文本命令的审批仍在本地
- **WHEN** 在 client-backed 环境下执行一个自由文本命令（`exec` / `runCommand`）
- **THEN** 该命令仍 SHALL 经既有的本地工具审批通路决定是否执行
- **AND** MUST NOT 因为启用 client-backed 环境而跳过该审批

### Requirement: client 终端只承担 argv 型执行

client-backed 环境的 `terminal/*` SHALL 只用于 argv 型执行（`execFile`，即 glob/grep/tree 类调用），
其结果 SHALL 为**完整返回**（stdout / stderr / 退出码），MUST NOT 被假定为产生工具调用增量。
终端的输出读取 SHALL 为有界轮询（间隔与退避），MUST NOT 忙等。
`run_command` 的 stdout/stderr 增量 SHALL 仍由本地（回退）环境提供，与本变更之前一致。

#### Scenario: argv 型执行经终端并完整返回
- **WHEN** 调用方以 argv 请求执行（如 glob/grep/tree 的 `execFile` 调用）
- **THEN** 该执行 SHALL 经 client 的终端完成，并返回完整的 stdout / stderr / 退出码
- **AND** MUST NOT 被期望按增量投递

#### Scenario: 无 push 通道时不忙等
- **WHEN** 终端长时间无新输出
- **THEN** agent MUST NOT 以无间隔轮询 `terminal/output`

#### Scenario: 取消必须能中断 argv 型执行
- **WHEN** 一个经 client 终端的 `execFile` 执行期间调用方发出中止信号（`signal`）
- **THEN** 轮询 SHALL 在下一轮检测到中止并结束
- **AND** agent SHALL 终止该 client 终端（`terminal/kill`）并释放它
- **AND** 该执行 MUST NOT 以「成功且结果为空」的形态返回

#### Scenario: 超时与截断不得伪装成成功结果
- **WHEN** 终端在 deadline 内未给出退出状态，或 client 报告输出被截断
- **THEN** 结果 SHALL 标记为被终止（`killed: true`）
- **AND** MUST NOT 把部分输出当作完整结果返回给调用方
- **AND** 依赖该结果的调用方（glob/grep/tree）SHALL 据此回落到其进程内实现，
      而非报告「零匹配」

#### Scenario: 进程已退出但输出被截断
- **WHEN** client 的同一响应同时给出退出状态与「输出被截断」
- **THEN** 该结果 SHALL 按截断处理（标记 `killed: true` 并在 stderr 说明）
- **AND** MUST NOT 因为进程已结束就把被裁剪的输出当作完整结果返回

#### Scenario: run_command 的流式输出不受影响
- **WHEN** 在 client-backed 环境下调用 `run_command`
- **THEN** 该命令 SHALL 由本地（回退）环境执行，其 stdout/stderr 增量 SHALL 与今日一致地投递到工具调用通道
- **AND** `acp-session-updates` 的「流式命令输出」行为 MUST NOT 因本变更而退化

### Requirement: 自由文本命令不经 client 终端执行

client-backed 环境 SHALL 把 `exec` 与 `runCommand`（两者均为自由文本）委托给回退（本地）环境，
SHALL NOT 通过自行拼接 shell（如 `sh -c "…"`）实现它们；终端只服务 argv 型执行的契约见
「client 终端只承担 argv 型执行」。依据：ACP `terminal/create` 只接受 `command` + `args`（无 shell）。
此约束既避免发明一个我们控制不了的 shell，也保证命令审批分析所用的 shell 与实际执行的 shell 一致。

#### Scenario: exec 与 runCommand 委托回退而不自造 shell
- **WHEN** 一个自由文本命令经 client-backed 环境执行（`exec` 或 `runCommand`）
- **THEN** 该执行 SHALL 由回退环境完成（使用其既有的 shell 与语义）
- **AND** agent MUST NOT 通过自行拼接 shell 调用把它实现为第二条自由文本执行路径

#### Scenario: 审批与执行同一 shell
- **WHEN** 命令经 client-backed 环境提交给命令安全检查
- **THEN** 审批分析所用的 shell 判定 SHALL 与实际执行该命令的 shell 属于同一个环境
- **AND** MUST NOT 出现「分析用 A shell、执行用未知 B shell」的组合

