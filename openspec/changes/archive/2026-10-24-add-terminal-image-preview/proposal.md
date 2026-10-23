# Change: add-terminal-image-preview

## Why

工作区面板的文件预览把图片当成二进制文件，只显示一行
`Binary file — preview not available in workspace.`
（`packages/app/src/components/FileContent.tsx:74`，判定来自 `utils/file-icons.ts:137` 的
`BINARY_EXTENSIONS`）。也就是说：面板里选中一张图，什么都看不到。

**作用域只到工作区面板的预览面板**（`WorkspaceFileMode` → `WorkspacePreviewPane` → `FileContent`）。
agent 会话里的图片 chip（`[Image #1] (240KB)`）保持现状——会话是滚动日志，图片像素在长会话里
既是行预算负担，也不是读日志时需要的信息。

评估过 `ink-picture`（endernoke/ink-picture v2.1.0）。它能用，但三点与我们这套栈冲突：

1. **裸 `ink` 导入**：包内部 `import { Box, Text, useStdout } from "ink"`。仓库禁止 `ink` / `react`
   这两个裸名进入发布图（`packages/app/tsdown.shared.ts:45` 的 `RENDERER_SPECIFIERS` 记录了
   npm 不会把 alias 与真名去重 → 两个物理渲染器 → 两个 hook dispatcher → TUI 白屏）。
2. **图形协议要抢光标**：kitty / sixel / iTerm2 靠「算绝对单元格坐标 + 直接写 escape 到 stdout +
   React Profiler 每帧重绘」贴图，而我们整个应用跑在自带屏幕模型的 worker 渲染器上；面板又是
   分栏布局，图像一旦参与滚动就必须由渲染器知道它的行范围。
3. **解码依赖**：它自带 `jimp` + `node-fetch`；CoreEnv 侧已经有 `resizeImage`（sharp，optional，
   缺失即降级），再引一套解码器没有收益。

所以本变更只取它的**文本协议**思路（半块字符），并把解码放在 CoreEnv、把渲染留在 app：

- 文本协议是普通字符单元，跟 `Text` 一样参与分栏、裁剪与滚动，不写任何光标控制序列；
- 解码能力放在 env 侧，浏览器宿主（extension / playground）没有该能力时退回今天的提示，
  不会破坏跨环境能力；
- 不新增第三方依赖：node 宿主复用已有的 `sharp`（optional）。

## What Changes

- **CoreEnv 新增可选能力** `imageToText(buffer, { maxCols, maxRows, color })`
  → `string[] | null`：返回若干行终端文本（半块字符 + 24 位 SGR 前景/背景；`color:false` 时走
  灰度 ASCII 梯度）。`null` 表示「解不了」或「宿主没有解码器」，调用方处理相同（保留原提示）。
  缺失时成员**不存在**（不是存在但抛错），符合 `core-env-identity` 的降级规则。
- **core 提供纯函数** `renderRgbaAsTerminalText(image, options)`：采样 → 等比信箱（letterbox）→
  半块合成 → 逐行 ANSI 收尾。解码与缩放留在宿主（sharp），像素到文本这一步是纯函数，可被
  `validate:*` 直接断言。
- **node 宿主**用 `sharp(buffer).raw().ensureAlpha()` 解码，再调用 core 的纯函数；sharp 缺失/解码失败
  时返回 `null`，并按 `resizeImage` 已有的「只告警一次」模式记录降级原因。
- **工作区面板**：`FileContent` 在预览模式下识别图片扩展名（png / jpg / jpeg / gif / webp），有
  `env.imageToText` 时把「Cannot preview · Binary file」换成图片预览块（文件名与尺寸仍在标题行）；
  解码结果按 `(路径, 尺寸, mtime, 色彩)` 缓存，跟随面板既有的 `refreshToken` 失效。
- **预算**：预览的行数/列数由面板实际宽高决定（`width` / `height` 入参，最多留一行标题），
  宽度不足或高度不足时等比缩小，MUST NOT 溢出面板或产生水平换行。
- **远程平面**：`POST /api/image/text` + `createRemoteEnv` 实现。远程宿主（extension 恒为远程）
  因此同样能预览；服务端没有解码器时返回 `null`，界面退回原提示。
- **降级矩阵**：没有该能力、`NO_COLOR`、screen reader 模式、解码失败、diff 模式、非图片扩展名
  → 行为与今天一致。

## Impact

- 受影响 capability：新增 `terminal-image-preview`（复用 `core-env-identity` 的可选能力省略规则，
  不改其契约）
- 受影响代码：
  - `packages/core/src/env/index.ts` — `imageToText?` 能力声明
  - 新增 `packages/core/src/utils/image-text.ts` — 纯函数（采样/半块/ANSI）
  - `packages/node/src/index.ts` — sharp 解码实现 + 一次性降级告警
  - `packages/server/src/routes/*` + `packages/server/src/client.ts` — 远程路由与客户端实现
  - `packages/app/src/components/FileContent.tsx` — 图片预览分支与缓存
  - `packages/app/src/utils/file-icons.ts` — 图片扩展名判定（`isImagePath`）
  - `AGENTS.md` — CoreEnv 可选能力清单
- 新增校验：`validate:image-text`（core）、`validate:image-to-text`（node）、
  `packages/app/test/image-preview-cache.test.mjs`
- 会话与消息渲染不变：agent transcript 的图片 chip、会话持久化格式都保持现状。

## 非目标

- **agent 会话里的图片显示**（保持 chip）。
- diff 模式下的图片预览（二进制在 diff 里没有内容可看，维持现状）。
- kitty / sixel / iTerm2 图形协议（要改渲染层的帧与坐标模型，另立变更）。
- GIF 动图（只渲染首帧）、缩放交互、点击查看大图。
- 不引入 `ink-picture` / `jimp` 依赖。
