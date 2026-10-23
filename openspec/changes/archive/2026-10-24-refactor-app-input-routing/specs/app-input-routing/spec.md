## Purpose

每一次按键在 app 里只能有一个归属：屏幕用 `InputScope` 声明自己是哪一类 surface，四个 `use*Input` hook 只在该 surface 的 scope 内订阅，`when` 决定 surface 内部哪一个子面拥有它。这样面板与聊天不可能同时对同一个键作出反应，"需要记得提前 return"的那类约定连同它的 300ms 去抖补丁一起消失。

## ADDED Requirements

### Requirement: 一次按键只属于一个 surface

每个屏幕 SHALL 在自己的子树外包一层 `InputScope`（`main` / `workspace` / `task` / `extension`），surface hook MUST 只在
`scope.surface` 与自身声明一致且 `when !== false` 时订阅；不满足时 MUST NOT 订阅（而非订阅后空转）。

`useInput` 的隔离只有 `isActive` 一种手段：`isActive === false` 时渲染器根本不注册监听器，也没有 `stopPropagation`、
优先级或稳定的注册顺序可供依赖 —— 因此 MUST NOT 用"先注册/后注册"或 handler 内早退来模拟归属。

#### Scenario: 面板打开时聊天键位不参与

- **WHEN** 工作区面板打开，用户按 `Ctrl+U` 或 `y`
- **THEN** 只有工作区面板的 handler 被调用
- **AND** 主聊天没有被清空，也没有工具审批被应答

#### Scenario: 声明错 surface 的 handler 惰性

- **WHEN** 某个 `main` 的 handler 被写在工作区面板的 `InputScope` 内
- **THEN** 它从不订阅，按键不会到达它
- **AND** 不会因为该面板未挂载/未关闭而泄漏

#### Scenario: 每个屏幕至少有一个活动 handler

- **WHEN** 任一屏幕挂载
- **THEN** 该屏幕的 scope 内至少有一个 `when` 为真的 surface hook 在生效，raw mode 保持开启

### Requirement: 四个命名 hook 是 app 内唯一的注册途径

`packages/app/src` SHALL 只通过 `useMainInput` / `useWorkspacePanelInput` / `useTaskPanelInput` /
`useExtensionPanelInput` 注册键盘输入；原始 `useInput` MUST 仅出现在实现它们的公共原语（`useSurfaceInput`）内部。
MUST NOT 存在第五类 surface：整屏替换主界面的配置向导（`ConfigEditorOverlay`）与会话选择器（`SessionResumePicker`）
SHALL 使用 `useMainInput`，因为它们在挂载期间就是主界面本身，与聊天不会共存。

#### Scenario: 组件里出现原始 useInput

- **WHEN** 某个组件（例如面板或共享输入框）直接 `import { useInput } from "ink"`
- **THEN** 结构校验失败并指出文件路径

#### Scenario: 向导与选择器归入主界面

- **WHEN** 配置向导或会话选择器处于前台
- **THEN** 它的 handler 通过 `useMainInput` 生效
- **AND** 聊天屏幕此时未挂载，两者的键位不会互相触发

#### Scenario: 宿主直接挂载带输入的屏幕

- **WHEN** 宿主（CLI 首跑、`codent`）直接渲染 `<ConfigEditor>` 或 `<SessionPicker>`
- **THEN** 它 MUST 用 `InputScopeProvider` 包住该屏幕
- **AND** 缺失时屏幕的 handler 不订阅（按设计惰性），结构校验 MUST 报错

### Requirement: 退出键不属于任何 surface

进程退出（`Ctrl+C`）SHALL 在每一个屏幕上生效，包括三个面板、配置向导与会话选择器；它 MUST 通过
`useExitInput` 注册，且该 handler MUST 只匹配 `ctrl+c` 这一无人认领的和弦（否则会与 surface handler
同时处理同一按键）。除它之外 MUST NOT 存在不经 surface 的注册。

#### Scenario: 面板打开时仍能退出

- **WHEN** 工作区面板处于前台且用户按 `Ctrl+C`
- **THEN** 进程按正常退出路径结束
- **AND** 主界面的 handler 不因为该按键被调用

#### Scenario: 退出键只有一个处理者

- **WHEN** 聊天屏幕前台且用户按 `Ctrl+C`
- **THEN** 退出摘要只打印一次（`keybindings/global.ts` 不再处理 `ctrl+c`）

### Requirement: surface 内部用 `when` 决定子面

surface 内部的互斥 SHALL 通过 `when` 谓词表达，同一时刻 MUST 至多一个子面的 `when` 为真。
`when` 只允许读取本 surface 自己的状态（模式、`quickOpen`、子代理 `view`、向导步骤），MUST NOT 读取其它
屏幕的开关（如 `workspacePanel.view`、`extensionPanel.view`）来决定自己是否运行。具体映射见各场景。

#### Scenario: 每个 surface 的子面划分

- **WHEN** 排定某个 surface 内的 handler
- **THEN** `main` 按 `useInputMode.mode`（`normal` / `approval` / `select` / `freeform`）四选一，向导的导航 handler 与之本步的 `TextInput` 按步骤互斥
- **AND** `workspace` 按 `quickOpen` 二选一，`task` 按 `view !== "detail"` 与 `view === "detail"` 二选一，`extension` 无子面

#### Scenario: 打开面板的和弦在面板内也是关闭和弦

- **WHEN** 工作区 / 任务 / 扩展面板处于前台，用户按当初打开它的和弦（`Ctrl+E` / `Ctrl+T` / `Ctrl+Y`）
- **THEN** 面板收起（任务详情先回到列表），页脚提示与实际行为一致
- **AND** 聊天屏幕上的同名和弦只负责打开，因为该屏幕意味着三个面板都已关闭

#### Scenario: 子代理列表与详情不互相串键

- **WHEN** 子代理面板从列表进入详情
- **THEN** 只有详情 handler 生效，`x` 只作用于详情里的活动子代理
- **AND** 列表的上下选择不再收到按键

#### Scenario: 跨屏守卫被禁止

- **WHEN** 某个 handler 的 `when` 读取了另一个面板的 `view`
- **THEN** 结构校验失败

### Requirement: 输入注册跟随屏幕，状态同步不跟随

注册键盘输入的 hook SHALL 与它所属屏幕同生命周期；与之无关的状态同步 MUST 保持在屏幕之外继续运行。
`useAgentInputControls` 因此只保留屏幕无关的职责（审批与 `ask_user` 的模式切换、`setClientToolWaiting`、
加载状态、初始提示提交、命令上下文与提交处理），并把键位上下文交给只在主界面内挂载的 `ChatKeybindings`。

#### Scenario: 面板打开时到达的审批仍能切换模式

- **WHEN** 工作区面板打开期间有一个工具审批到达
- **THEN** 输入模式切换为 `approval`，审批数据进入 store
- **AND** 关闭面板后 `y` / `n` 立刻可用，无需重新触发

#### Scenario: 聊天键位不常驻

- **WHEN** 任一非主界面屏幕挂载
- **THEN** 五个模式 handler 都没有订阅
- **AND** 结构校验同时断言两件事：`useAgentKeybindings` 只在 `ChatKeybindings` 里被调用，且 `<ChatKeybindings>` 只出现在一个 `main` scope 内

### Requirement: 同一次按键不会跨屏重复处理

面板在收到按键的同一刻关闭时，该按键 MUST NOT 再被接管键盘的屏幕处理。实现 SHALL 依赖监听器在 emit 时的快照语义
（emit 期间新增的监听器不会收到本次事件），MUST NOT 依赖时间窗口去抖。

因此 `isAnyPanelOpen()` / `panelJustClosed()` / `PANEL_SURFACES` 以及各面板的 `lastClosedAt` + `CLOSE_DEBOUNCE_MS`
SHALL 被删除；残留的定义或调用 MUST 使结构校验失败。

#### Scenario: Esc 关闭面板不会同时中断运行

- **WHEN** 运行中按 `Esc` 关闭工作区面板
- **THEN** 面板关闭，且本次 `Esc` 不会触发 `stop()`

#### Scenario: 面板关闭后的下一个键进入主界面

- **WHEN** 面板关闭后用户再按 `Esc`
- **THEN** 主界面的 Esc 级联正常执行（隐藏 plan 预览 / 关闭命令输出 / 中断运行）

#### Scenario: 去抖字段不再存在

- **WHEN** 检查 `use-workspace-panel` / `use-subagent-panel` / `use-extension-panel` / `use-config-editor`
- **THEN** 它们不再导出 `CLOSE_DEBOUNCE_MS`，状态里也没有 `lastClosedAt`
