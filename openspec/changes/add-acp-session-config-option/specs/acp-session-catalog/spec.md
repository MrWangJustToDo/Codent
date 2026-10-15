## MODIFIED Requirements

### Requirement: 会话配置选项下发

agent SHALL 在 `session/new` 与 `session/fork` 的响应中携带 `configOptions`，其中 SHALL 含一个
`category: "mode"` 的 `select`（选项为 agent 的模式集合，当前值为该会话的当前模式）。
`session/load` 与 `session/resume` 的响应形状 MUST NOT 因本变更而改变。
模式仍经既有 `session/set_mode` 与 `current_mode_update` 通路同步，该 `configOptions` 项 SHALL 与该通路
保持一致，MUST NOT 成为第二个真源。

广告了 `configOptions` 即 SHALL 接受 `session/set_config_option`：`configOptions` 是声明，
`session/set_config_option` 是该声明的写回路径，二者 MUST 同时存在。该方法 SHALL
以 `configId` 在**当前声明的选项集**中查找（而非硬编码某个 id），未找到时返回 JSON-RPC 错误；
值与模式一样 SHALL 经既有 `mode.set` 分发并回读会话实际状态，MUST NOT 另建一套模式逻辑。

#### Scenario: 新会话下发模式选择器

- **WHEN** client 调用 `session/new`
- **THEN** 响应 SHALL 含一个 `category: "mode"` 的 `configOptions` 项，其 `type` 为 `select`
- **AND** 该项的当前值 SHALL 等于响应 `modes.currentModeId`（若同时提供）

#### Scenario: 分支会话下发模式选择器

- **WHEN** client 调用 `session/fork`
- **THEN** 响应 SHALL 含同样的 `category: "mode"` 项

#### Scenario: 模式切换后选择器保持同步

- **WHEN** client 通过 `session/set_mode` 切换到会话**实际接受**的另一个模式
- **THEN** agent SHALL 追加一条 `session/update`（`sessionUpdate: "config_option_update"`），其
      `configOptions` 为**完整**选项集，且 `category: "mode"` 项的当前值 SHALL 等于会话的实际模式
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

#### Scenario: 未声明的配置项被显式拒绝

- **WHEN** client 为当前选项集之外的 `configId` 调用 `session/set_config_option`
- **THEN** agent SHALL 返回 JSON-RPC 错误，MUST NOT 静默接受
- **AND** 会话模式 MUST NOT 被改变

#### Scenario: 不存在的会话被显式拒绝

- **WHEN** client 为一个没有 live 会话的 `sessionId` 调用 `session/set_config_option`
- **THEN** agent SHALL 返回 JSON-RPC 错误，MUST NOT 报告成功

#### Scenario: load 与 resume 形状不变

- **WHEN** client 调用 `session/load` 或 `session/resume`
- **THEN** 响应 MUST NOT 因本变更而新增 `configOptions`（保持既有形状）
