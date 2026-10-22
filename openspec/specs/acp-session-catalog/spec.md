# acp-session-catalog Specification

## Purpose
TBD - created by archiving change add-acp-session-catalog. Update Purpose after archive.
## Requirements
### Requirement: 会话目录以磁盘会话为真源

agent SHALL 通过 `session/list` 返回**工作区磁盘上的可恢复会话**目录，而非仅本进程内的 live 会话；每条记录 SHALL 映射为 ACP `SessionInfo`（`sessionId`、`cwd`、`title`、`updatedAt`），`cwd` SHALL 为该会话的工作区根绝对路径，`updatedAt` SHALL 为 ISO 8601，`title` 缺失时 MAY 省略或为 `null`。`session/list` 携带 `cwd` 时 SHALL 只返回该根下的会话；未携带时 SHALL 返回进程默认根下的会话。列举 SHALL 复用 core 的会话列举能力（只读每个日志的最后一行状态），MUST NOT 在 ACP 层拼接存储路径。单条记录的 `updatedAt` 非法或缺失 SHALL 被跳过，MUST NOT 使整个 `session/list` 失败。

#### Scenario: 列表来自磁盘

- **WHEN** client 调用 `session/list`，且工作区内有由本进程创建过的会话与由更早进程创建的会话
- **THEN** 两者 SHALL 都出现在响应中
- **AND** 排序 SHALL 与 core 列举的 `updatedAt` 降序一致

#### Scenario: 空目录

- **WHEN** 工作区内没有任何已持久化会话
- **THEN** 响应 SHALL 为 `{ sessions: [] }`，MUST NOT 报错

#### Scenario: 请求带 cwd 时过滤

- **WHEN** `session/list` 的 `cwd` 与会话的工作区根不同
- **THEN** 响应 SHALL 只包含 `cwd` 匹配的会话
- **AND** 未带 `cwd` 时 SHALL 只列进程默认根下的会话

#### Scenario: 单条坏记录不拖垮整页

- **WHEN** 某条会话的 `updatedAt` 缺失或无法解析
- **THEN** 该条 SHALL 被跳过，其余会话 SHALL 正常返回
- **AND** MUST NOT 因 `toISOString()` 抛错而使 `session/list` 失败

### Requirement: 会话目录分页

`session/list` SHALL 支持游标分页：响应 SHALL 在还有更多结果时返回 `nextCursor`，请求携带 `cursor` 时
SHALL 仅返回全序中严格晚于该边界行的会话（全序 = `updatedAt` 降序、同值按 `id` 升序）。
游标 MUST 编码该全序的边界（即 `(updatedAt, id)` 复合键），MUST NOT 只用 `updatedAt` ——
否则同一毫秒的两条会话会在页边界上被整页丢弃。游标语义 SHALL 对客户端不透明。

#### Scenario: 首页与次页

- **WHEN** 会话数超过单页上限，client 先以无 `cursor` 请求、再以返回的 `nextCursor` 请求
- **THEN** 两页的 `sessionId` SHALL 不重叠
- **AND** 最后一页 SHALL 不返回 `nextCursor`

### Requirement: 会话删除

agent SHALL 通过 `session/delete` 删除会话。删除 SHALL 经 core 的会话存储完成（宿主提供，agent MUST NOT 自行拼接存储路径）。**成功条件 SHALL 为「该会话本进程内 live（已先行关闭）、磁盘文件已删，或该 id 从未存在」**——ACP 要求删除一个已不存在的会话应当成功，因此一个既不 live、磁盘上也没有文件的 id SHALL 被视为幂等成功，MUST NOT 返回 not-found。删除 live 会话 SHALL 先行停止在飞运行并注销。

#### Scenario: 删除已持久化会话

- **WHEN** client 对 `session/list` 返回的 `sessionId` 调用 `session/delete`
- **THEN** 该会话的文件 SHALL 被移除，随后的 `session/list` MUST NOT 再包含它
- **AND** 响应 SHALL 成功

#### Scenario: 删除刚创建尚未落盘的会话

- **WHEN** client 先 `session/new`、随即对该 `sessionId` 调用 `session/delete`（此时磁盘上还没有该会话的文件）
- **THEN** 响应 SHALL 成功（该会话在本进程内 live）
- **AND** MUST NOT 返回 not-found

#### Scenario: 删除不需要先打开会话

- **WHEN** client 删除一个本进程从未打开过的已持久化会话
- **THEN** agent SHALL 直接删除成功，MUST NOT 需要先创建/连接一个会话
- **AND** MUST NOT 为此创建 ManagedAgent（不得拉起扩展开销）

#### Scenario: 删除不存在的会话是幂等的

- **WHEN** client 对一个**既非 live、也从未持久化**的 `sessionId` 调用 `session/delete`
- **THEN** 响应 SHALL 成功（目标状态已成立）
- **AND** MUST NOT 返回 not-found

#### Scenario: 删除 live 会话

- **WHEN** 被删会话在本进程内存在 live 会话
- **THEN** agent SHALL 先行停止在飞运行、注销该会话，再删除持久化数据
- **AND** 该 `sessionId` 之后的 `session/prompt` SHALL 返回会话未知错误

### Requirement: 会话分支

agent SHALL 通过 `session/fork` 以既有会话为上下文创建一个新会话，源会话 SHALL 保持不变且仍可 resume。分支 SHALL 复用 core 的会话克隆语义（复制消息与模型设置），MUST NOT 截断历史（ACP 的 fork 请求不携带分支点）。源会话 MAY 不在本进程内 live：agent SHALL 先按 `session/resume` 的语义恢复它（不回放）再 clone。fork 完成后 SHALL 把同一 bridge 重绑到新磁盘 id：更新句柄、`bridges` 键、`runtime.bind(newId)`（client-env）并重置 `replayed`；clone dispatch 期间 SHALL 抑制投影，MUST NOT 以源 id 发出新会话的更新。

#### Scenario: 分支产生新会话

- **WHEN** client 对某 `sessionId` 调用 `session/fork`
- **THEN** 响应 SHALL 返回一个与源不同的新 `sessionId`
- **AND** 新会话的既有消息 SHALL 等于源会话在分支时刻的消息

#### Scenario: 源会话不受影响

- **WHEN** 一次 fork 完成
- **THEN** 源会话仍可通过 `session/resume` 继续，其持久化数据未被改写

#### Scenario: 分支后的事件归属

- **WHEN** fork 完成且 client 代表新会话继续 prompt
- **THEN** `session/update` SHALL 以新句柄送达
- **AND** 源 `sessionId` MUST NOT 再收到该会话的运行事件
- **AND** clone 期间 MUST NOT 有更新以源 id 发出

#### Scenario: 运行中拒绝

- **WHEN** 源会话有在飞运行时调用 `session/fork`
- **THEN** agent SHALL 返回错误且不创建任何东西，错误信息 SHALL 提示先停止运行

#### Scenario: 非 live 源先恢复再分支

- **WHEN** client 对一个由 `session/list` 返回、本进程未打开过的会话调用 `session/fork`
- **THEN** agent SHALL 先恢复该源会话（不回放），再 clone
- **AND** 响应 SHALL 返回新会话，MUST NOT 因源不在内存而报"会话未知"

#### Scenario: client-env 下 fork 重绑环境

- **WHEN** `--client-env` 开启时 fork 成功
- **THEN** 后续该会话的 `fs/*` / `terminal/*` 请求 SHALL 携带新句柄对应的 sessionId
- **AND** MUST NOT 继续携带源会话的 sessionId

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

### Requirement: 未声明的 additionalDirectories 在每个可携带它的请求上被拒绝

每一个可携带 `additionalDirectories` 的请求 SHALL 以 JSON-RPC 错误拒绝该字段，MUST NOT 静默忽略。
该能力未被声明（agent 只服务握手时获得的那个工作区根），而
`openspec/specs/acp-agent-host/spec.md` 要求「未声明的能力对应的 client 请求 MUST NOT 被接受」。

至少覆盖 `session/new`、`session/load`、`session/resume`、`session/fork` 四者 —— 四者 MUST 共用
同一处判定与同一条错误文本（客户端无需知道自己发的是哪个请求就能匹配该拒绝）。`session/new`
是客户端默认入口，它静默忽略的代价最大：客户端会得到一个“看不见那些路径、却什么都不说”的会话。

#### Scenario: session/new 拒绝额外工作区根

- **WHEN** client 发送 `session/new` 且 `additionalDirectories` 非空
- **THEN** agent SHALL 返回 JSON-RPC 错误，错误文本 SHALL 指明 `additionalDirectories`
- **AND** MUST NOT 创建会话（MUST NOT 静默丢弃该字段后照常创建）

#### Scenario: load / resume 拒绝额外工作区根

- **WHEN** client 发送 `session/load` 或 `session/resume` 且 `additionalDirectories` 非空
- **THEN** agent SHALL 返回 JSON-RPC 错误，且 MUST NOT 创建会话

#### Scenario: fork 拒绝额外工作区根

- **WHEN** client 发送 `session/fork` 且 `additionalDirectories` 非空
- **THEN** agent SHALL 返回 JSON-RPC 错误，且 MUST NOT 创建会话

#### Scenario: 四条路径的拒绝文本一致

- **WHEN** 四个请求各带一次非空 `additionalDirectories`
- **THEN** 四者返回的错误文本 SHALL 完全相同（同一处判定）

备注：`cwd` 仅作提示（根在握手时已固定，与 `session/new` 一致）。`ListSessionsRequest` **不含**
`additionalDirectories`（只有 `cwd?` / `cursor?`），因此 `session/list` 不在本条覆盖内；
`DeleteSessionRequest` 只有 `sessionId`，同样不在内。

### Requirement: session/fork 拒绝无法生效的 mcpServers

`session/fork` SHALL 以 JSON-RPC 错误拒绝非空 `mcpServers`，MUST NOT 静默忽略：
分支会话复用源会话的 live agent（fork 路径**没有** `Host.create`），因此 agent 级的 MCP 服务器
确实无法更换 —— 此时 agent SHALL 以 JSON-RPC 错误拒绝该请求，MUST NOT 静默忽略。

对照：`session/new`、`session/load`、`session/resume` 都各自经 `Host.create` **新建** agent，
因此它们 SHALL **接受并下发** `mcpServers`（见 `add-session-mcp-servers`）—— 拒绝在这三者上会是
对客户端的硬阻断，而不是保护。

#### Scenario: fork 携带非空 mcpServers

- **WHEN** `session/fork` 携带非空 `mcpServers`
- **THEN** agent SHALL 返回 JSON-RPC 错误，MUST NOT 静默忽略
- **AND** MUST NOT 为该请求创建会话

### Requirement: 模型切换不使用进程级 provider 注册

ACP agent 一进程服务多个会话。模型切换 SHALL 只作用于**该会话**：连接的解析与承载 SHALL 来自会话自身的
config（`model.set` 携带的 `modelStyle` / `modelBaseURL` / `modelApiKey`），
MUST NOT 依赖进程级 model provider 注册，也 MUST NOT 因一个会话的切换而改变另一个会话的出网连接。

#### Scenario: 一个会话的切换不影响另一个会话

- **WHEN** 同一进程内有两个 live 会话，client 只对其中一个切换模型
- **THEN** 该会话的模型与连接 SHALL 变为所选 entry
- **AND** 另一会话的模型与连接 MUST NOT 改变

### Requirement: 会话标识使用稳定句柄

agent SHALL 使用一个 client-facing `sessionId` 句柄，并在 `session/new` 时返回它（初始值等于磁盘会话 id `ses_…`）。句柄 SHALL 在会话生命周期内保持稳定：当会话内的 slash 命令（`/new` / `/clone` / `/resume`）替换底层磁盘会话时，agent SHALL 把该句柄重绑到新的磁盘会话，MUST NOT 让 `session/update` 改用 client 不知道的新 id。`session/list` / `session/delete` SHALL 使用磁盘 id。`session/load` SHALL 接受句柄或磁盘 id；`session/resume`、`session/close`、`session/fork` 在会话 live 时 SHALL 接受句柄；冷恢复（非 live）的 `session/resume` / `session/fork` SHALL 使用磁盘 id。内部 `sessionId → live 会话` 的映射 SHALL 同时记录句柄与当前磁盘 id，`session_info_update` SHALL 在 `_meta.diskSessionId` 中报告当前磁盘 id。MUST NOT 把 agent 运行时 id 当作 ACP `sessionId` 暴露给 client。

#### Scenario: new 返回的句柄可用于 load

- **WHEN** client 调用 `session/new` 得到 `sessionId`，随后以同一个 `sessionId` 调用 `session/load`
- **THEN** agent SHALL 定位到同一会话并成功回放，MUST NOT 报会话未知

#### Scenario: new 返回的句柄可用于 resume 与 close

- **WHEN** client 以 `session/new` 返回的 `sessionId` 调用 `session/resume`，随后调用 `session/close`
- **THEN** 两次调用 SHALL 都定位到同一会话

#### Scenario: slash 命令替换会话后句柄保持稳定

- **WHEN** client 在会话内触发 `/new`、`/clone` 或 `/resume`，底层磁盘会话 id 发生变化
- **THEN** 该会话的 ACP 句柄 SHALL 保持不变
- **AND** 后续 `session/update` SHALL 继续使用该句柄
- **AND** `session_info_update._meta.diskSessionId` SHALL 报告新的磁盘 id

#### Scenario: list 返回的 id 可用于其余方法

- **WHEN** client 以 `session/list` 返回的任一磁盘 `sessionId` 调用 `session/delete` 或 `session/load`
- **THEN** agent SHALL 定位到该会话，MUST NOT 因 id 空间不匹配而报"会话未知"

#### Scenario: load 接受句柄或磁盘 id

- **WHEN** client 用 `session/new` 得到的句柄（可能已重绑）或 `session/list` 得到的磁盘 id 调用 `session/load`
- **THEN** 两者 SHALL 都能定位到对应会话

### Requirement: 模型重选不改变模型元数据

重选当前模型（值不在 catalog 中，或与当前模型相同）SHALL 是一个 no-op：agent MUST NOT dispatch `model.set`，也 MUST NOT 用 `null` 清空 `modelInfo`（能力、上下文窗口与价格）。只有真正切换到不同模型时才 SHALL 重新解析元数据。

#### Scenario: 重选当前值不清空能力

- **WHEN** client 从 `configOptions.model` 选择与当前模型相同的值（包括不在 catalog 中的当前模型）
- **THEN** `modelInfo`、能力与上下文窗口 SHALL 保持不变
- **AND** MUST NOT 发生一次 `model.set` 或一次 metadata 清空

