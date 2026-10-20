## ADDED Requirements

### Requirement: client 元数据操作与终端信号

当 client 声明了文件读取能力时，`exists` / `stat` SHALL 先尝试本地回退环境的元数据：本地能解析该路径时直接返回本地的 `size` / `mtime`（真实值，且不产生 wire 往返）。仅当本地无法解析该可路由路径时，才 SHALL 通过一次成功的 client text read 向 client 求证：`size` 取读取内容的字节长度，`mtime` SHALL 标记为未知（epoch），MUST NOT 伪造成“当前时间”。这是有意的性能取舍：同一路径在本地与 client 都存在时，元数据取本地；文件内容读取仍按 `readFile` 的既有路由规则执行。ACP v1 根本没有目录列举方法，因此 `readdir`（`list_file` / `tree`）始终使用本地回退环境——本变更没有把它路由给 client；其余 client 无法服务的路径回退到本地回退环境。终端结果中被信号终止（`exitStatus.signal` 非空）的进程 SHALL 报告为 `killed: true`，MUST NOT 当作正常退出并把空输出读成"没有匹配"。

#### Scenario: 本地能服务时用本地元数据

- **WHEN** `--client-env` 开启，且路径在本地回退环境中存在
- **THEN** `exists` / `stat` SHALL 直接返回本地结果（真实 `mtime`），MUST NOT 为元数据发起 client 请求

#### Scenario: 远程-only 文件才向 client 求证

- **WHEN** 本地回退环境无法解析该路径，但 client 能读取它
- **THEN** `exists` SHALL 返回 true，`stat` SHALL 返回文件类型与读取长度
- **AND** `stat.mtime` SHALL 为 epoch（未知），MUST NOT 是当前时间

#### Scenario: 远程客户端上的文件可读

- **WHEN** `--client-env` 开启、client 声明了 `fs.readTextFile`，且文件只存在于 client 侧
- **THEN** `read_file` SHALL 通过 client 读取成功
- **AND** MUST NOT 因 agent 本地没有该文件而返回 `File not found`

#### Scenario: 只声明写时不误判

- **WHEN** client 只声明写能力、未声明读能力
- **THEN** 元数据与读取 SHALL 回退到本地回退环境
- **AND** MUST NOT 向 client 发出未声明的请求

#### Scenario: 信号终止的终端是 killed

- **WHEN** client 终端返回的 `exitStatus` 带 `signal`（例如 `SIGKILL`）
- **THEN** 该执行结果 SHALL 为 `killed: true`
- **AND** 调用方（如搜索工具）SHALL 走其"被中断"的回退路径，MUST NOT 把空 stdout 当作"没有结果"

#### Scenario: 目录列举回退本地

- **WHEN** `--client-env` 开启且工具需要列举目录（`list_file` / `tree`）
- **THEN** `readdir` SHALL 使用本地回退环境（ACP v1 没有目录列举方法）
- **AND** MUST NOT 把目录当作文本文件通过 `fs/read_text_file` 读取
