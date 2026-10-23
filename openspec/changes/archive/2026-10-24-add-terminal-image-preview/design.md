# Design — 工作区面板的图片文本预览

## Context

要解决的问题是「工作区面板选中一张图片时只看到一行 `Binary file — preview not available`」。
作用域是预览面板（preview 模式），agent 会话不动。落笔前核实过的约束：

| 约束 | 证据 |
|---|---|
| 面板把图片判成二进制并拒绝预览 | `packages/app/src/components/FileContent.tsx:74`；`isLikelyBinaryPath`（`packages/app/src/utils/file-icons.ts:137`） |
| 面板是动态区域（不是 StaticRender 缓存叶） | `WorkspacePreviewPane`（`packages/app/src/components/WorkspacePreviewPane.tsx:48`）直接渲染 `FileContent`，`key={refreshToken}` 是最小失效单位 |
| 面板把可用宽度/高度作为 props 传下来 | `WorkspaceFileMode`：`previewWidth` / `paneBodyLines`（`packages/app/src/components/WorkspaceFileMode.tsx:84`） |
| 图片文件读取走 CoreEnv 二进制读 | `CoreEnvFs.readFile(path, "buffer")`（`packages/core/src/env/index.ts:110`） |
| 渲染器会解析 `<Text>` 内的 SGR，并按**可见宽度**测量 | 实测：`<Text>{"\u001b[38;2;255;0;0m██\u001b[0m"}</Text>` 渲染出 2 个 cell，输出保留 `ESC[38;2;255;0;0m` |
| 只允许 SGR 穿过边界 | `ExtensionRenderSurface.sanitizeAnsi`（`packages/app/src/components/ExtensionRenderSurface.tsx:26`） |
| Node 已有可选 sharp 与「缺失即降级」范式 | `resizeImage`（`packages/node/src/index.ts:337`，`optionalDependencies.sharp`） |
| CoreEnv 可选能力缺失即**省略成员** | `openspec/specs/core-env-identity/spec.md`「能力缺失即省略成员或委托回退」 |
| 远程宿主是常态 | extension 只走 `createRemoteEnv`；ACP/远程会话同理 |

`ink-picture` 的字形方案（半块）可以借鉴，但它的模块解析（裸 `ink`）、光标协议（绝对定位贴图）
和解码依赖（jimp）都不进来——理由见 `proposal.md`。

## Goals / Non-Goals

**Goals**

1. 面板里能看到图片内容（彩色半块），分辨率随面板尺寸自动收敛。
2. 解码能力跨环境：本地用 sharp、远程经 HTTP、浏览器宿主没有 → 退回原提示。
3. app 只渲染文本；不新增第三方运行时依赖；不写任何光标/擦屏序列。
4. agent 会话零变化。

**Non-Goals**

- 图形协议（kitty / sixel / iTerm2）。
- 会话区的图片像素预览、diff 模式的图片预览。
- 动图、缩放、点击。

## Decisions

### D1 — 解码放 CoreEnv，渲染留 app

`CoreEnv` 是运行时抽象，图片解码是平台能力（sharp / WebCodecs / 远程服务），天然属于 env；
「怎么画」属于渲染层。这样 CLI、远程会话、extension 走同一套 env 能力，浏览器宿主自动降级。

拒绝的替代方案：在 `@codent/app` 里 `import sharp` —— 会把 Node 原生 addon 拖进浏览器宿主，
且 `@codent/app` 的依赖语义是「渲染层实现细节」，不是运行环境。

### D2 — 契约返回**文本行**，不返回像素

```ts
imageToText?(
  buffer: Uint8Array,
  options: { maxCols: number; maxRows: number; color?: boolean }
): Promise<string[] | null>;
```

- 返回 `string[]`（每行一个终端行，含 SGR），app 只做 `<Text>` 渲染 —— 与「app 只渲文本」一致。
- 避免把 RGBA 网格塞过 HTTP：48×16 的半块预览是 48×32 个采样点，传文本只有几 KB，传 RGBA 更大。
- `null` 同时表示「解不了」和「宿主没这个能力」。调用方处理相同（保留原提示），因此远程 env
  不需要额外广播「服务器有没有 sharp」——这也符合 `core-env-identity` 的「falsy 返回值表示不支持」。
- 语义上与已有 `resizeImage` 并列：一个缩图给模型，一个把图变成终端文本给界面。

### D3 — 彩色走半块 `▀`，无色走 ASCII 梯度

- 半块用 foreground = 上半像素、background = 下半像素，**每 cell 2 个垂直采样点**。终端 cell 的
  像素比约 1:2（宽:高），「分辨率加倍」正好抵消 cell 拉长，等比缩放不需要额外补偿因子。
- `color: false`（`NO_COLOR` / screen reader）→ ASCII 梯度（`" .:-=+*#%@"`），单色路径不依赖真彩，
  也不会退化成一块纯色方块。
- 不用 braille：单色 2×4，彩色信息全丢，对「看文件内容」不如半块。

### D4 — 面板是动态区域：用「重挂 + 缓存」而不是签名失效

面板预览不经过 `StaticRender`，`FileContent` 由 `key={refreshToken}` 重挂（`r` 刷新）；
因此不需要像静态行那样把预览状态编进行签名。失效路径只有两条，都已存在：

- `refreshToken` 变化 → `FileContent` 重挂 → 重新读文件、重新解码；
- `clearContentCache()`（`FileContent.tsx:31`，面板关闭时调用）→ 一并清预览缓存。

缓存键用 `(path, size, mtimeMs, maxCols, maxRows, color)`：`size`/`mtimeMs` 来自 `fs.stat`，
所以「文件在外部被改过、但 refreshToken 没动」不会显示旧图；代价是每次选中文件多一次 `stat`。

### D5 — 预算按面板实测尺寸走

- `maxCols = max(8, width - 2)`，`maxRows = max(4, height - 1)`（标题行 + 边距）。**不再叠加 96×32 这类
  低于面板的人为上限** —— 那个上限只在宽/高终端上生效，作用是把可用空间白白压掉一截。采样网格的
  安全上限属于宿主（`imageToText` 夹到 200）。
- 面板已有滚动（`CodeView`）但那属于文本；图片预览按**正好放得下**渲染，MUST NOT 触发滚动，
  也 MUST NOT 换行（每行一个 `<Text wrap="truncate-end">`）。
- 等比：由解码侧的 `fit: "inside"` + 纯函数的信箱补白共同保证，不拉伸。

### D9 — 清晰度：轻度锐化，而不是加格子

半块字符的像素密度是 **1×2 格**：一个 130 列的面板也只有 260 个水平采样点，对 2172px 的截图就是 8 倍
降采样。所以清晰度的预算花在两件真实有用的事上，而不是拍脑袋调参数：

1. **把面板用满**（D5），宽终端能多拿 30–50% 的格子；
2. **降采样后做一次轻度 unsharp**（`sigma ≈ 0.7`）。实测同一张 2172×1282 截图降到 77×45：边缘对比从
   7.44 升到 12.80（+72%），而行列数完全不变；默认 `sigma 1` 能到 15.94，但光晕开始可见，所以取轻
   的那一档。

**没有采用线性光（gamma）平均**：降采样实际发生在 sharp（lanczos3，已是高质量核），到了纯函数那一步
输入与输出网格基本 1:1，再做 gamma 转换只是多一次遍历；要真生效得把整张图在 JS 里转成线性光，与
D8 的体积控制冲突。锐化直接作用在降采样的输出上，性价比高得多。

### D10 — 缩放/平移：把窗口下推到解码侧

“看清细节”在文字协议里只能靠**看更小的区域**，不是靠更高的整体分辨率。两个必须满足的约束：

- 不能把放大后的整图传上来再在客户端裁剪：96×32 的 8 倍网格是 768×512 个采样点（几十万格、MB 级
  ANSI），跨 HTTP 不可接受；
- 客户端不知道图片的像素尺寸，算不出“取哪一块”。

所以契约上加两个东西（`CoreEnvImageToTextOptions.region` + 返回值的 `imageWidth/imageHeight/region`）：
客户端传源像素矩形，宿主只解码那一个窗口并缩放到单元格网格。这样每帧的负载恒定（就是一个
文本屏的大小），而放大倍率只影响 `region` 的边长。窗口矩形在放大时按预览栏的单元格宽高比裁切
（填满而不是留黑边），并被夹紧到图片边界；宿主回报夹紧后的矩形，客户端直接采用，不在两边各写
一份 clamp。

键位：`+` / `-` 缩放（1..`MAX_IMAGE_ZOOM`）、`0` 回到整图、放大时方向键平移；缩放为 1 时方向键仍是
原有的滚动语义（不占用既有交互）。状态放在 `useWorkspacePanel`（已持有 `selectedPath` / `paneFocus`），
因为按键在 `WorkspaceFileMode`、渲染在新组件里，只有 store 能同时被两边看到；切换文件时重置。

**平移速度按可视窗口算，不按可平移范围算。** 第一版把 pan 当成 [0,1] 的位置、每次加固定 0.15，
问题在放大后才暴露：可平移范围是 `图片 - 窗口`，窗口越小范围越大，于是同一个 0.15 在 2 倍时约等于
25 格、8 倍时超过一整屏（128 列）。改成「一次按键 = 可视窗口的 10%」后，移动的源像素换成格子恒为
`maxCols × 0.1`，与缩放无关；换成归一化步长则随放大变小（2 倍约 0.075，8 倍约 0.012）。

这需要 store 知道几何：图片尺寸来自一次渲染，面板格子数来自布局，两边都不在 store 里。所以由组件在
拿到结果时发布 `imageGeometry`，`panImage(direction)` 只收**方向**、由 store 用
`imagePanStep` 算出步长 —— 键位处理里不出现任何几何，也就不会出现第二份不一致的算法。

### D12 — 审查后的四处更正

一次针对性审查（core/node/server 与 app 各一遍）暴露了四个"实现与契约不一致"，都已修并补了断言：

- **不再用 `env.resizeImage` 预压缩预览输入。** 宿主回报的 `imageWidth/imageHeight` 是它拿到的那份字节的
  尺寸，压到 512 宽之后，所有缩放窗口就在错误的坐标系里算（2172px 的截图被当成 512 → 2× 时裁出
  250px 的画框贴到原图上）；而且 `resizeImage` 不做 EXIF 旋转，适配视图与放大视图会朝向不一致。
  代价是超大图按原样读取一次。
- **预览状态按文件区分。** 之前 `ready` 状态跨文件保留：切图后新文件名配旧图，且此时按缩放会用旧图尺寸
  算窗口。现在 state 带 `path`，不匹配就显示 loading。
- **远程路由钳制而不是拒绝。** `maxCols > 200` 原本被 zod 400 掉，而本地宿主是钳制 —— 终端宽于约 313 列时
  同一张图会在一个 plane 正常、另一个 plane 变 "Cannot preview"。路由与客户端现在都按 `[1, 200]` 钳制
  （测试也从"应 400"改成"应钳制"）。`createRemoteEnv.imageToText` 同时补上了 catch：任何传输/校验失败
  都降级为 `null`，与本地宿主一致。
- **窗口的 NaN 不再变成"无法预览"。** `Math.floor(NaN)` 仍是 NaN，sharp 的 `extract` 直接抛，于是
  "夹紧"变成了整图 `null`。`clampImageOrigin` 把非有限值归零。

另外顺手修的三处：`clearImagePreviewCache` 用代际计数丢弃清空后落地的结果（不再"复活"条目）；发给宿主的
窗口先取整（与缓存键一致）；平移到新窗口时 80ms 合并（按住方向键不再每个重复键都整文件读 + 解码）。

**没有改的两处**：标题行的 `borderBottom` 实测不占行（`maxRows = height - 1` 是对的）；EXIF
`metadata().autoOrient` 与 `.rotate()` 实测一致（orientation 6：40×20 → 20×40），区域坐标不会错位。

### D11 — 预览是一个独立组件

`WorkspaceImagePreview` 自己拥有：加载/错误状态、缩放平移窗口的计算、标题行（文件名 + 缩放指示 + 键位
提示）与行渲染。`FileContent` 只保留“这是不是图片 / 有没有解码能力 / 降级提示”这个判断，不再持有
图片的渲染细节 —— 否则它就会同时长成文本预览和图片预览两个东西。

### D6 — 缓存与失败也有界

- 键 `(path, size, mtimeMs, maxCols, maxRows, color)`；值 `string[] | null`。
- `null` 也缓存（解不了的文件不该每次窗口重绘都重试 sharp）。
- LRU 上限 32 条（一张图 48×16 行文本约几 KB，32 条上限足够覆盖在文件树里上下翻看）。
- 不落盘：预览是派生物，`.agents/` 里多一类缓存文件不抵它的失效问题。

### D7 — 边界安全：远端 env 返回的文本也要过一遍 sanitizer

`imageToText` 的返回可能跨进程边界（远程 env），等于「对端给我们一段会写进终端的字符串」。
app 在渲染前复用 `sanitizeAnsi`（只保留 SGR），把「错误或恶意的 env 返回光标序列」变成不可能。
这不是重复防御：`ExtensionRenderSurface` 的注释已经定下「SGR 是唯一被允许穿过宿主边界的序列族」。

### D8 — 解码前的体积控制

大文件（例如 20 MB 的 PNG）不该整个进 sharp，也不该整个过 HTTP：

```
fs.readFile(path, "buffer")
  → bytes.length > PREVIEW_INPUT_LIMIT (2 MB) ? env.resizeImage(bytes, { maxWidth: 512 }) : bytes
  → env.imageToText(bytes, { maxCols, maxRows, color })
```

`resizeImage` 的语义就是「缩到能吃的尺寸」，这里先把成本压下来再解码；缩完仍解不了就返回 `null`。
另外面板只用扩展名白名单触发（png / jpg / jpeg / gif / webp），不去猜未知二进制。

## Risks

| 风险 | 缓解 |
|---|---|
| 面板每次切换文件都 `stat` + 解码，快速上下翻看有延迟 | 预览行数/列数本就小，解码是毫秒级；`null` 与结果都缓存，重复选中零成本 |
| sharp 缺失（无预编译包的平台） | `imageToText` 返回 `null`，像 `resizeImage` 一样只告警一次；面板退回原提示 |
| 远程平面为一张预览传大文件 | D8 的 `PREVIEW_INPUT_LIMIT` + 先 `resizeImage`；远程面板本来就按需读文件 |
| 终端色彩能力不足时预览变脏 | `NO_COLOR` / 无色走 ASCII 梯度；不做 256 色近似（半块靠真彩才有意义） |
| 大尺寸 PNG 解压炸弹 | 沿用 `read-file-tool` 的教训：解码前声明尺寸上限交给 sharp（`limitInputPixels` 默认即有界），失败返回 `null` |

## Validation

- `pnpm --filter @codent/core run validate:image-text` —— 纯函数：半块配对、等比信箱、每行 ANSI 收尾、
  可见宽度 ≤ `maxCols`、ASCII 路径无 SGR、透明像素、1×1 / 0×0 边界。
- `pnpm --filter @codent/node run validate:image-to-text` —— 内联 PNG 断言返回非空行且尺寸受限；
  坏字节返回 `null` 不抛；`color:false` 无 `ESC[`。
- `packages/app/test/image-preview-cache.test.mjs` —— LRU 命中/淘汰、`null` 也缓存、
  键包含 `size`/`mtime`（改文件后不复用旧图）。
- `pnpm --filter @codent/app run validate:render-smoke` —— 本地跑（CI 不跑），确认图片文件不再走
  「Cannot preview」分支。
- 全量：`pnpm build && pnpm typecheck && pnpm lint && pnpm --filter @codent/app test`。
