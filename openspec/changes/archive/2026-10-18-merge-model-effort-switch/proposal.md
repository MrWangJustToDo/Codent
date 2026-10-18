# merge-model-effort-switch

## Why

模型切换与思考强度切换是两个独立命令（`/models`、`/effort`），但它们描述的是**同一个决定**：这一轮由哪个模型、以多大强度思考。

分裂带来的实际后果：

- 用户在 `/models` 里换到一个不支持当前强度的模型，`effort.set` 的旧值会被静默保留，直到请求被上游拒绝才发现；
- 强度菜单必须自己判断"当前模型支持什么"，而模型菜单不知道强度存在，两处各自读 `modelInfo`，是两份可能漂移的证据；
- 想改强度必须离开模型菜单、记住另一个命令名。上下文菜单只能一层深，所以做不到"选模型 → 选强度"；
- thinking 行显示开关（纯 UI 状态）混在 `/effort display` 里，与模型的推理档位挤在同一入口。

ACP 侧的落差是同一件事的另一半：`/effort` 是斜杠命令，客户端没有对应 UI；而协议本来就有
`category: "thought_level"` 这个选项类别，我们一直没有广告它，于是 ACP 客户端能换模型却不能用选择器换强度。

## What Changes

- **命令合并**：`/models` 成为模型 + 思考强度的唯一入口，语法为
  `/models [entryIndex:modelId [effort|off]]`（无参数 = 列目录）。`/effort` 从
  `BUILTIN_COMMAND_CATALOG` 移除，因此 ACP 也不再广告它。
- **core 拥有语法**：新增 `parseModelsCommand`（与 `parseModeCommand` 同一层：意图而非命令），
  以及 `offerableReasoningEfforts`（菜单可以**提供**什么，与既有的
  `supportedReasoningEfforts`（校验接受什么）明确分工）。
- **通用嵌套选项菜单**（app 侧新能力，不是 `/models` 专属）：
  - `CommandOption` 新增可选 `getOptions` —— 有它即"这一项会打开下一层"，没有被选中即执行；
  - `Command.getOptions(ctx, path)` 收到当前选项值链，一个命令即可服务所有层；
  - `Esc` 逐层回退（回退到父层并重写输入），仅在最顶层关闭菜单；
  - 下一层为空 ⇒ 该行按叶子处理（执行），不会把用户困在空菜单里。
- **延迟提交**：选中模型只下钻，不切换；直到选中强度（或该模型没有强度层、模型本身即叶子）才一次提交
  `model.set` + `effort.set`。因此 `Esc` 回退后会话仍停在原模型上。
- **thinking 行开关迁入 `/settings`**：新增 `thinking` 行与 `/settings thinking on|off|toggle`。
- **ACP 新增 `thought_level` 选择器**：`configOptions` 里 `category: "thought_level"` 的 `select`，
  写回走 `applyThoughtLevel`；仅在模型有推理证据时广告，换到无强度的模型时该选项消失。
  `/models` 在 ACP 侧走 `applyModel`（与选择器同一实现），并在切换后按**新模型**校验强度。
- **切换模型时丢弃模型不再支持的显式强度**（`ManagedAgent.setModel`）：否则 `high` 会被继续
  转发给一个新模型（`run-agent` 只做 `config.reasoningEffort ?? defaultEffort`），使本次合并的
  核心目的（模型 + 强度是一个决定）落空。新模型仍广告该档位时保留。
- **`"<entryIndex>:<model>"` 编解码收进 core**（`encodeModelChoice` / `decodeModelChoice`）：
  原先 app / ACP / `parseModelsCommand` 三处各写一份，而它是一个必须在宿主间往返的协议取值。
- **斜杠命令路径补发 `config_option_update`**（ACP）：`set_config_option` 的写路径本来会重发；
  以 prompt 形式下发的 `/models` 早退返回命令文本，不补发则客户端选择器会停在旧值。

## Impact

- 受影响 capability：`builtin-command-catalog`（MODIFIED）、`acp-session-catalog`（MODIFIED）、
  `session-host-api`（MODIFIED，命令目录不再含独立的思考强度命令）、`app-command-menu`（ADDED）
- 受影响代码：
  - `packages/core/src/agent/commands/arguments.ts` —— `parseModelsCommand` 取代 `parseEffortCommand`
  - `packages/core/src/models/types.ts` —— `offerableReasoningEfforts`
  - `packages/core/src/agent/commands/catalog.ts` —— 移除 `effort`，更新 `models` / `settings`
  - `packages/app/src/commands/models.ts` —— 两段式菜单 + 延迟提交
  - `packages/app/src/commands/effort.ts` —— 删除
  - `packages/app/src/hooks/use-autocomplete.ts` —— 层栈、`back()`、路径感知过滤
  - `packages/app/src/commands/settings.ts` —— `thinking` 行
  - `packages/acp/src/session-config-options.ts` —— `thought_level` 选项 + `applyThoughtLevel`
  - `packages/acp/src/commands.ts` —— `/models` 斜杠写回（`/effort` 分发删除）
- 校验：`validate:builtin-command-arguments`、`validate:acp:command-args`、`validate:acp:catalog`
  均新增/改写了对应断言；app 新增 `test/nested-command-menu.test.mjs`。

## 非目标

- 不改 `effort.set` / `model.set` 的 `AgentSessionCommand` 形状（仍是两条命令，合并只在语法层）。
- 不为 ACP 引入工具/模型的二级菜单——`thought_level` 是扁平选择器，协议没有嵌套选择器概念。
- 不改 remote 平面：`session` 类型 entry 仍不带连接，强度依旧由会话自身记录。
