## 1. core：能力与纯函数（无 UI 行为）

- [x] 1.1 `packages/core/src/env/index.ts`：新增可选 `imageToText?(buffer, { maxCols, maxRows, color })`
  声明，JSDoc 说明「返回终端文本行（仅 SGR）/ `null` = 解不了或无解码器 / 缺失即不支持」，
  并把 `imageToText` 一并列入文件头「可选能力」注释块。
- [x] 1.2 新增 `packages/core/src/utils/image-text.ts`：`renderRgbaAsTerminalText(image, options)`
  —— 最近邻采样到 `maxCols × maxRows*2`、等比信箱（透明补白不画背景）、半块 `▀` 合成、
  逐行 `ESC[0m` 收尾；`color:false` 走 ASCII 梯度。纯函数，无 env / fs / sharp 引用。
- [x] 1.3 `packages/core/scripts/validate-image-text.mjs`（新增 `validate:image-text`）：
  半块上下配对、等比不拉伸、可见宽度 ≤ `maxCols`、行数 ≤ `maxRows`、ASCII 路径无 SGR、
  透明像素不产生背景色、`0×0` / `1×1` 不抛。依赖 1.2。

## 2. node：sharp 解码实现

- [x] 2.1 `packages/node/src/index.ts`：实现 `imageToText` —— `sharp(buffer).resize({ width: maxCols,
  height: maxRows*2, fit: "inside" }).raw().ensureAlpha()` → core 的纯函数；失败/缺 sharp 返回 `null`，
  按 `resizeImage` 的「只告警一次」模式记录原因。依赖 1.1、1.2。
- [x] 2.2 `packages/node/scripts/validate-image-to-text.mjs`（新增 `validate:image-to-text`）：
  内联一张小 PNG，断言返回非空且行数 ≤ `maxRows`；断言 `color:false` 输出无 `ESC[`；断言坏字节
  返回 `null` 而不抛。依赖 2.1。

## 3. 远程平面

- [x] 3.1 `packages/server`：新增 `POST /api/image/text`（body：base64 + `maxCols` / `maxRows` / `color`，
  返回 `{ rows }`），服务端 env 没有该能力时返回 `{ rows: null }`（不报错）。
- [x] 3.2 `packages/server/src/client.ts`：`createRemoteEnv` 实现 `imageToText`，`null` 原样透传。
  依赖 3.1。
- [x] 3.3 校验：服务端 env 无该能力时返回 `null` 分支的断言（并入既有 server 校验脚本，不新开脚本）。

## 4. app：工作区面板预览

- [x] 4.1 `packages/app/src/utils/file-icons.ts`：新增 `isImagePath(path)`（png/jpg/jpeg/gif/webp），
  与 `BINARY_EXTENSIONS` 并存，供面板判定是否尝试预览。
- [x] 4.2 新增 `packages/app/src/utils/image-preview-cache.ts`：LRU(32)、键含
  `(path, size, mtimeMs, maxCols, maxRows, color)`、`clearImagePreviewCache()`（并入面板既有的
  `clearContentCache` 调用点）。
- [x] 4.3 `packages/app/src/components/FileContent.tsx`：`isImagePath` + `env.imageToText` 同时成立时
  走图片分支 —— `fs.stat` → `fs.readFile(path, "buffer")` →（超 `PREVIEW_INPUT_LIMIT` 先
  `env.resizeImage`）→ `env.imageToText`；标题行显示文件名与体积；渲染每行 `<Text wrap="truncate-end">`，
  渲染前过 `sanitizeAnsi`；行列为空/`null`/无能力 → 退回原二进制提示。依赖 4.1、4.2、2.1。
- [x] 4.4 预算：`maxCols = min(96, width - 2)`、`maxRows = min(32, height - 2)`，不足时取面板实测值；
  确认窄栏不溢出、不换行。依赖 4.3。
- [x] 4.5 `packages/app/test/image-preview-cache.test.mjs`：LRU 命中/淘汰、`null` 也缓存、
  键随 size/mtime 变化。依赖 4.2。

## 5. 文档与整体验证

- [x] 5.1 `AGENTS.md`：CoreEnv 可选能力清单加 `imageToText`（与 `resizeImage` 并列，注明「缺失即降级」）。
- [x] 5.2 `pnpm build && pnpm typecheck && pnpm lint`，`pnpm --filter @codent/app test`。
- [x] 5.3 本地手工/`validate:render-smoke`：面板选中 png 显示预览；agent 会话图片仍是 chip。
- [x] 5.4 `openspec validate add-terminal-image-preview --strict`。

## 6. 清晰度：用满面板 + 轻度锐化

- [x] 6.1 `FileContent` 的 `previewBudget`：去掉 96×32 的人为上限，改用面板实测宽高（`width - 2` / `height - 1`）。
- [x] 6.2 `packages/node/src/index.ts`：降采样后 `.sharpen({ sigma: PREVIEW_SHARPEN_SIGMA, m1: 1, m2: 1.5 })`，
  常量带注释说明实测依据；断言行列数不受影响。
- [x] 6.3 `validate:image-to-text` 补一条：同一张图锐化前后行列数一致。

## 7. 缩放/平移与独立组件

- [x] 7.1 core `CoreEnv.imageToText`：`options.region`（源像素矩形）+ 返回
  `{ rows, imageWidth, imageHeight, region }`；`CoreEnvImageToTextOptions` / `CoreEnvImageTextResult`。
- [x] 7.2 node：`rotate()` 纠正方向后取尺寸，`extract(region)` → `resize(inside, withoutEnlargement: !region)`，
  回报夹紧后的 region；越界矩形夹紧而不是报错。
- [x] 7.3 server：`POST /api/image/text` 接受可选 `region`，返回整个结果对象；client 透传。
- [x] 7.4 app：`image-preview-cache` 接受 `region` 并把它的整数化值算进缓存键，返回值改为结果对象。
- [x] 7.5 新增 `packages/app/src/components/WorkspaceImagePreview.tsx`：自己持有加载/错误状态、
  缩放平移窗口计算（按面板宽高比裁切、夹紧）、标题行（文件名 + `×N` + 键位提示）与行渲染；
  渲染前过 `sanitizeAnsi`。
- [x] 7.6 `FileContent`：图片分支改为渲染 `WorkspaceImagePreview`，自己不再持有图片渲染细节。
- [x] 7.7 `use-workspace-panel`：新增 `imageZoom` / `imagePanX` / `imagePanY` 与
  `zoomImage(delta)` / `panImage(dx, dy)` / `resetImageView()`，`selectFile` 时重置。
- [x] 7.8 `WorkspaceFileMode`：预览栏聚焦且当前文件是图片时，`+` / `-` 缩放、`0` 重置、
  放大（>1）时方向键平移；缩放为 1 时保持原有滚动行为。
- [x] 7.9 校验：node 验证脚本补 region（只渲染窗口、上采样、夹紧）；server 验证脚本补一次
  region 往返；app `image-preview-cache.test.mjs` 补 region 进缓存键。
- [x] 7.10 `pnpm build && pnpm typecheck && pnpm lint`、`@codent/app test`、三个 validate、
  `validate:render-smoke`、`openspec validate --strict`。

## 8. 平移速度随缩放自适应

- [x] 8.1 `utils/image-viewport.ts`：`imagePanStep()`（按可视窗口比例算归一化步长）+ `IMAGE_PAN_VIEWPORT_FRACTION`。
- [x] 8.2 `use-workspace-panel`：新增 `imageGeometry` / `setImageGeometry`；`panImage` 改收方向，
  用几何算步长；切换文件/开关面板时清空几何。
- [x] 8.3 `WorkspaceImagePreview` 在拿到结果时发布几何；`WorkspaceFileMode` 改为传方向。
- [x] 8.4 `image-viewport.test.mjs`：断言每次按键在屏幕上移动的格子数与缩放倍数无关（约 `maxCols × 10%`），
  且步长不超过整个可平移范围。

## 9. 审查后的更正

- [x] 9.1 去掉预览输入上的 `resizeImage` 预压缩（源尺寸/EXIF 一致性），缓存测试改为断言不压缩 + 尺寸为源尺寸。
- [x] 9.2 `WorkspaceImagePreview` 的 state 带 `path`：切图不再显示上一张的 rows，也不再用旧尺寸算窗口（render-smoke 覆盖，已验证能抓住旧行为）。
- [x] 9.3 server 路由与客户端按 `[1, 200]` 钳制而非 400；`createRemoteEnv.imageToText` 失败降级为 `null`（validator 已从"应 400"改为"应钳制"，并补传输失败断言）。
- [x] 9.4 node `clampImageRegion` 对非有限原点归零；整图路径不再 `extract`（保留 JPEG shrink-on-load）；补 EXIF orientation 6 与垃圾窗口的断言。
- [x] 9.5 缓存代际计数（清空后不被在飞结果写回）、窗口先取整再发送、平移 80ms 合并、`open()` 重置几何、`imagePreviewBudget` 上限收到 200。
- [x] 9.6 `validate:image-text` 加 `pnpm run build &&`（与同目录其它 validate 脚本一致）。
