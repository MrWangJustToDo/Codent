# core-env-identity Specification

## Purpose
TBD - created by archiving change add-acp-client-env. Update Purpose after archive.
## Requirements
### Requirement: CoreEnv 暴露工作目录

`CoreEnv` SHALL 暴露一个 `cwd()`（会话/工作区的工作目录，绝对路径），并 SHALL 有默认实现
（返回 `rootPath`），使既有实现无需改动即满足该契约。

#### Scenario: 未实现 cwd 的实现仍可用
- **WHEN** 一个既有 `CoreEnv` 实现未提供 `cwd()`
- **THEN** 解析后的 env SHALL 以 `rootPath` 回答 `cwd()`，该实现的其他行为不变

### Requirement: 能力缺失即省略成员或委托回退

当宿主环境不具备某项 `CoreEnv` 能力时，SHALL 采用「省略可选成员」或「委托给一个可用的回退环境」
两种方式之一。MUST NOT 把一个已知不可用的能力实现在为「总是失败」的可选成员上 ——
核心工具按**成员是否存在**做特性探测（例如 `Boolean(env.execFile)`、`if (fs.readFileRange)`），
一个总是抛错的定义会让探测结果为「有」，从而把优雅降级变成异常。

对于 `CoreEnvFs` 等接口的**必选**成员（如 `readdir` / `stat` / `remove`），宿主 SHALL 委托给回退环境；
MUST NOT 让它们失败，因为目录列举与搜索工具依赖它们在整个工作区可用。

#### Scenario: 可选能力被省略
- **WHEN** 一个 env 不提供 `fs.readFileRange`
- **THEN** 该成员 SHALL 在 env 上不存在（而非存在但抛错）
- **AND** 调用方 SHALL 按其既有约定回落到整文件读

#### Scenario: 可选能力以 falsy 返回表示不支持
- **WHEN** 一个 env 不提供代码隔离能力
- **THEN** `createIsolateDriver()` SHALL 返回 `null`（该成员的既有契约），调用方据此禁用该能力

#### Scenario: 必选能力委托而非失败
- **WHEN** 一个 env 自身无法列举目录，但持有可用的回退环境
- **THEN** `fs.readdir(path)` SHALL 由回退环境服务并返回真实结果
- **AND** MUST NOT 抛出错误或返回空数组

### Requirement: 会话日志落盘不依赖同步 fs

会话/agent 日志的 flush SHALL 在实现不提供同步文件 API 时退化为异步写入，
MUST NOT 因缺少 `appendFileSync` 而丢失条目或抛错。

#### Scenario: 无同步 API 时仍落盘
- **WHEN** 一个不提供 `appendFileSync` 的 env 承载会话日志
- **THEN** 日志条目 SHALL 经异步路径写入
- **AND** 退出/崩溃路径的 flush SHALL 不抛错（可记录一次降级）

