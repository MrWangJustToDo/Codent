## MODIFIED Requirements

### Requirement: 会话配置选项下发

agent SHALL 在 `session/new` 与 `session/fork` 的响应中携带 `configOptions`，其中 SHALL 含一个
`category: "mode"` 的 `select`（选项为 agent 的模式集合，当前值为该会话的当前模式）。
当且仅当工作区存在可列举的模型目录（`.agents/config/models.json`）时，`configOptions` SHALL **另有**
一个 `category: "model"` 的 `select`（选项为目录中的模型，当前值为该会话的当前模型）；
无目录时（例如显式 `--model` 等 flags 跳过了 `models.json`，或退回 `.env`）该选项 SHALL 被**省略**，
MUST NOT 广告一个无可选值的空选择器。

模型项的取值 SHALL 编码其所属 entry（`"<entryIndex>:<model>"`），使不同 entry 下的同名模型可区分，
且 SHALL 把该 entry 的 `style` / `baseURL` 编入选项描述以便用户辨识。广告内容 MUST NOT 含任何凭据
（`apiKey`）。

模型项的 `currentValue` SHALL 恒等于该会话的当前模型，且 SHALL **始终**出现在该选项的 `options` 中
（协议要求 agent 为每个已提供的选项给出可用默认值）：会话当前模型不在目录中时 SHALL 把它作为首项补入。

`session/load` 与 `session/resume` 的响应形状 MUST NOT 因本变更而改变。
模式仍经既有 `session/set_mode` 与 `current_mode_update` 通路同步，该 `configOptions` 项 SHALL 与该通路
保持一致，MUST NOT 成为第二个真源。

对**不存在的会话**改变会话状态的请求（`session/set_mode`、`session/set_config_option`，以及既有的
`prompt` / `cancel` / `fork`）SHALL 以 JSON-RPC 错误拒绝，MUST NOT 静默报告成功；`session/close` MAY
容忍缺失（那里期望状态已经为真）。判据是「期望状态是否已经为真」，不是「该请求是否幂等」。

广告了 `configOptions` 即 SHALL 接受 `session/set_config_option`：`configOptions` 是声明，
`session/set_config_option` 是该声明的写回路径，二者 MUST 同时存在。该方法 SHALL
以 `configId` 在**当前声明的选项集**中查找（而非硬编码某个 id），未找到时返回 JSON-RPC 错误；
随后 SHALL 按**该选项的 `category`** 分派到对应通路（`mode` → `mode.set`，`model` → `model.set`），
MUST NOT 假定「唯一选项是 mode」而把任意取值当作模式。

两个选项各自的语义 SHALL 与既有通路一致，MUST NOT 成为第二个真源：

- `mode`：经既有 `mode.set` 分发并回读会话实际状态，MUST NOT 另建一套模式逻辑。
- `model`：经 `model.set` 分发（随该模型所属 entry 的 `style` / `baseURL` / `apiKey` 与解析出的
  `modelInfo` 一并下发），并回读会话实际状态。切换后该会话后续的出网连接 SHALL 使用所选 entry。

agent MUST NOT 为支持模型切换而注册进程级 model provider：连接由会话自身的 config 承载，
在 ACP 一进程多会话的形状下，注册全局 provider 会让一个会话的切换污染另一个会话。

未处理的 `category` SHALL 以 JSON-RPC 错误拒绝，MUST NOT 被静默忽略或退回某个通路。

#### Scenario: 新会话下发模式选择器

- **WHEN** client 调用 `session/new`
- **THEN** 响应 SHALL 含一个 `category: "mode"` 的 `configOptions` 项，其 `type` 为 `select`
- **AND** 该项的当前值 SHALL 等于响应 `modes.currentModeId`（若同时提供）

#### Scenario: 新会话下发模型选择器

- **WHEN** client 调用 `session/new`，且工作区存在含多个模型的 `models.json`
- **THEN** 响应 SHALL 含一个 `category: "model"` 的 `configOptions` 项，其 `type` 为 `select`
- **AND** 其 `options` SHALL 覆盖目录中各个 entry 的模型，取值 SHALL 编码 entry
- **AND** `currentValue` SHALL 等于该会话的当前模型，且 SHALL 出现在 `options` 中
- **AND** 选项值或描述 MUST NOT 含 `apiKey` 等凭据

#### Scenario: 无模型目录时不广告

- **WHEN** agent 以显式 `--model`（或 `.env`）启动，因而跳过了 `models.json`
- **THEN** `configOptions` MUST NOT 含 `category: "model"` 的项
- **AND** `category: "mode"` 的项 SHALL 照旧下发

#### Scenario: 当前模型不在目录中时补入

- **WHEN** 会话的当前模型不在 `models.json` 的模型集合内
- **THEN** 模型项 SHALL 把该模型作为首项补入 `options`
- **AND** `currentValue` SHALL 等于该模型（因而仍是 `options` 的成员）

#### Scenario: 分支会话下发模式选择器

- **WHEN** client 调用 `session/fork`
- **THEN** 响应 SHALL 含同样的 `category: "mode"` 项

#### Scenario: 分支会话下发模型选择器

- **WHEN** client 调用 `session/fork`，且工作区存在 `models.json`
- **THEN** 响应 SHALL 含 `category: "model"` 的项，其 `currentValue` SHALL 等于分支会话的当前模型

#### Scenario: 模式切换后选择器保持同步

- **WHEN** client 通过 `session/set_mode` 切换到会话**实际接受**的另一个模式
- **THEN** agent SHALL 追加一条 `session/update`（`sessionUpdate: "config_option_update"`），其
      `configOptions` 为**完整**选项集（含模型项，若该会话广告了它），且 `category: "mode"` 项的当前值
      SHALL 等于会话的实际模式
- **AND** 既有的 `current_mode_update` SHALL 照旧送达（本变更不改变该通路）
- **AND** 该更新 SHALL 取自会话状态而非请求参数：会话**拒绝**某模式（如 plan 不可用时）时
      MUST NOT 广播一个并未生效的当前值
- **AND** 重设同一模式 SHALL NOT 重复广播（客户端缓存已正确）

备注：**必须**补这条更新 —— `configOptions` 只随 `session/new` / `session/fork` 响应下发，
没有它客户端的缓存在创建后就永远不再变化。发送的是完整集合（协议的 `ConfigOptionUpdate` 只带
`configOptions`，无增量形态）。

#### Scenario: 声明过的配置项可被写回

- **WHEN** client 对 `session/new` 广告的 `configId` 调用 `session/set_config_option`
- **THEN** 请求 SHALL 被接受，且该会话的模式 SHALL 变为所给值
- **AND** 响应 SHALL 含**完整**选项集，其中 `category: "mode"` 项的当前值 SHALL 等于会话的实际模式
- **AND** agent SHALL 追加一条 `config_option_update`，其内容与同一模式经 `session/set_mode`
       切换时**逐字段相同**（两个入口 MUST 是同一行为的两种写法）
- **AND** 切换后若模式未变（已是该值），SHALL NOT 重复广播

#### Scenario: 声明过的模型项可被写回

- **WHEN** client 以模型项广告过的取值调用 `session/set_config_option`（`configId: "model"`）
- **THEN** 请求 SHALL 被接受，且该会话的模型 SHALL 变为该值所指的模型
- **AND** 会话后续的出网连接 SHALL 使用该值所编码 entry 的 `baseURL`
- **AND** 响应 SHALL 含**完整**选项集，其中模型项的 `currentValue` SHALL 等于会话的实际模型
- **AND** agent SHALL 追加一条 `config_option_update`，其 `configOptions` SHALL 含模型项

#### Scenario: 未知模型取值被显式拒绝

- **WHEN** client 以当前选项集 **options 之外**的取值调用 `session/set_config_option`（`configId: "model"`）
- **THEN** agent SHALL 返回 JSON-RPC 错误，MUST NOT 静默接受
- **AND** 会话模型 MUST NOT 被改变

#### Scenario: 未声明的配置项被显式拒绝

- **WHEN** client 为当前选项集之外的 `configId` 调用 `session/set_config_option`
- **THEN** agent SHALL 返回 JSON-RPC 错误，MUST NOT 静默接受
- **AND** 会话模式与模型 MUST NOT 被改变

#### Scenario: 按 category 分派，不假定唯一选项

- **WHEN** client 以模型项的 `configId` 调用 `session/set_config_option`
- **THEN** 该请求 MUST NOT 被当作模式切换处理（会话模式 MUST NOT 因此改变）
- **AND** 以模式项的 `configId` 调用时，会话模型 MUST NOT 因此改变

#### Scenario: 不存在的会话被显式拒绝

- **WHEN** client 为一个没有 live 会话的 `sessionId` 调用 `session/set_config_option`
      **或** `session/set_mode`
- **THEN** agent SHALL 返回 JSON-RPC 错误，MUST NOT 报告成功
- **AND** 两个入口 SHALL 给出一致的答案（同一操作，同一会话状态，MUST NOT 因通路而异）

#### Scenario: load 与 resume 形状不变

- **WHEN** client 调用 `session/load` 或 `session/resume`
- **THEN** 响应 MUST NOT 因本变更而新增 `configOptions`（保持既有形状）

## ADDED Requirements

### Requirement: 模型切换不使用进程级 provider 注册

ACP agent 一进程服务多个会话。模型切换 SHALL 只作用于**该会话**：连接的解析与承载 SHALL 来自会话自身的
config（`model.set` 携带的 `modelStyle` / `modelBaseURL` / `modelApiKey`），
MUST NOT 依赖进程级 model provider 注册，也 MUST NOT 因一个会话的切换而改变另一个会话的出网连接。

#### Scenario: 一个会话的切换不影响另一个会话

- **WHEN** 同一进程内有两个 live 会话，client 只对其中一个切换模型
- **THEN** 该会话的模型与连接 SHALL 变为所选 entry
- **AND** 另一会话的模型与连接 MUST NOT 改变
