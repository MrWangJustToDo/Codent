## 1. 基线与结构校验（先红）

- [x] 1.1 盘点 `packages/app/src` 中全部 `useInput` 调用点与它们所属的 surface、子面、现有守卫（13 处：5 个 `keybindings/*` + `WorkspaceFileMode` / `WorkspaceQuickOpen` / `ExtensionPanel` / `SubagentListPanel` / `SubagentDetailPanel` / `SessionPicker` / `ConfigEditor` / `TextInput`）。
- [x] 1.2 新增 `packages/app/scripts/validate-input-routing.mjs`，断言下列结构事实（已用临时违规文件逐条验证它会失败）：
  1. `packages/app/src` 内除 `hooks/input/use-surface-input.ts` 外不得出现原始 `useInput`；
  2. 不得出现 `isAnyPanelOpen` / `panelJustClosed` / `PANEL_SURFACES` / `lastClosedAt` / `CLOSE_DEBOUNCE_MS`（注释先剥离，因为文档还在解释它们为何被删）；
  3. `useAgentKeybindings` 只允许在 `components/ChatKeybindings.tsx` 内调用；
  4. 四个命名 hook 必须以自己的 surface 字面量委托给原语；
  5. 非 `main` 的 surface 文件不得调用其它面板的 store（跨屏守卫），barrel 的 re-export 不算声明；
  6. `Agent.tsx` 必须为四个 surface 各提供 `InputScopeProvider`，且 `<ChatKeybindings>` 在 `main` scope 内。
- [x] 1.3 接入 `packages/app/package.json`（`validate:input-routing`）；`scripts/run-all-validators.mjs` 按 glob 发现，CI 的 `validate:all` 自动覆盖。

## 2. Surface 原语与 scope

- [x] 2.1 `packages/app/src/hooks/input/use-surface-input.ts`：`useSurfaceInput(surface, handler, { when })` 内部唯一一次 `useInput(handler, { isActive: isSurfaceActive(scope, surface, when) })`；激活规则抽成纯函数 `isSurfaceActive`（无 scope = 惰性）。
- [x] 2.2 `packages/app/src/context/input-scope-context.ts`：`InputSurface`、`InputScopeProvider`、`useInputScope`。
- [x] 2.3 四个命名 hook：`use-main-input.ts` / `use-workspace-panel-input.ts` / `use-task-panel-input.ts` / `use-extension-panel-input.ts` + `input/index.ts` barrel；经 `hooks/index.ts`（`export *`）导出到包入口。
- [x] 2.4 原语注释写清 `isActive` 语义（不订阅、关 raw mode）、广播事实、错声明即惰性。

## 3. 主界面 surface

- [x] 3.1 `Agent.tsx`：四个面板分支与聊天分支各包 `InputScopeProvider`；向导与 picker 的 early return 也包 `main`；屏幕选择顺序不变。
- [x] 3.2 `useAgentInputControls` 不再注册键位，改为返回 `UseAgentKeybindingsOptions`（类型导入单独一行以免循环）；新增不渲染内容的 `components/ChatKeybindings.tsx` 在 `main` scope 内调用 `useAgentKeybindings`。
- [x] 3.3 `keybindings/{global,normal,approval,select,freeform}.ts` 改用 `useMainInput`；四个模式用 `{ when: mode === "…" }`。
- [x] 3.4 `global.ts` 删除 `isAnyPanelOpen()` 早退、Esc 级联里的四个面板 store 判断与 `panelJustClosed()`；`Ctrl+E` / 原本的 toggle 改为 `open()`（main 屏意味着面板已关闭）；其余键位与级联顺序不变。
- [x] 3.5 `context.ts` 只保留 `KeybindingContext` / `DenyingToolInfo`，`PANEL_SURFACES` / `isAnyPanelOpen` / `panelJustClosed` 全部删除。

## 4. 面板 surface

- [x] 4.1 `WorkspaceFileMode.tsx`：`useWorkspacePanelInput(..., { when: !quickOpen })`，handler 内的 `if (quickOpen) return;` 删除。
- [x] 4.2 `WorkspaceQuickOpen.tsx`：`useWorkspacePanelInput`（挂载即 `quickOpen`）。
- [x] 4.3 `SubagentListPanel.tsx` / `SubagentDetailPanel.tsx`：`useTaskPanelInput` + `when: view === "list"` / `"detail"`（store 读一次）。
- [x] 4.4 `ExtensionPanel.tsx`：`useExtensionPanelInput`。

## 5. 主界面内的向导、选择器与共享输入框

- [x] 5.1 `ConfigEditor.tsx`：`useMainInput(..., { when: !isTextStep })`；文本步交给 `TextInput`。`saving` 留在 handler 内部早退（它不是子面，只是"这段时间不响应"），这样保存期间 raw mode 不会因为零订阅而被关掉。
- [x] 5.2 `TextInput.tsx`：`useMainInput(..., { when: !disabled })`。
- [x] 5.3 `SessionPicker.tsx`：`useMainInput`。
- [x] 5.4 行为保持：向导的文本步原本只有 `ConfigEditor` 处理 Esc（`TextInput` 未传 `onEscape`），现在改为 `TextInput` 收 `onEscape={onCancel}` 且向导 handler 在文本步停用 —— Esc 仍从任何步骤取消，但每一步只有一个处理者。

## 6. 删除跨屏机制

- [x] 6.1 `use-workspace-panel.ts` / `use-subagent-panel.ts` / `use-extension-panel.ts` / `use-config-editor.ts`：删除 `lastClosedAt` 字段、`CLOSE_DEBOUNCE_MS` 导出与写入点。
- [x] 6.2 全仓库复查：`packages/cli`、`packages/playground`、`packages/extension` 均未引用被删符号。
- [x] 6.3 删除 `packages/app/test/panel-keyboard.test.mjs` —— 它的两个断言对象（`isAnyPanelOpen` / `panelJustClosed`）已不存在；其保障由 `test/input-routing.test.mjs` 与 render-smoke 的 routing 段接替。

## 7. 测试与验证

- [x] 7.1 `packages/app/test/input-routing.test.mjs`：`isSurfaceActive` 的激活矩阵（无 scope 惰性、错 surface 惰性、`when` 只能收窄、同一 surface 同时至多一个子面）。
- [x] 7.2 同文件断言 emit 快照语义：emit 期间新挂载的监听器收不到当次按键。
- [x] 7.3 `scripts/render-smoke/run.mjs` 用真实原语挂 probe：workspace scope 内的按键只到 workspace handler（`main` 的惰性）、被本次按键挂载的 handler 收不到本次按键、下一次按键两个 handler 都收到（不断言顺序 —— 内联 handler 每次渲染重订阅，顺序不稳定）。原先依赖 `isAnyPanelOpen()` 的三条检查已替换；`SubagentPanel` / `SessionPicker` 的挂载补上各自 scope（否则按设计惰性）。
- [x] 7.4 全量验证：`pnpm build`、`pnpm typecheck`、`pnpm lint`、`@codent/app test`（145/145）、`validate:input-routing`、`validate:render-smoke`（132 checks）、`run-all-validators --dir packages/app`（10 passed / 1 skip）。
- [ ] 7.5 手工验收清单：聊天（四种模式）、工作区（树/预览/diff/图片缩放/quick open）、任务面板（列表/详情）、扩展面板、配置向导（含文本步）、会话选择器；每屏只响应本屏按键。

## 8. Review fixes（三份只读审查后）

- [x] 8.1 首跑向导无 scope（阻断）：`packages/cli/src/host.tsx` 的 `Bootstrap()` 用 `InputScopeProvider value="main"` 包住 `<ConfigEditor>`；`codent` 复用同一 host。
- [x] 8.2 新增 `useExitInput`（`hooks/input/use-exit-input.ts` → 原语里的 `useUnscopedInput`），`Agent` 在 early return 之前注册；`keybindings/global.ts` 删除 `ctrl+c` 分支，退出只有一个处理者。
- [x] 8.3 面板内补回关闭和弦：`WorkspaceFileMode` 的 `Ctrl+E`、`ExtensionPanel` 的 `Ctrl+Y`、`SubagentListPanel` 的 `Ctrl+T`（关闭）、`SubagentDetailPanel` 的 `Ctrl+T`（回列表）——页脚 `Ctrl+E/Esc close` 不再落空。
- [x] 8.4 `approval.ts` 的 `y` / `n` 忽略 `ctrl` / `meta`：`Ctrl+Y` 不再顺带批准待审工具。
- [x] 8.5 `SubagentListPanel` 的 `when` 改为 `view !== "detail"`，与 `SubagentPanel` 的渲染条件同构。
- [x] 8.6 修 `validate-input-routing.mjs`：`ownFile` 拼装的 `-input-input` bug（此前 4 个 hook 里 3 个的委派检查从不执行，已用变异验证修好后会报错）；scope 检查改为嵌套感知（"整棵树一个 main scope" 现在会失败）；注释剥离保留行号且不把字符串里的 `/*` 当注释；新增规则 7（宿主渲染带输入的屏幕必须自带 scope）。
- [x] 8.7 smoke 新增 4 条：面板屏上 `Ctrl+C` 生效且不进入 main handler（变异验证：把 `useUnscopedInput` 改成受 scope 门控即失败）、向导在 scope 内响应方向键（变异验证：去掉 scope 即失败）。
- [x] 8.8 复核既有断言不受影响：`use-agent-keybindings.ts` 的过期注释更新；`workspace-header-layout` / `models-config-edit` / `render-smoke` 全绿。
