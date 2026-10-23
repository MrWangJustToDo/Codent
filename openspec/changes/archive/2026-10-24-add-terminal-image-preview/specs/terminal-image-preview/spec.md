## Purpose

工作区面板只能画文本，所以图片文件在预览栏里由宿主的解码器降为半块字符再渲染。这个能力固定三件事：`CoreEnv` 上的可选 `imageToText` 契约（含缩放窗口与源尺寸回报）、预览栏的尺寸/缩放/平移行为，以及远端实现必须遵守的净化与降级规则。它的作用域只有工作区面板的 preview 模式。

## ADDED Requirements

### Requirement: CoreEnv 可选的图片转终端文本能力

`CoreEnv` SHALL 提供可选成员 `imageToText(buffer, options)`，把图片缓冲区渲染为最多 `maxRows` 行文本，
每行可见宽度 MUST ≤ `maxCols`，且只包含文字字符与 SGR 颜色（`ESC[…m`）。无法解码、或宿主缺少解码器时
SHALL 返回 `null` 而不是抛错；完全没有该能力的宿主 MUST 省略该成员。

#### Scenario: 有解码能力的宿主返回文本行

- **WHEN** 一个实现了 `imageToText` 的 Node 宿主收到一段合法 PNG
- **AND** 调用 `imageToText(bytes, { maxCols: 48, maxRows: 16, color: true })`
- **THEN** `rows` 的行数 ≤ 16，每行可见宽度 ≤ 48
- **AND** 每行只由文字字符与 `ESC[…m` 组成，没有光标移动、擦屏或 OSC

#### Scenario: 无色模式不产生 SGR

- **WHEN** 以 `color: false` 调用
- **THEN** 返回的每一行 MUST NOT 包含 `ESC[`

#### Scenario: 解不了时返回 null 而不是抛错

- **WHEN** 传入不是图片的字节，或宿主缺少解码器（无 sharp）
- **THEN** 调用 SHALL 返回 `null`
- **AND** MUST NOT 抛出异常

#### Scenario: 能力缺失的宿主省略该成员

- **WHEN** 宿主（例如浏览器 / WebContainer）没有图片解码器
- **THEN** `env.imageToText` 在 env 上不存在
- **AND** 界面按「没有预览能力」降级

### Requirement: 渲染窗口与几何回报

`options.region` SHALL 选择要渲染的源像素矩形（缺省 = 整图）。宿主 MUST 在解释该矩形之前完成 EXIF 方向
纠正，并把越界矩形夹紧而不是报错。返回结果 MUST 带 `imageWidth` / `imageHeight`（纠正后的源尺寸）与
`region`（实际渲染的矩形）——缩放/平移的调用方没有别的依据。

#### Scenario: 缺省渲染整图并回报尺寸

- **WHEN** 对一张 2172×1282 的截图调用且不传 `region`
- **THEN** `imageWidth` / `imageHeight` 为 2172 / 1282
- **AND** `region` 为 `{ x: 0, y: 0, width: 2172, height: 1282 }`

#### Scenario: 只渲染指定窗口

- **WHEN** 以 `region: { x: 400, y: 200, width: 300, height: 200 }` 调用
- **THEN** 渲染的像素只来自该矩形
- **AND** 矩形小于单元格网格时允许上采样（缩放的目的就是看清细节）
- **AND** `region` 回报该矩形

#### Scenario: 越界窗口被夹紧

- **WHEN** 传入的矩形超出图片边界
- **THEN** 结果仍然渲染成功
- **AND** `region` 回报夹紧后的矩形

### Requirement: 预览在面板内可缩放与平移

当工作区面板的预览栏聚焦且当前文件是可预览的图片时，宿主 SHALL 提供缩放与平移：
`+` / `-` 改变缩放倍数（1 倍 = 整图适配，上限 `MAX_IMAGE_ZOOM`），方向键在放大状态下平移可视窗口，
`0` 回到整图。缩放为 1 时方向键 MUST 保持变更前的行为（滚动预览）。

放大后的窗口 SHALL 与预览栏的单元格宽高比一致（填满而不是留黑边），并 MUST 被夹紧在图片边界内。
缩放与平移状态在切换文件时 SHALL 重置。

一次平移按键移动的距离 MUST 按**可视窗口**的比例计算，而不是按「剩余可平移范围」的固定比例：
屏幕上每次按键移动的格子数 SHALL 与缩放倍数无关（可平移范围会随放大而变大、窗口随之变小，
按范围取固定比例会让放大后的每一次按键跳过整屏）。

#### Scenario: 放大后能看到细节
- **WHEN** 预览栏选中一张 2172×1282 的截图
- **AND** 用户按 `+` 两次
- **THEN** 请求的 `region` 缩小到原图的约 1/4 边长
- **AND** 渲染结果填满预览栏，而不是留下空白边

#### Scenario: 平移速度不随放大变快

- **WHEN** 同一张图分别在 2 倍与 8 倍下按一次方向键
- **THEN** 两次在屏幕上移动的格子数基本相同（约占预览栏宽度的 10%）
- **AND** 8 倍下不会一次跳过整个可视窗口

#### Scenario: 平移只在放大时接管方向键
- **WHEN** 当前缩放为 1
- **THEN** 方向键仍滚动预览（不变更前行为一致）
- **WHEN** 当前缩放 > 1
- **THEN** 方向键平移窗口，且不会把窗口移出图片边界

#### Scenario: 切换文件重置视图
- **WHEN** 用户在放大状态下选中另一个文件
- **THEN** 缩放与平移回到初始值


### Requirement: 图片预览只作用于工作区面板的预览模式

工作区面板的文件预览 SHALL 在选中图片文件（`png` / `jpg` / `jpeg` / `gif` / `webp`）且宿主提供
`imageToText` 时渲染图片预览块，MUST NOT 再显示「binary file / cannot preview」。
agent 会话中的图片展示 MUST 保持变更前的行为（chip），MUST NOT 因为本能力而改变；
diff 模式 MUST 保持现状。

#### Scenario: 面板选中图片
- **WHEN** 工作区面板处于 preview 模式且选中 `assets/logo.png`
- **AND** `env.imageToText` 存在
- **THEN** 预览面板显示图片文本预览（标题行保留文件名）
- **AND** 不出现「Cannot preview · Binary file」提示

#### Scenario: 会话里的图片保持不变
- **WHEN** 一条用户消息带一张粘贴的图片
- **THEN** transcript 仍渲染 `[Image #n]` chip 与体积
- **AND** 不渲染像素预览

#### Scenario: 没有能力的宿主保持原提示
- **WHEN** `env.imageToText` 不存在（浏览器宿主）
- **THEN** 选中图片文件仍显示原来的二进制提示
- **AND** 其它文件预览不受影响

#### Scenario: 非图片二进制不变
- **WHEN** 选中 `.zip` / `.pdf` / `.woff2`
- **THEN** 仍显示二进制提示，不尝试解码

### Requirement: 预览尺寸受面板约束

预览的行数/列数 SHALL 由面板实际可用宽高决定，SHALL 把面板的整块空间用满（MUST NOT 再叠一层低于面板的
人为上限），按等比缩放，MUST NOT 溢出面板、MUST NOT 产生水平换行或触发预览滚动。
采样网格的最终安全上限属于宿主的 `imageToText`（宽/高 200）。

#### Scenario: 窄预览栏
- **WHEN** 预览栏宽度为 30 列、高度 12 行
- **THEN** 预览至多 30 列宽、11 行高（保留标题行）
- **AND** 每行是单个 `Text`，不自动 reflow 成两行

#### Scenario: 宽预览栏不被自己截断
- **WHEN** 预览栏宽 130 列、高 45 行
- **THEN** 预览可以使用超过 96 列 / 32 行的空间
- **AND** 内容按等比缩放填满可用区域

### Requirement: 降采样后适度锐化

宿主把图片降到单元格采样网格时 SHALL 应用一次轻度锐化（unsharp），以抵消降采样的边缘对比损失；
强度 MUST 保持轻微（不得产生可见光晕）。该处理 MUST NOT 改变行数/列数或引入新的转义序列。

#### Scenario: 锐化只影响像素取舍
- **WHEN** 同一张截图分别以无锐化 / 带锐化生成预览
- **THEN** 两者的行列数完全一致
- **AND** 带锐化版本的边缘对比更高

### Requirement: 预览结果缓存且失败也缓存

预览结果 SHALL 按 `(路径, size, mtime, maxCols, maxRows, color, region)` 缓存，容量有上限（默认 32 条）。
`null`（解码失败）MUST 一并缓存，MUST NOT 使面板在每次重绘时重试解码。
面板刷新（`refreshToken` 变化）或面板缓存清理时 SHALL 使对应条目失效；清理时仍在解码的结果 MUST NOT 再写回缓存。

送给解码器的字节 MUST 是文件原样：宿主回报的 `imageWidth` / `imageHeight` 是它拿到的那份字节的尺寸，
预缩会产生第二个坐标系（缩放窗口随后就在错误的坐标里算），而 `resizeImage` 也不做 EXIF 方向纠正。

#### Scenario: 文件被改动后不复用旧图
- **WHEN** 同一路径的文件在磁盘上变化（size / mtime 改变）
- **THEN** 缓存键变化，重新解码并渲染新内容

#### Scenario: 解码失败不刷屏
- **WHEN** 某个文件解码返回 `null`
- **THEN** 后续重绘直接命中 `null` 缓存，不再调用 `imageToText`

#### Scenario: 源尺寸就是原图尺寸
- **WHEN** 预览一张大于任何“预缩阈值”的大图
- **THEN** 返回的 `imageWidth` / `imageHeight` 等于原图尺寸
- **AND** 放大时请求的 `region` 落在原图的坐标系里

#### Scenario: 清空缓存不会被在飞结果复活
- **WHEN** 一次解码还在进行时调用了缓存清理
- **THEN** 它完成后的结果不被写入缓存

### Requirement: 远端返回的预览文本仍需净化

预览文本可能来自远端 env（HTTP），界面在渲染前 SHALL 复用宿主的 ANSI 净化（仅保留 SGR），
MUST NOT 把对端返回的光标 / 擦屏 / OSC 序列直接写入终端。

#### Scenario: 恶意或错误的远端实现
- **WHEN** `imageToText` 返回的行里含 `ESC[2J` 或 OSC 序列
- **THEN** 渲染前这些序列被移除
- **AND** SGR 颜色保持有效
