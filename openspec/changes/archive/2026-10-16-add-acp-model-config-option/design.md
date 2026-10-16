# Design — add-acp-model-config-option

## 背景：唯一通路是 `configOptions`

ACP 协议里模型选择**没有**专用方法。规范
（`/protocol/v1/session-config-options`）给的官方示例就是：

```json
{ "id": "model", "name": "Model", "category": "model", "type": "select",
  "currentValue": "model-1", "options": [ … ] }
```

上游 go-sdk v0.13.5 的 release note 明确：`session/set_model` 是**从未稳定**的实验 API，已连同
`SetSessionModelRequest/Response`、`ModelId`、`ModelInfo`、`SessionModelState`、以及会话响应上的
`models` 字段**整体移除**；模型选择改由 **稳定的** `session/set_config_option` 承载。维护者原话：

> Session config options have been around long enough, so cleaning up the old iteration.

一个旁证：本仓库的 SDK（`@agentclientprotocol/sdk`）里 `methods.agent` 全表**就没有** `session/set_model`
—— 我们的类型定义从未见过它，所以「补一个 set_model」从来不是选项。

## Decision 1：`category` 用 `"model"`，option `id` 用 `"model"`

**调研结论（4 个真实实现 + 规范）：**

| 实现 | option id | category |
|---|---|---|
| Kimi Code（spec-kimi-code） | `"model"` | `"model"` |
| Qwen Code | `"model"` | `"model"` |
| Rust Python SDK（Pollack 教程） | — | `"model"`（专用构造器 `SessionConfigSelect.model(...)`） |
| Hermes | `"model"` | `"model_config"` ⚠️ |

规范示例用 `category: "model"`。RFD `model-config-category` 把 `model_config` 定义为
**额外的模型相关参数**（context size、speed/quality trade-off），并明确 `thought_level` 归入
`model_config` 是**将来**的事、现在不要动。Hermes 用它装载模型选择器属于偏离规范。

**决定**：`category: "model"`、`id: "model"`。复数 `"models"` 只出现在 RFD 草案里，规范已收敛为单数，
4 个实现无一用复数。

## Decision 2：选项取值编码 entry —— `"<entryIndex>:<model>"`

规范**没有** id 唯一化要求（它的世界观里 agent 就一个 provider）。真实实现各自打补丁：

- **Hermes**：把 provider 编进 value（`"anthropic:claude-sonnet-4-6"`、`"custom:bedrock-mantle:openai.gpt-5.5"`），
  用 `seen_ids` / `seen_semantic_ids` 两个集合去重，`name` 形如 `"Provider · model"`。
- **Qwen**：value 直接用完整模型 id（其 id 天然带 provider/路由前缀）。
- **Kimi**：value 用裸模型 id，并**明确拒绝**双行变体（thinking 拆成独立 select）。

我们的模型 id 是 `entry.models` 里的**裸名**（如 `deepseek/deepseek-v4-flash-0731`），跨 entry 会重名，
所以**必须**编码。`"<entryIndex>:<model>"` 与 `app/src/commands/models.ts` 的 `/models` 取值**逐字相同**
（Hermes 的 `"<provider>:<model>"` 是同一思路的不同编码）。

客户端的责任只是把它当**不透明 id** 回传，因此编码格式对协议无影响。

**保底规则（协议硬要求）**：`currentValue` MUST 出现在 `options` 里，否则客户端渲染不出当前选中项。
因此「当前模型不在目录中」时（例如 `models.json` 改了，而会话是更早创建的），把它作为**首项**补入。

## Decision 3：不注册 provider —— 运行路径只读会话 config

`applyModelSelection`（app 的 `/models` 实现）在 dispatch 前调用 `registerModelProviderForEntry`。
这里**不照抄**，因为它对 ACP 是多余的：

```
managers/run-agent.ts:78-85   const adapter = createTextAdapter({
                                style: config.modelStyle,
                                model: config.model,
                                baseURL: config.modelBaseURL ?? DEFAULT_BASE_URLS[style],
                                apiKey: config.modelApiKey, … });
```

运行路径的连接**只取自会话自己的 `config`**；`getModelProvider()` 不在路径上（它是
`createAgentSessionFromConfig` 的初始化期解析路径）。

**收益**：ACP 不需要注册 provider 就天然 **per-session**（每个会话各自携带连接），也**不触碰进程级
registry**。这本是必须的：ACP 一个进程服务多个会话，而 registry 是全局单例 —— 会话 B 切换模型
会污染会话 A。绕过 registry 正是唯一正确的做法。

（这也解释了为什么不把公共逻辑抽成 core 共享函数：两边的实现**本来就该不同**。
强抽一个「通用切模型」会把 ACP 逼回全局 registry，或让 app 承担它不需要的分支。）

## Decision 4：选项按 category 分派，不留静默空洞

`set_config_option` 今天假定「唯一选项就是 mode」，直接 `applyMode(value as AgentMode)`。加入
模型项后，这个假定就是**广播一个并未生效的当前值**的来源。

**决定**：按选项的 `category` 分派（`mode` → `applyMode`；`model` → `applyModel`），
读不到的 category **显式报错**。同时**不引入第三种选项**（已声明的非目标），所以「未处理」= 真异常。

这与既有规则一致：判据是「期望状态是否已经为真」—— 一个未处理的 category 不可能「已经为真」。

## Decision 5：模型仅在目录存在时广告

显式 `--model` / `--base-url` / `--api-key` flags 是**权威**并跳过 `models.json`
（`bootstrap.ts:87-106`），此时没有目录。参考实现里 Hermes 有对应的 `None` 分支：**整体省略**模型项。

**决定**：无目录 ⇒ 不广告该选项。规范要求 agent MUST 为每个**已提供**的选项给出默认值；
省略不违反协议（客户端会优雅降级），而广告一个只有一个取值的选择器是**假选择**。

## Decision 6：`session/load` / `session/resume` 形状不变（已知缺口）

规范说 load 的响应携带 `configOptions`，但**既有基线 spec 明确冻结了这两条的形状**
（`acp-session-catalog`「load 与 resume 形状不变」scenario），且 `mode` 今天同样不下发。

**决定**：本变更**不**改动它们 —— 改一条已冻结的既有行为属于另一个变更
（应一次把 `modes` + `configOptions` 一起补上，而不是只补模型）。代价在 proposal 的
Known Limitation 里写明：客户端重开会话后选择器消失。

## Decision 7：目录读一次，当前值按会话读

目录是**进程级**的（`models.json` 一张表）；当前模型是**会话级**的（`snapshot.model`，
会因 `model.set` / 恢复而变）。因此：

- 目录在 bootstrap 读一次，经 `AcpAgentOptions.modelCatalog` 传入（bootstrap 本来就已经在做
  这次 `loadModels`，只是没把结果留下）。
- 选项集在**每次需要时**由会话快照构造，而不是在 `session/new` 时冻结。

这既符合「只有一个真源」，也避免为每个会话重复读盘。

## 顺序：模型在前，模式在后

规范说数组顺序即优先级，但真实实现**无共识**（Kimi `[model, thinking, mode]`，Qwen `[mode, model, reasoning]`）。
按「更常切换的在前」排 `[model, mode]`，且**保证 `mode` 仍在列表中**
（只支持旧 `modes` API 的客户端靠它，而 mode 项是它在新 API 下的对应物）。

## 与 `specs/acp-session-catalog` 旧断言的关系

既有 requirement 写着「SHALL 含**一个** `category: "mode"` 的 `select`」和
「值**与模式一样** SHALL 经既有 `mode.set` 分发」，后被本变更的 MODIFIED delta **改写**。
旧文字编码了「唯一选项是 mode」这一前提 —— 它随本变更失效，故**改 spec**（而非迁就旧文字不实现）。
