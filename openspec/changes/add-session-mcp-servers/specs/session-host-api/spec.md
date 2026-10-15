## ADDED Requirements

### Requirement: 会话创建可携带 MCP 服务器配置

系统的会话创建选项 SHALL 支持直接携带 MCP 服务器配置（一个「服务器名 → 服务器配置」的映射），
使宿主无需先写文件即可为单个会话指定 MCP 服务器。显式携带时该配置 SHALL 作为该会话 MCP 服务器的
唯一来源（取代默认配置文件中的同名集合），且连接的服务器 SHALL 以既有方式注册工具
（`mcp__<server>_<tool>`）。未携带时行为 SHALL 与今天完全一致。

#### Scenario: 显式配置取代文件配置
- **WHEN** 宿主以显式 MCP 服务器映射创建一个会话，且工作区存在 `.agents/mcp.json`
- **THEN** 该会话连接的 SHALL 只有显式映射中的服务器
- **AND** 文件中的服务器 MUST NOT 被连接

#### Scenario: 未携带时沿用文件
- **WHEN** 宿主创建会话时未携带 MCP 服务器映射
- **THEN** MCP 配置 SHALL 仍来自默认配置文件（含回退路径），行为与既有实现一致

#### Scenario: 三种受支持的 transport 都可下发
- **WHEN** 显式映射中的服务器分别是 stdio、http、sse transport
- **THEN** 三者 SHALL 都按各自的 transport 连接，MUST NOT 因 transport 而拒绝
- **AND** sse 与 http 的 `url`/`headers` 与 stdio 的 `command`/`args`/`env` SHALL 原样传入连接层

#### Scenario: 工具注册路径不变
- **WHEN** 一个显式服务器的 `tools` 列表非空
- **THEN** 其工具 SHALL 以 `mcp__<server>_<tool>` 注册进该会话的工具集
- **AND** 扩展/工具的既有注册与解绑路径 SHALL 不变

### Requirement: MCP 配置来源必须可观测且不污染既有字段

MCP 配置的来源 SHALL 可被观测（用于回答「为什么工作区的 mcp.json 没生效」），且该观测 SHALL NOT
通过把非路径值写入既有的路径语义字段（`configPath` / `configLoadedFrom`）来实现 —— 那两个字段的
语义是文件路径，会被 `/mcp` 呈现为路径。

#### Scenario: 显式配置的来源可观测
- **WHEN** 一个会话以显式 MCP 服务器配置创建
- **THEN** agent 日志 SHALL 记录配置来源为「会话创建选项」以及服务器数量
- **AND** MCP 状态中 MUST NOT 出现把 `"session-options"` 之类字面量当作文件路径的呈现

#### Scenario: 文件配置的来源不变
- **WHEN** 一个会话的 MCP 来自默认配置文件
- **THEN** 既有的 `configPath` / `configLoadedFrom` 语义与展示 SHALL 与本变更前一致

### Requirement: MCP 凭据不得进入日志或会话持久化

当 MCP 服务器配置由会话创建选项携带时，其中的环境变量值与 HTTP 头值 SHALL 视为凭据：
它们 MUST NOT 出现在会话日志、agent 日志或持久化的会话数据中。日志 SHALL 至多记录服务器名与其 transport。

#### Scenario: 日志只记录来源与服务器名
- **WHEN** 一个会话以显式 MCP 服务器配置创建，且某服务器带 `env` / `headers`
- **THEN** agent 日志 SHALL 记录服务器名与 transport
- **AND** MUST NOT 记录任何 `env` 值或 header 值

#### Scenario: 会话持久化不含配置
- **WHEN** 该会话被持久化到磁盘
- **THEN** 持久化数据 MUST NOT 包含 MCP 服务器的 `env` / `headers`

### Requirement: 单个 MCP 服务器连接失败不阻塞会话

当显式 MCP 服务器配置中有服务器连接失败时，会话创建 SHALL 仍然成功，失败原因 SHALL 可观测
（日志或 `/mcp` 状态），且其余服务器 SHALL 正常可用。

#### Scenario: 部分失败仍可会话
- **WHEN** 两个显式服务器中有一个连接失败
- **THEN** 会话 SHALL 创建成功，另一个服务器的工具 SHALL 可用
- **AND** 失败服务器 SHALL 在 MCP 状态中显示为未连接
