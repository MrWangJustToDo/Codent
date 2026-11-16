# Spec Delta

## MODIFIED Requirements

### Requirement: client 未声明的能力回退而非失败

client-backed 环境 SHALL 在 client 未声明某能力时回退到其构建时的本地回退环境，
MUST NOT 表现为「成员存在但失败」。回退 SHALL 覆盖 `CoreEnvFs` 的必选成员
（`readdir` / `stat` / `remove` / `mkdir` / `exists` 等），以及 client 不提供的可选能力。

可选成员的取舍 SHALL 按「缺了它会发生什么」区分，而不是一律省略：

- 该成员是否存在取决于 **client 能力**时，client 未声明则该成员 SHALL 缺席（`execFile` 且无
  `terminal`），使特性探测得到「不支持」；
- 该能力 client **永远无法提供**（进程所有权），且**省略等于移除能力**时，成员 SHALL 由回退环境
  转出：`createMCPStdioTransport` 是唯一的此类成员 —— 它需要双向管道，而 `terminal/*` 没有 stdin
  写入，client 永远给不了；core 对缺失该成员的本地环境又是**直接拒绝**而不是降级，所以省略它会让
  `--client-env` 下所有 stdio MCP server 都无法连接，`/mcp` 报
  `Stdio MCP transport is not available in this environment`；
- 省略只造成**降级或无关**时仍按既有规则取舍，本变更不改变这些：`readFileRange` 明确 MUST NOT
  定义（core 自行用 `readFile` 区间裁剪）、`rename` 取决于写入路由、`imageToText` 服务终端预览面板
  而本宿主不消费；
- 该能力的答案依赖**本机对工作区的视图**时（LSP、code-mode isolate driver），成员 SHALL 保持缺席：
  它们会描述本机磁盘，而不是该 env 实际服务的那个工作区。

`--client-env` 移动的是 fs / argv 的**路由**，MUST NOT 改变进程归属：自由文本命令、后台任务与
MCP stdio server 都由本进程启动。

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

#### Scenario: stdio MCP server 在 client-env 下仍可连接

- **WHEN** `--client-env` 开启，且会话配置了一个 stdio MCP server
- **THEN** 该 server SHALL 由本地回退环境启动并完成 MCP 握手，`/mcp` SHALL 报告 `connected` 与其工具数
- **AND** MUST NOT 报告 `Stdio MCP transport is not available in this environment`
- **AND** 启动该进程 MUST NOT 向 client 发出任何 `fs/*` 或 `terminal/*` 请求
- **AND** 该传输对象 SHALL 是回退环境自己的对象，使 `getMCPTransportProcess` 能识别并终止同一个子进程

#### Scenario: 回退环境无法启动子进程时仍缺席

- **WHEN** 回退环境自身没有 `createMCPStdioTransport`（无进程运行时的宿主）
- **THEN** 该成员 SHALL 缺席，MUST NOT 定义成总是抛错的实现
- **AND** core SHALL 按其既有契约报告该环境不支持 stdio MCP
