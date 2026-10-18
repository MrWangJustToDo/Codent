## MODIFIED Requirements

### Requirement: 会话配置选项下发

agent SHALL 在 `session/new`、`session/load`、`session/resume` 与 `session/fork` 的响应中携带
`configOptions`，其中 SHALL 含一个 `category: "mode"` 的 `select`（选项为 agent 的模式集合，当前值为该会话的
当前模式）。

模型项的取值 SHALL 来自该会话所属 runtime 的模型读取（`readModels()`，由唯一的模型管线
`loadModels` 产出），MUST NOT 由连接层自行推导或兜底。该读取恒含当前模型，因此 `configOptions` SHALL
**始终**带一个 `category: "model"` 的 `select`：

- 读取列出多个模型时（本地 `models.json` 目录，或 remote-provider 平面下服务端可选的模型集合），选项 SHALL
  覆盖这些模型；
- 读取只列出一个模型时（显式 `--model` 等 flags、或 `.env` 兜底；以及 remote-provider 只服务一个模型的情形），
  选项 SHALL 是**单值**且不可切换，其存在是为了**告知当前模型**，MUST NOT 被省略、也 MUST NOT 广告一个
  无可选值的空选择器。

模型项的取值 SHALL 编码其所属 entry（`"<entryIndex>:<model>"`），使不同 entry 下的同名模型可区分，
且 SHALL 把该 entry 的 `style` / `baseURL` 编入选项描述以便用户辨识。广告内容 MUST NOT 含任何凭据
（`apiKey`）。

模型项的 `currentValue` SHALL 恒等于该会话的当前模型，且 SHALL **始终**出现在该选项的 `options` 中
（协议要求 agent 为每个已提供的选项给出可用默认值）：会话当前模型不在读取的列表内时 SHALL 把它作为首项补入。

当且仅当该会话当前模型**有推理能力的证据**（能力列表含 `reasoning` 且模型广告了档位列表）时，
`configOptions` SHALL 另有一个 `category: "thought_level"` 的 `select`：

- 选项 SHALL 为模型广告的档位外加一个「模型默认」项（取其值为 `"off"`）；
- `currentValue` SHALL 是 `options` 中的成员（未显式设定时即「模型默认」项的取值）；
- 写回取值为「模型默认」项时 SHALL 清除会话的强度（`effort.set` 的 `effort` 为 `undefined`），
  MUST NOT 把一个名为 `off` 的档位记录进会话；
- 模型没有推理证据时该选项 SHALL 被**省略**，MUST NOT 广告只有一个假值的伪选择器；
- 切换到没有推理证据的模型后，下一次广告 SHALL 不再包含该选项（不得保留会让新模型无法履行的旧档位）。

同一份读取 SHALL 同时供**旧的模型表面**使用：响应中的 `models`（`{ currentModelId, availableModels:
[{ modelId, name, description? }] }`）与 `session/set_model` SHALL 与 `configOptions` 的模型项**同源**——
相同的 `modelId`、相同的顺序、相同的当前值。MUST NOT 出现两个表面各自回答一次的情况。

模式仍经既有 `session/set_mode` 与 `current_mode_update` 通路同步，该 `configOptions` 项 SHALL 与该通路
保持一致，MUST NOT 成为第二个真源。

对**不存在的会话**改变会话状态的请求（`session/set_mode`、`session/set_config_option`，以及既有的
`prompt` / `cancel` / `fork`）SHALL 以 JSON-RPC 错误拒绝，MUST NOT 静默报告成功；`session/close` MAY
容忍缺失（那里期望状态已经为真）。判据是「期望状态是否已经为真」，不是「该请求是否幂等」。

广告了 `configOptions` 即 SHALL 接受 `session/set_config_option`：`configOptions` 是声明，
`session/set_config_option` 是该声明的写回路径，二者 MUST 同时存在。该方法 SHALL
以 `configId` 在**当前声明的选项集**中查找（而非硬编码某个 id），未找到时返回 JSON-RPC 错误；
随后 SHALL 按**该选项的 `category`** 分派到对应通路（`mode` → `mode.set`，`model` → `model.set`，
`thought_level` → `effort.set`），
MUST NOT 假定「唯一选项是 mode」而把任意取值当作模式。

三个选项各自的语义 SHALL 与既有通路一致，MUST NOT 成为第二个真源：

- `mode`：经既有 `mode.set` 分发并回读会话实际状态，MUST NOT 另建一套模式逻辑。
- `model`：经 `model.set` 分发（随该模型所属 entry 的 `style` / `baseURL` / `apiKey` 与解析出的
  `modelInfo` 一并下发），并回读会话实际状态。切换后该会话后续的出网连接 SHALL 使用所选 entry。
  写入的合法值 SHALL 以**同一份 runtime 读取**校验（展示与写入同源），MUST NOT 用另一份列表校验。
- `thought_level`：经既有 `effort.set` 分发并回读会话实际状态；取值不在该模型广告的档位内时
  SHALL 以 JSON-RPC 错误拒绝且不改变会话。

`thought_level` 的变更 SHALL 与其他选项一样触发 `config_option_update`，且该更新 MUST 携带**完整**的
选项集（协议没有增量形态）；值未实际变化时 MUST NOT 广播。

`/models` 斜杠命令 SHALL 与选择器共用同一写回实现（`applyModel` / `effort.set`），
MUST NOT 出现第二套模型切换路径；强度 SHALL 在模型切换**之后**按新模型的广告校验，且该路径同样 SHALL
在切换成功后广播 `config_option_update`（客户端缓存不会自行刷新）。

agent MUST NOT 为支持模型切换而注册进程级 model provider：连接由会话自身的 config 承载，
在 ACP 一进程多会话的形状下，注册全局 provider 会让一个会话的切换污染另一个会话。

未处理的 `category` SHALL 以 JSON-RPC 错误拒绝，MUST NOT 被静默忽略或退回某个通路。

#### Scenario: 新会话下发模式选择器

- **WHEN** client 调用 `session/new`
- **THEN** 响应 SHALL 含一个 `category: "mode"` 的 `configOptions` 项，其 `type` 为 `select`
- **AND** 该项的当前值 SHALL 等于响应 `modes.currentModeId`（若同时提供）

#### Scenario: 新会话下发模型选择器

- **WHEN** client 调用 `session/new`，且 runtime 的模型读取列出多个模型（如含多个模型的 `models.json`）
- **THEN** 响应 SHALL 含一个 `category: "model"` 的 `configOptions` 项，其 `type` 为 `select`
- **AND** 其 `options` SHALL 覆盖该读取中的模型，取值 SHALL 编码 entry
- **AND** `currentValue` SHALL 等于该会话的当前模型，且 SHALL 出现在 `options` 中
- **AND** 选项值或描述 MUST NOT 含 `apiKey` 等凭据

#### Scenario: 只有一个模型时是单值告知

- **WHEN** runtime 的模型读取只列出一个模型（显式 `--model`、`.env` 兜底，或只服务一个模型的 provider）
- **THEN** `configOptions` SHALL 仍含 `category: "model"` 项，且其 `options` 恰有一项
- **AND** 其 `currentValue` SHALL 等于该模型
- **AND** 该情形下对其写入 SHALL 以 JSON-RPC 错误拒绝（没有可切换的目标），MUST NOT 静默成功

#### Scenario: remote-provider 平面可切换

- **WHEN** agent 以 `--remote-provider` 启动，且 provider 服务端声明了多个可选模型
- **THEN** `configOptions` 的模型项 SHALL 列出这些模型（服务端 `models.json` 的 id、其 active、以及实际服务的模型）
- **AND** 选择其中任一项 SHALL 经 `model.set` 生效，且不注册进程级 provider

#### Scenario: 当前模型不在读取内时补入

- **WHEN** 会话的当前模型不在 runtime 读取的模型集合内
- **THEN** 模型项 SHALL 把该模型作为首项补入 `options`
- **AND** `currentValue` SHALL 等于该模型（因而仍是 `options` 的成员）

#### Scenario: 旧模型表面与配置项同源

- **WHEN** client 读取响应的 `models` 字段，或调用 `session/set_model`
- **THEN** `models.currentModelId` SHALL 等于模型项的 `currentValue`
- **AND** `availableModels` 的 `modelId` 序列 SHALL 与模型项 `options` 的取值序列逐一相同
- **AND** `session/set_model` 的合法取值 SHALL 与 `session/set_config_option` 的模型分支一致

#### Scenario: 恢复会话下发选择器

- **WHEN** client 调用 `session/load` 或 `session/resume`
- **THEN** 其响应 SHALL 携带与 `session/new` 相同的 `configOptions` 与 `models`
- **AND** `currentValue` / `currentModelId` SHALL 取恢复后会话的实际模型

#### Scenario: 分支会话下发模式选择器

- **WHEN** client 调用 `session/fork`
- **THEN** 响应 SHALL 含同样的 `category: "mode"` 项

#### Scenario: 分支会话下发模型选择器

- **WHEN** client 调用 `session/fork`，且 runtime 的模型读取列出模型
- **THEN** 响应 SHALL 含 `category: "model"` 的项，其 `currentValue` SHALL 等于分支会话的当前模型

#### Scenario: 模式切换后选择器保持同步

- **WHEN** client 通过 `session/set_mode` 切换到会话**实际接受**的另一个模式
- **THEN** agent SHALL 追加一条 `session/update`（`sessionUpdate: "config_option_update"`），其
      `configOptions` 为**完整**选项集（含模型项），且 `category: "mode"` 项的当前值
      SHALL 等于会话的实际模式
- **AND** 既有的 `current_mode_update` SHALL 照旧送达（本变更不改变该通路）
- **AND** 该更新 SHALL 取自会话状态而非请求参数：会话**拒绝**某模式（如 plan 不可用时）时
      MUST NOT 广播一个并未生效的当前值
- **AND** 重设同一模式 SHALL NOT 重复广播（客户端缓存已正确）

#### Scenario: 推理模型的档位选择器

- **WHEN** 会话当前模型广告了推理档位
- **THEN** `configOptions` 含一个 `category: "thought_level"` 的 `select`，选项为「模型默认」加各档位
- **AND** 其 `currentValue` 出现在 `options` 中
- **AND** 写回「模型默认」的取值 SHALL 清除会话强度，且会话记录的强度 MUST NOT 是名为 `off` 的档位

#### Scenario: 无推理证据的模型没有档位选择器

- **WHEN** 模型的能力列表不含 `reasoning`，或没有广告任何档位
- **THEN** `configOptions` 不含 `thought_level` 选项

#### Scenario: 模型切换后档位选择器随之消失

- **WHEN** 一次 `set_config_option(model)` 把会话切到没有推理证据的模型
- **THEN** 随后的 `config_option_update` 与响应都不再包含 `thought_level` 选项

#### Scenario: 未广告的档位被拒绝

- **WHEN** 客户端为 `thought_level` 提交一个该模型未广告的取值
- **THEN** 请求以 JSON-RPC 错误拒绝，且会话的强度不变

#### Scenario: 斜杠命令切换后选择器同步

- **WHEN** 客户端以 `prompt` 发送 `/models 0:some-model high`
- **THEN** agent SHALL 切到该模型、再按**新模型**校验并应用 `high`
- **AND** SHALL 广播一条完整选项集的 `config_option_update`，其 model 与 thought_level 的
      `currentValue` 均等于会话的实际状态

备注：完整选项集同时随 `new` / `load` / `resume` / `fork` 响应下发，且会话内变化必须再经
`config_option_update` 广播 —— 客户端缓存在没有该更新时不会自行刷新。发送的永远是完整集合（协议的
`ConfigOptionUpdate` 只带 `configOptions`，无增量形态）。
