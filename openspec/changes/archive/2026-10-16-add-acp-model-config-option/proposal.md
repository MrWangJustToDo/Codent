# add-acp-model-config-option

## Why

ACP 客户端里**模型选择器不出现**，用户无法在编辑器内换模型。

根因不是缺机制，而是缺**数据**：

- 协议**没有** `session/set_model`（`session/set_config_option` 是唯一通路；go-sdk v0.13.5 已把
  从未稳定的 `session/set_model` / `SessionModelState` / 响应的 `models` 字段整体移除）。
- 我们已经实现了 `session/set_config_option` 的写回，但 `configOptions` 里**只广告了 `mode` 一项**
  （`packages/acp/src/agent.ts` 的 `sessionConfigOptions(current)`）。
- 实测（`models.json` 配了 3 个模型）：广告集为
  `[{id:"mode", category:"mode", type:"select", options:3}]`，对 `configId="model"` 返回
  `Internal error`。`models.json` 加载成功，但 `bootstrap.ts` 只取 `active` 那一项去注册 provider，
  **列表本身没有传递到 ACP 层**，所以客户端看不到任何可选模型。

core 侧能力齐备（`model.set` 支持连连接一起切、`resolveModelInfoFromModelsDev`、`loadModels`），
缺的是「把模型目录广告出去」+「按 category 分派写回」。

## What Changes

- **广告模型选择器**：`session/new` 与 `session/fork` 的 `configOptions` 增加一个
  `id: "model"` / `category: "model"` 的 `select`，选项来自工作区的 `models.json`；
  `currentValue` 恒等于该会话当前模型，且**必定**出现在 `options` 中。
- **写回**：`session/set_config_option` 按选项的 **`category`** 分派 —— `mode` → 既有 `mode.set`
  通路，`model` → `model.set`；未处理的 category 显式报错（不留静默空洞）。
- **连连接一起切**：选中项的取值编码 entry（`"<entryIndex>:<model>"`），切换时把该 entry 的
  `style` / `baseURL` / `apiKey` 与解析出的 `modelInfo` 一并交给 `model.set` —— 与 app 的 `/models`
  行为一致（用户在编辑器里换模型，等价于在 TUI 里换）。
- **不注册 provider**：运行路径的连接只取自会话自己的 config
  （`managers/run-agent.ts` 用 `config.modelStyle/modelBaseURL/modelApiKey` 建 adapter），
  全局 provider registry 不在路径上。因此在 ACP 里切模型**无需**注册 provider，既天然 per-session，
  也不动进程级状态。
- **目录来源**：仅当模型来自 `.agents/config/models.json` 时广告选择器；显式 `--model` 等 flags
  按既有约定跳过 `models.json`，此时不广告（选项集为空的选择器是骗人的）。
- **协议要求的默认值语义**：无目录 ⇒ 省略该选项；当前模型不在目录里 ⇒ 作为首项补入 `options`，
  保证 `currentValue ∈ options`（协议要求 agent MUST 为每个选项提供默认值）。
- **切连接的安全性**：不做。见下。

### 安全影响（必须明确）

「切连接」意味着**客户端选一个模型会改变出网凭据**（`baseURL` / `apiKey` 换成所选 entry 的）。
这是本次方案批准的语义，且与 TUI 的 `/models` 完全一致 —— 不是新增权限，而是把既有的
「换模型即换 provider」能力暴露给 ACP 客户端。

凭据**不入日志、不回传**：`configOptions` 只含模型 id / 显示名 / entry 的可读描述
（`direct:openai@https://…`，沿用 `/models` 的描述格式），`apiKey` 绝不出现在广告中。

### 非目标

- `thought_level`（reasoning 档位）选择器 —— 独立跟进。
- `authMethods` / `providers/*` —— 另外两条落差，与本变更无关。
- `session/load` / `session/resume` 的响应形状 —— **保持不变**（见 Known Limitation）。

## Impact

- 受影响 capability：`acp-session-catalog`（MODIFIED + ADDED）
- 受影响代码：
  - `packages/acp/src/agent.ts` —— 选项构造（收 model 目录 + per-session 当前值）、`set_config_option` 按 category 分派、新增 `applyModel`
  - `packages/acp/src/bootstrap.ts` —— 把 `loadModels` 得到的目录传入 `AcpAgentOptions`
  - `packages/acp/scripts/validate-acp-catalog.mjs` —— 新断言
  - `packages/acp/README.md` —— 记录模型选择器与「换模型即换 provider」
- **不动 core**：所需能力（`model.set` 的连接字段、`resolveModelInfoFromModelsDev`、`loadModels`）
  均已存在。
- 不改动 `session/load` / `session/resume` 的响应形状。

## Known Limitation（本变更不修，需另行确认）

`session/load` / `session/resume` 的响应仍**不含** `configOptions`（既有 spec 明确冻结其形状，
且 `mode` 今天也是如此）。因此客户端**重开会话后选择器会消失**，直到再 `session/new` / `session/fork`。

这是既有行为在模型选择器上的投影，不是本变更引入的回归；但它是真实 UX 缺口，
建议作为独立变更加以修复（一次把 `modes` + `configOptions` 一起补上）。
