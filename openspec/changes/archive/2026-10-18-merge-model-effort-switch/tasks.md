## 1. core：语法与规则

- [x] 1.1 `packages/core/src/agent/commands/arguments.ts`：以 `parseModelsCommand` 取代 `parseEffortCommand`
      （`list` / `set` / `invalid`，`"<entryIndex>:<model>"` 或裸模型，可选档位或 `off`）
- [x] 1.2 `packages/core/src/models/types.ts`：新增 `offerableReasoningEfforts`（菜单可提供什么：需
      `reasoning` 能力 + 非空档位列表），与 `supportedReasoningEfforts`（校验接受什么）分工写明
- [x] 1.3 `packages/core/src/agent/commands/catalog.ts`：移除 `effort` 条目；`models` 改为
      `scope: "both"` 且 usage 含档位参数；`settings` usage/description 增加 `thinking`
- [x] 1.4 `packages/core/src/index.ts`：导出换成 `parseModelsCommand` / `offerableReasoningEfforts`

## 2. app：通用嵌套选项菜单

- [x] 2.1 `commands/utils/types.ts`：`CommandOption.getOptions`（有 = 可下钻）、
      `Command.getOptions(ctx, path)`（收到当前值链）
- [x] 2.2 `hooks/use-autocomplete.ts`：层栈 `levels` + `optionPath`；`back()` 逐层回退；
      路径感知过滤（先剥掉层级前缀再匹配）
- [x] 2.3 `hooks/use-autocomplete.ts`：空子层按叶子处理（执行而非打开空菜单）
- [x] 2.4 `hooks/keybindings/global.ts`：Esc 先 `back()`，只有最顶层才 `dismiss()`
- [x] 2.5 `components/AutocompleteList.tsx`：子菜单行显示 `›`

## 3. app：/models 两段式与 /settings

- [x] 3.1 `commands/models.ts`：第 0 层模型列表；每个模型行声明档位层解析器（无档位则答 `[]`）
- [x] 3.2 `commands/models.ts`：延迟提交 —— 选中模型只下钻，叶子处一次 `model.set` + `effort.set`
- [x] 3.3 `commands/models.ts`：强度按**新模型**校验（换模型后读会话的 `modelInfo`）
- [x] 3.4 删除 `commands/effort.ts`，从 `commands/index.ts` 移除其 import
- [x] 3.5 `commands/settings.ts`：新增 `thinking` 行与 `/settings thinking on|off|toggle`
- [x] 3.6 `utils/input-hints.ts`：提示文案改为 `/models` 同时管模型与思考强度

## 4. acp：thought_level 选择器

- [x] 4.1 `session-config-options.ts`：`thoughtLevelConfigOption`（`category: "thought_level"`，
      取值 = 档位或 `off`），无推理证据时省略
- [x] 4.2 `session-config-options.ts`：`applyThoughtLevel`（校验档位；`off` 清空强度）+ `effortOf`
- [x] 4.3 `session-config-options.ts`：`sessionConfigOptions` 把档位项排在模型之后、模式之前
- [x] 4.4 `agent.ts`：`set_config_option` 增加 `thought_level` 分支；`advertise` 比较强度镜像
      `lastAdvertisedConfigEffort`，强度变化即重发整套选项
- [x] 4.5 `commands.ts`：删除 `/effort` 分发，新增 `/models` 分发（走 `applyModel`，
      模型切换后按新模型校验档位）；`dispatchSlashCommand` 接收模型读取
- [x] 4.6 `index.ts`：导出 `effortOf` / `THOUGHT_LEVEL_DEFAULT`（`applyThoughtLevel` 与 `applyMode` /
      `applyModel` 一样保持包内，宿主的两个写入口都走 `session-config-options`）

## 5. 校验

- [x] 5.1 `core/scripts/validate-builtin-command-arguments.mjs`：`/models` 语法用例、
      `offerableReasoningEfforts` 四态、catalog 不再含 `effort`
- [x] 5.2 `acp/scripts/validate-acp-command-args.mjs`：`/models` 的 model→effort 顺序、`off` 清空、
      未知档位不派发、`/effort` 不再派发 `effort.set`
- [x] 5.3 `acp/scripts/validate-acp-catalog.mjs`：`thought_level` 的广告/写回/清空/拒绝/
      切换到无档位模型后消失（12 条新断言），并让 fake session 记录 `effort.set` 与 `modelInfo`
- [x] 5.4 `app/test/nested-command-menu.test.mjs`：下钻、逐层回退、叶子执行、空子层、
      越过层级关闭菜单、`/effort` 已移除
- [x] 5.5 `app/test/settings-command.test.mjs` / `input-hints.test.mjs`：菜单行与提示文案
- [x] 5.6 变异验证：去掉 `reasoning` 门 / 让 `off` 写进会话 / 不校验档位 / 空档位仍广告 —— 均被断言抓住
- [x] 5.7 `pnpm typecheck` / `pnpm lint` / `pnpm --filter @codent/app test` / ACP 三套 validator 全绿

## 6. 审查后修复（交叉审查发现的问题）

- [x] 6.1 异步层竞态：层加载加 `loadToken`，退退/关闭后到达的行被丢弃（否则 `slice(0, -1)` 会
      覆写父层，并让 `levels.length` 与 `optionPath.length` 不同步）
- [x] 6.2 异步子层答空时按叶子处理：关闭层级并保留输入里的路径（退回父层会让输入仍指着更深的路径，
      父层首行被当成选中项，实际执行到错误的行；无档位模型因此永远选不上 —— 见 7.1）
- [x] 6.3 `ManagedAgent.setModel` 丢弃新模型不支持的显式强度（严格规则 `offerableReasoningEfforts`；
      `supportedReasoningEfforts` 的回落全集语义不适合判定“清空”）
- [x] 6.4 `encodeModelChoice` / `decodeModelChoice` 收进 core，app / ACP / parser 不再各写一份
- [x] 6.5 ACP 斜杠命令路径补发 `config_option_update`（否则 `/models` 后客户端选择器停在旧值）
- [x] 6.6 `applyThoughtLevel` 改用与 `/models` 一致的宽松校验规则（同一操作不得给出两个结果）
- [x] 6.7 不再为测试而扩大公开面：探针命令改走 `registerExtensionCommand` 注册，`registerCommand`
      不对外导出
- [x] 6.8 `use-autocomplete.ts` 超 400 行：层加载拆到 `hooks/option-levels.ts`（329 + 150）
- [x] 6.9 `validate-acp-catalog.mjs` 的 `max-lines` 免责声明补上理由（原注释只解释 2026-10 那次拆分）
- [x] 6.10 变异验证新增三条：去掉 `loadToken` 守卫 / 去掉异步空层回退 / 去掉换模型清强度
- [x] 6.11 `session-host-api` 的过期 `/effort` 引用以 delta 修正（不直接改主 spec）

## 7. 交付前复核修复（独立复核发现）

- [x] 7.1 `/models` 选中「无思考档位」的模型永远无法生效：档位解析器是异步的，答空后原实现退回父层，
      而 accept 已经把 `/models <path>` 写进输入。结果是父层首行被高亮、输入却仍指着那颗模型，
      再按 Enter 要么重开空层、要么执行到别的行。改为「空层 = 叶子」：关闭菜单，输入保留该行的完整路径，
      下一次 Enter 正常执行。`nested-command-menu` 的用例与注释同步改写。
- [x] 7.2 ACP `/models <裸模型 id>` 被 `applyModel` 拒绝（它只接受等于当前模型的裸值，用于「当前模型不在目录里」）：
      派发前先按 `read.entries` 解析成 `"<entryIndex>:<model>"`，与 TUI 一致。
- [x] 7.3 自由输入行只属于**根层**：`allowCustomInput` 描述的是命令的顶层参数，子层（档位）是闭集，
      注入 "type custom…" 会给出该层没有定义的值；`applyOptionsToState` 按 `optionPath.length === 0` 判定。
- [x] 7.4 `/models` 的档位写入改走 `applyThoughtLevel`（与 `thought_level` 选择器同一实现），
      不再复制「校验 + effort.set」两份；`off` 的清空语义也只在一处。
- [x] 7.5 编解码统一使用 core 的 `encodeModelChoice`（ACP 里不再手写 `"<i>:<m>"`）。
- [x] 7.6 同步 `effort` 残留注释 / 扩展命令保留名列表（`/effort` 已不是内置命令）。
- [x] 7.7 门禁：`validate-acp-command-args` 增加裸 id 用例（变异：去掉解析 → 失败）；
      `nested-command-menu` 增加「空异层按叶子」「子层无自由输入行」用例。
- [x] 7.8 层级前缀比较改为大小写无关（输入统一小写、选项值保留原拼写）。否则 `Qwen/Qwen3` 这类含大写的
      模型 id 一进入档位层就被判定为「输入已越过该层」而关闭菜单 —— 用例 13 覆盖，变异可捕获。
- [x] 7.9 层解析器的 Promise 增加 rejection 兜底（不产生 unhandled rejection）：解析失败时保留乐观层，
      输入里仍是该行的完整路径，Enter 按叶子执行。
