## MODIFIED Requirements

### Requirement: 可广告的 slash 命令目录

系统 SHALL 提供一个可枚举、可序列化的 slash 命令目录，作为“宿主可广告/可调用命令”的**单一事实来源**：

- **内置命令**：core SHALL 导出一份内置命令目录（至少含 `name` 与 `description`，并标明是否接受参数/选项），覆盖与 `AgentSessionCommand` 对应的内置命令（如 `mode`、`compact`、`clear`、`resume`、`rename`、`models`、`mcp`、plan 相关、`usage`）。应用层的命令注册表 SHALL 从该目录派生，MUST NOT 维护第二份权威列表。
- 目录 MUST NOT 单独广告一个思考强度命令：强度是所选模型的性质，由 `models` 命令的参数（及 ACP 的 `thought_level` 配置选项）承载。原先的 `effort` 条目 SHALL 移除，以免宿主广告一个与模型命令重复、且能选出所选模型并不支持的档位的入口。
- **扩展命令**：`AgentSession` 暴露的扩展摘要 SHALL 包含每个扩展命令的 `name` 与 `description`（在现有 `hasOptions` 之外），使宿主无需读取 `ManagedAgent` 即可广告这些命令。

宿主（headless ACP、远程会话）SHALL 能仅凭该目录 + 会话扩展摘要枚举出“内置 + 扩展”的完整命令集合，用于 ACP `available_commands_update`。

#### Scenario: 内置命令目录可枚举

- **WHEN** 一个 headless 宿主（未加载 `@codent/app`）需要一个 slash 命令列表
- **THEN** 它 SHALL 能从 core 导出的内置命令目录取到每个内置命令的 `name` 与 `description`
- **AND** 应用层的命令注册表 SHALL 与该目录保持一致（同一事实来源）

#### Scenario: 扩展命令摘要携带描述

- **WHEN** 某会话启用了一个注册了命令 `memory` 的扩展
- **THEN** 会话扩展摘要 SHALL 含 `memory` 的 `name` 与 `description`
- **AND** 宿主 SHALL 能据广告该命令而不读取 `ManagedAgent`

#### Scenario: 命令仍经既有 dispatch 调用

- **WHEN** 宿主广告了某内置命令后收到调用
- **THEN** 该调用 SHALL 映射为对应的 `AgentSessionCommand`（如 `mode.set`/`compact`/`session.resume`）或 `extension.invokeCommand`
- **AND** 返回结果 SHALL 复用既有 `AgentSessionCommandResult` 约定

#### Scenario: 思考强度不单独成命令

- **WHEN** 宿主枚举可广告的内置命令
- **THEN** 集合内含 `models` 且不含独立的思考强度命令
- **AND** `models` 广告的 usage 覆盖档位参数，且该 usage 声明的每个取值都能被 core 的语法解析出意图

#### Scenario: 目录与实际注册一致

- **WHEN** 命令目录一致性校验运行
- **THEN** 应用侧注册的内置命令与目录逐条对应（含思考强度条目已移除），且任何一方都不携带对方之外的第二份元数据
