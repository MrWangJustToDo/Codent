# Change: ACP 会话配置选项可写

## Why

`add-acp-session-catalog` 让 `session/new` / `session/fork` 的响应携带 `configOptions`（一个
`category: "mode"` 的 `select`），并在 `set_mode` 后补发 `config_option_update`。但它把
`session/set_config_option` 明确列为 Non-Goal（`design.md:31`、归档的 `proposal.md:53`），
于是留下一个**已声明却不可用**的窄不一致：

实测（真连接 + 真 handler 表）——客户端拿到这个选择器后调用它：

```
configOptions: [{id:"mode", category:"mode", type:"select", currentValue:"normal", …}]
session/set_config_option → RequestError "Method not found" (-32601)
```

SDK 对该字段的注释是 *"Initial session configuration options **if supported** by the Agent"* ——
声明即暗示支持。编辑器把这个 select 渲染成模式下拉框，用户一选就撞 -32601，且客户端的 pending
永不 settle。这不是「少一个可选方法」：我们主动广告了一个用户可操作的控件。

## What Changes

- **acp**：注册 `session/set_config_option`，并把既有的模式切换实现抽成一处
  （`applyMode(bridge, mode)`），`set_mode` 与它共用。两者写的是同一份状态
  （`mode.set` 分发）、读的是同一份真源（会话快照的 `mode`），因此是**同一行为的两个入口**，
  MUST NOT 成为第二套模式逻辑。
- **acp**：本实现只声明一个配置项（`id: "mode"`），因此非 `mode` 的 `configId` 返回 JSON-RPC 错误。
  该判定取**声明的选项集**，而非硬编码字符串——将来新增配置项时不会漏改。
- **acp**：响应 `configOptions` 为**完整**选项集（协议 `SetSessionConfigOptionResponse`
  `configOptions` 是必填数组，无增量形态），取自会话实际状态而非请求参数；`set_mode` 那条
  `config_option_update` 的既有语义（含「未变化则不广播」）原样复用。
- **acp**：会话不存在（无 live bridge，例如只存在于磁盘、未在本进程打开）时返回 JSON-RPC 错误。
  这与实现既有的 `session/delete` 拒绝规则一致：只存在于磁盘的会话必须先打开才能改其模式
  （`session/delete` 是唯一不需要先打开的操作）。

## Non-Goals

- **不新增配置项种类**（boolean / 其他 category）。协议允许 `type: "boolean"`，但我们的会话没有
  第二个可配置项；不发明一个没有消费者的选项。将来新增时，`set_config_option` 按 `configId`
  分派即可（本 change 已把它写成查表而非硬编码）。
- **不改 `session/set_mode` 与 `current_mode_update` 通路**：那条通路是既有契约，本 change 不触碰它。
- **不为 `configOptions` 新增能力位**：ACP 的 agent 侧 `SessionCapabilities` 没有 config-options
  成员（该字段只存在于 client 侧 `ClientSessionCapabilities.configOptions`，描述*客户端*是否支持
  boolean 选项）——所以「如实声明」在这里没有可设的位，能力即「响应里有这个字段」。

## Impact

- 受影响 specs：`acp-session-catalog`（MODIFIED ×1 —— 「会话配置选项下发」）
- 受影响代码：
  - `packages/acp/src/agent.ts` — 抽出 `applyMode`；新增 `session/set_config_option` handler
  - `packages/acp/README.md` — 能力表补该行
  - `packages/acp/scripts/validate-acp-catalog.mjs` — 断言两个入口等价、拒绝规则、响应形状
- 无 breaking：新增一个此前返回 -32601 的方法；`set_mode` 的对外行为不变
