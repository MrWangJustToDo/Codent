## Context

ACP 有**两条**改变会话模式的协议路径，而我们的实现只注册了其中一条：

| 通路 | 请求 | 我们的状态 |
|---|---|---|
| 模式 API | `session/set_mode` (`{sessionId, modeId}`) | ✅ 已注册；`current_mode_update` 由 projector 的 `mode` channel 发出 |
| 通用配置 API | `session/set_config_option` (`{sessionId, configId, value}`) | ❌ 未注册 ⇒ `-32601` |

第三条相关通路是**下行**的：`configOptions` 字段（`session/new` / `session/fork` 响应 +
`config_option_update` 通知），由 `add-acp-session-catalog` 加入。

协议把三者连起来的方式是：`configOptions` 是**函数**，`set_config_option` 是它的**逆**——
客户端渲染一个 `category: "mode"` 的 select，用户改了它，客户端就发 `set_config_option`
（`{configId: "mode", value: <模式 id>}`），而不是 `set_mode`。所以我们广告了控件却关掉了它的写回路径。

### 事实（均已实测，非推测）

- `SetSessionConfigOptionResponse.configOptions` 是**必填**的 `Array<SessionConfigOption>`
  （`schema/types.gen.d.ts:2899-2903`）——响应必须回完整集合，没有增量形态。
- `SetSessionConfigOptionRequest` 是 `{sessionId, configId, value}` 的联合，`value` 依 `type`
  而不同（`"boolean"` 分支带 `value: boolean`；select 分支带 `value: SessionConfigValueId`）。
  我们的 `mode` 项是 `select`，故取字符串分支。
- agent 侧 `SessionCapabilities` **没有** config-options 成员；`ClientSessionCapabilities.configOptions`
  描述的是*客户端*能否处理 boolean 选项。所以「如实声明」在此没有可设的位。
- `session/set_config_option` 的 SDK 方法表键是大写驼峰 `setConfigOption`
  （`acp.d.ts:61`），方法名为 `session/set_config_option`。

## Goals / Non-Goals

- Goals：让已广告的 `mode` 选择器可写；两个入口共享同一实现，不产生第二套模式逻辑。
- Non-Goals：新增配置项种类；改动 `set_mode` / `current_mode_update` 既有契约；新增能力位。

## Decisions

### Decision: `set_config_option` 是 `set_mode` 的**同义入口**，不是第二种模式系统

两者最终都做同一件事：`dispatch({type: "mode.set", mode})`，然后从会话快照**回读**实际模式
（分发可能是 no-op，也可能被 clamp），据此补发 `config_option_update`。因此抽出：

```
applyMode(bridge, mode) → 校验 mode ∈ MODE_IDS → mode.set → 回读 → 必要时 config_option_update
```

`set_mode` 与 `set_config_option` 各自解析出自己的 `mode` 后调用它。**替代方案**（各自实现一遍）被否决：
两份「分发 + 回读 + 补发」迟早会漂移，而漂移的表现正是本项目已经踩过的坑——广播一个并未生效的当前值。

### Decision: 非 `mode` 的 `configId` 拒绝，判定取自**声明的选项集**

```
const option = sessionConfigOptions(session.getSnapshot().mode).find(o => o.id === configId);
if (!option) throw new Error(`Unknown configuration option: ${configId}`);
```

而不是 `if (configId !== "mode")`。理由是将来新增配置项时，硬编码判断会漏改（新增项会被误拒），
而查表判定不可能漏——选项集本身就是唯一真源。`type: "boolean"` 的分支同理不需要特判：
按 `configId` 找到项之后，值经 `mode` 校验即可。

### Decision: `set_config_option` 与 `set_mode` 对不存在的会话**一致**地拒绝

两者都经 `applyMode` 改变会话状态，因此对同一个「会话不存在」必须给同一个答案。
原本 `set_mode` 是唯一例外：`bridges.get()` 为 `undefined` 时它**不抛错、只返回 `{}`**，即
对一个从未触碰的会话报告「改模式成功」。

本 change 把这个例外也收紧为拒绝，理由是：

- **沉默的成功无法被客户端发现**。返回 `{}` 与真正切换成功在协议上不可区分，客户端会把
  自己那份 `configOptions` 缓存标成已生效——而服务端什么都没发生。
- **不对称本身是缺陷**。同一个操作经两个入口得到「拒绝」与「成功」两个答案，只取决于客户端
  碰巧用了哪条通路；而本 change 的全部意义就是让这两条通路等价。
- **`session/close` 的容忍不是反例**。它同样容忍缺失，但那里期望状态**已经是真的**（会话已经不在了，
  「关闭成功」是诚实答案）；`set_mode` 的期望状态（模式 = X）则完全不成立。判据是
  「期望状态是否已经为真」，不是「是否容忍缺失」。

## Risks

- 客户端可能**同时**有 `modeId` 通路与 `configId: "mode"` 通路，于是同一次用户操作发两次请求。
  这是无害的：第二次是 no-op（已是该模式），`config_option_update` 的「未变化不广播」规则
  （`bridge.lastAdvertisedConfigMode`）会挡掉重复广播。
