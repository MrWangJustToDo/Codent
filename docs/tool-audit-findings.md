# Core tool 审计发现（2026-10-13）

对 `@codent/core` 内置 tool（及 `@codent/node` CoreEnv 边界）做的一次分组审计。用 6 个并行子任务覆盖：
文件读、文件写、shell+命令安全、web+交互、session+subagent、plan/skills/memory/lsp/code-mode。
参考成熟 agent（Claude Code、opencode、Aider）的实现作对照。

**图例**

- 严重度：`高` / `中` / `低`
- 核实状态：`[已核实]` = 我对着源码逐行确认过（含行号）；`[报告]` = 子代理报告（附位置，未逐条复现）
- 行号基于**写作时**的代码，未随 2026-10-14 的复核回写（漂移本就常态）：复核结论以每条前面的 `【…】` 标注为准，需要定位时按文件重新 grep。

> ⚠️ 高优先级里有 3 个是**安全**问题（①、②、软链接逃逸），建议最先处理。（**2026-10-13 已全部处理**，见下。）

> **修复状态（2026-10-13）**：高 6 项已全部修复，并各配 validator（安全两项另开 OpenSpec change `harden-tool-safety-boundaries`）。中 / 低未处理（**2026-10-14 已逐条复核 —— 见下方「复审状态」**）。
> 已落地：① 搜索路径包含 + `cwd`（`validate:search-path-containment`）· ② 只读白名单收窄（`validate:command-safety-readonly`）· 软链接 `realpath` 约束（`validate:fs-symlink-containment`）· ③ `read_file` 先判大小（`validate:read-file-size`）· ④ `webfetch` 流式限长（`validate:webfetch-size`）· ⑤ `complete_plan` 空白项闸门（`validate:plan-verification`）· ⑥ 记忆合并误删（`validate:memory-merge-selfdelete`）。

> **后续波次（同日）**：③ 的修复进一步收紧 —— `read_file` 文本分支改为**流式字节窗口**（超限文本不再报错，属行为变更，output schema 不变，
> `validate:read-file-size`）；图片分支在**解码前**按声明尺寸拦截（新增 `MAX_IMAGE_PIXELS` / `MAX_IMAGE_DIMENSION`，并补上 GIF 尺寸解析）；
> 体积上限统一收进 `tools/util/output-limits.ts`，重复 helper 归并（`utils/bytes.ts`、`tools/util/bounded-body.ts`、`isTimeoutError` 移入 `runtime-types/abort.ts`）。
> 复审这批判修复时发现并已修掉一个回归，见文末「复审发现的回归」。

> **复审状态（2026-10-14）**：对「中 / 低」全部条目**逐条对照当前源码**复核了一遍（不是重读原文；三组并行复核 + 关键项自查），结论就地标在每条前面：`【未修】` / `【已修 · <commit>】` / `【部分修】` / `【不成立】`。口径：只看当前源码是否仍有该行为，行号一律重新定位。
>
> - **已修（审计之后）**：高 ①②（`b9dad0cf`）、③④⑤⑥（`7568c385` + 收紧波次）、⑦（`90d57f5b` / `3fc3a909`）、`native-fs` 软链接 `realpath` + 大小写折叠（`b9dad0cf` / `050bd6a1`）、`session_read` 体积闸门（`78835b24`，**分页建议那半仍未修**）、provider `response.text()` 上限（`0c3142a3`）、`toModelOutput` 幂等 guard（`de771a4f`：审计点名 4 个，实际 24 个声明站点）、资源与泄漏三处（`5b3df3fe`：mutation-queue 回收 / LSP 重启 timer 与计数 / pre-fork 重复注册返回值）、模型可见契约对齐（`8b244a0e`：`task` 描述 / `session_read` 分页建议 / `grep` 单文件 count + `output_mode` 键名 / `tree` 的 `ignore` 语义）。
> - **报告不成立（写作当时即如此，不是修好的）**：`webfetch-html` 的「skip 状态是单一全局布尔」（当时已是 call-local `inSkippedTag` / `skipDepth`）、`RUN_COMMAND_TIMEOUT_MS` 每次前台调用取 env（`e29e746b` 已 memo）。两处都是 `[报告]` 未逐条复现的代价 —— 动手前请以当前源码为准。
> - **⚠️ 一项曾是「假绿」，现已收口**：取消语义的 guard 读了错的谓词（`run_command` / `task` 取消后的 partial 输出被整体短接），而拦住它的两条断言被注释掉了 —— 见 ⑧。`fce0eb7f` 已把 guard 与断言一起恢复，`validate:cancel-semantics` 重新是在真断言。
> - 余量：「中」37 条里 **17 条未修**（另 2 条 `【部分修】`、17 条已修、1 条 `【不修】`）；「低」11 条里 **7 条未修**（另 2 条 `【部分修】`、1 条已修、1 条不成立）。剩余顺序见文末。

---

## 高（已核实源码）

### ① 搜索工具能读到工作区外 / 找错目录 `[已核实]` · 已修复（`b9dad0cf`）
- 链路：`tools/glob-tool.ts:187` `const searchPath = path ?? "."` → `:201 runGlobSearch(coreEnv, pattern, searchPath, …)`
  （`grep-tool.ts:414/442`、`tree-tool.ts:181` 同）→ `tools/util/exec-args.ts:55`
  `env.execFile(file, args, { timeout })` **只传 timeout、没有 `cwd`** → `packages/node/src/index.ts:227`
  `cwd: fileOptions?.cwd`（此处 `undefined`）→ 子进程继承 `process.cwd()`。
- `searchPath` 全程**没有工作区包含校验**（fs 工具走 `native-fs.resolvePath` 会被拦，这里直接拼进 `fd`/`rg`/`find`/`tree` 参数）。
- 影响：
  - 安全：`grep {pattern:"x", path:"/etc"}` 或 `path:"../../.."` 可读工作区外（这些是"只读自动放行"的工具，无审批兜底）。
  - 正确性：`rootPath !== process.cwd()` 的宿主（server `ROOT_PATH`、`codent acp --cwd`、remote env）默认 `path:"."` 会搜错树。
- 修：对 `searchPath` 做与 fs 一致的根包含解析（拒绝绝对路径 / `..` 逃逸），把解析后的**绝对路径**作为 `cwd`（或参数）传给 `execFile`。

### ② 命令安全对"披着只读外衣的写操作"漏判 `[已核实]` · 已修复（`b9dad0cf`）
`tools/command-safety/command-analyzer.ts:137-187` 的 `READONLY_PREFIXES` 含 `find`(:143)、`env`(:150)、
`git log`/`git diff`/`git show`(:162-164)。
- `env` 是**命令执行器**：`env rm -rf src`、`env sh -c "rm -rf src"`、`env -i sh -c …` 命中 `env` 前缀 → 判只读 → **无审批执行**（subagent 更只走只读白名单）。`command-arity.ts` 也把它当普通命令（`env: 1`）。
- `find` 的写/执行谓词未被扫描：`find . -delete`、`find . -exec rm -rf {} ;` → 放行。
- `sed`：`MUTATING_FILTER_FLAGS.sed` 只查 `-i/--in-place`，但脚本语言可写/执行：`sed -e "w /tmp/pwn" f`、`sed -n "1w /tmp/pwn" f` → 放行。
- `git log/diff/show` 接受 `--output=<file>`（写文件）：`git diff --output=/repo/x` → 放行。
- 这正好违反该文件自身注释的原则（它已为 `sort -o`、`sed -i` 收窄过白名单，称"写操作披着过滤器的名字"）。
- 修：把 `env`、`find` 移出只读前缀（`env` 仅当只有 `KEY=val` 赋值时才只读；`find` 见 `-delete/-exec/-execdir/-ok/-okdir/-fprintf/-fls/-fprint` 一律判写）；`sed` 脚本含 `w/W/r/R/e` 判写；`git … --output/-o` 判写。补负向验证（参考 `negative-patch-websearch.sh` 风格）。

### ③ `read_file` 先整文件读进内存再判大小 `[已核实]` · 已修复（`7568c385`，后续 `27422970` / `9efc9dd9` / `43819c06` / `90d57f5b` 收紧）
`tools/read-file-tool.ts`：
- PDF：`:274 const buffer = await fsys.readFile(filePath, "buffer")` → `:276 if (buffer.length > MAX_BINARY_SIZE)` **先读后判**。
- 文本：`:308` 又一次整文件 `readFile(…,"buffer")`（只为探二进制）→ `:318 const content = await getFile(...)` **再读一遍**。
- 早先的 `stat`（`:181`）已拿到 `.size`，却未用于门槛。
- 影响：读多 GB 文件直接 OOM；PDF 的大小守卫在分配**之后**才触发。
- 修：先按 `stat.size` 拦（文本上限 + `MAX_BINARY_SIZE`）；二进制判定用**有界采样**（读头部）而非整文件 buffer；文本只需读一次。

### ④ `webfetch` 先整段读进内存再判 5MB `[已核实]` · 已修复（`7568c385`，`0c3142a3` 抽出有界读取）
`tools/webfetch-tool.ts:197-206`：
```ts
const contentLengthHeader = response.headers.get("content-length");   // :198 压缩后长度
if (contentLengthHeader && parseInt(...) > MAX_RESPONSE_SIZE) throw …
const arrayBuffer = await response.arrayBuffer();                     // :203 整段物化
if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) throw …               // :204 后才判
```
- `content-length` 是 **wire（压缩）长度**，挡不住 gzip/deflate 炸弹，也挡不住 chunked / 撒谎的头。
- 影响：恶意或坏掉的 URL（含 prompt injection 诱导）可让进程 OOM；`--remote-env` / remote-session 时是**服务端**发请求，一炸带走所有会话。所谓"5MB 上限"并未真正生效。
- 修：`response.body.getReader()` 流式累加，超 `MAX_RESPONSE_SIZE` 立即 `controller.abort()` 并抛错；`content-length` 只作早拒。

### ⑤ `complete_plan` 验证闸门可被空白项绕过 `[已核实]` · 已修复（`7568c385`）
`agent/plan/plan-verification.ts:127-141`：
```ts
const resultNorms = new Map(results.map((r) => [normalizeVerificationItem(r.item), r]));
for (const exp of expected) {
  const key = normalizeVerificationItem(exp);
  if (!resultNorms.has(key)) {
    const found = [...resultNorms.keys()].some((k) => k.includes(key) || key.includes(k)); // :133
    if (!found) return { ok: false, error: … };
  }
}
```
- `verificationResultSchema.item` = `z.string().min(1)`，`" "` 合法；`normalizeVerificationItem(" ") → ""`；**任意字符串 `.includes("")` 恒为 true**。
- 影响：一条 `item:" "` 的结果即满足整张清单 —— 这是 plan 生命周期里**唯一**强制的闸门（`complete_plan` 是 retro 出口）。子代理用构建产物复现 `{ok:true}`。
- 修：归一化后为空 / 过短（如 <3 字符）判非法；把无界子串匹配换成有界相似度（归一化精确匹配，或词元重叠阈值），不要用 1 字符 key 去 `includes`。validator 增加空白 / 短项用例。

### ⑥ 记忆合并会删掉它刚写出的条目 `[已核实]` · 已修复（`7568c385`）
`agent/memory/memory-extractor.ts:456-479`：
```ts
// 先写合并结果
for (const merge of merged) { await memoryManager.writeMemory(merge.name, …); for (const f of merge.replaces) allReplaced.add(f); }
…
// 再按【写入前的旧快照】删除被替换文件
for (const filename of [...allReplaced, ...allDeleted]) {
  const exists = memories.some((m) => m.filename === filename); // memories 是旧快照
  if (exists) { await memoryManager.deleteMemory(filename); … }
}
```
- 若模型把合并项命名为某来源的名字（自然：`alpha-note` + `beta-note` → `alpha-note`），`replaces` 含 `alpha-note.md`，旧快照也有它 → **连刚写好的合并文件一起删**。子代理复现：合并后 `remaining memories == []`。validator 只测"合并名与来源都不同"，故漏。
- 修：先删后写，或记录本轮写入过的文件名、删除时跳过。

---

## 中（`[报告]`，附位置） · 已逐条复核（2026-10-14）

### 写 / 编辑
- 【已修 · `d1f17c71`】 `tools/util/preview-edit.ts` 自己用 `includes/replace` 重实现匹配，与 `edit_file` 的 unescape / `startLine` / 唯一性逻辑不一致 → 审批时看到的 diff 可能**藏掉真实写入**或**显示并不发生的改动**；`PreviewEditInput` 甚至没有 `startLine` 字段。→ 改为走工具自己的 `resolveEditMatch`/`applyResolvedEdit`（三条漂移全部消除）；`startLine` 加进类型并透传（app 侧本来就在传，只是类型挡掉了）；**工具拒绝时**改为返回「原文件 + 原因」（`edit_file` 只要有一条 edit 解析失败就一个字都不写），审批视图把原因显示出来而不是给一个空 diff。`validate:edit-preview` 用同一份内存 fs 同时驱动**真工具**与预览并逐字节比对。
- 【未修】 `tools/find-edit-match.ts`：模糊分支**忽略 `startLine`**（取第一个命中）；`newString` 在只有 `oldString` 被过度转义时也被 `unescapeCommonEscapes`（会改写字面 `\n`/`\t`）。
- 【未修】 CRLF 文件：多行 `oldString`（LF）匹配 `\r\n` 失败；`read_file` 渲染带不可见 `\r`；匹配路径无 CRLF 归一化。
- 【已修 · `a011c64e`】 `tools/delete-file-tool.ts` **绕过** `withFileMutationQueue`（与 edit/write 并行时可能"复活"已删文件）。→ 入同一把按路径的队列；`validate:file-mutation-queue` 新增"删除必须等在同一路径上进行的变更"用例（按操作顺序断言）。
- 【部分修 · `5b3df3fe`】 `tools/util/file-mutation-queue.ts`：key 用 POSIX `pathe`（Windows 下 `src\a` vs `src/a` 不同 key → 不串行；Node 宿主已改为提供平台 `path`，POSIX `pathe` 只是 fallback 默认，**这一半仍未修**）；~~Map 永不回收~~ —— **已修**：链尾自己摘除条目（按身份校验，避免删掉后面排队者等待的 promise），`validate:file-mutation-queue` 断言 60 个文件后归零。
- 【已修 · `b9dad0cf` / `050bd6a1`】 `packages/node/src/environment/native-fs.ts:28-43` 工作区约束是**词法**的、不 `realpath` → 指向外部的工作区内软链接可逃逸（读 **和** 写）。
- 【已修 · `a011c64e`】 `write-file-tool.ts`：parent 目录判断用 `lastIndexOf("/")`（POSIX-only，漏 Windows 分隔符）；`bytesWritten: content.length` 是 UTF-16 码元不是字节；无 temp+rename（`CoreEnvFs.rename` 已提供该 seam，`session-journal` 已用）。→ 分别改为 `coreEnv.path.dirname`（宿主规则）、共享的 `utf8ByteLength`、`temp + rename`（宿主没有 `rename` 时退回直写）；新 `validate:file-write` 覆盖三处 + rename 失败清理 + 无 rename 的宿主 + overwrite 闸门。

### 搜索 / 展示
- 【部分修 · `8b244a0e`】 `grep-tool.ts`：`--max-count` 是**每文件**上限，`-C context` 的上下文行不计入，`truncateLines(stdout, fetchCount)` 会只留上下文行、丢掉真正匹配；~~`output_mode:"count"` 单文件（裸数字无 `path:`）解析成 `0`~~（已修：单文件裸数字按 `defaultFile` 归属，实测还原调用点即 `[{"file":"5","content":"Count: 0"}]`；**顺带发现**描述写的是 `output_mode` 而 schema 键是 `outputMode`，未知键被静默丢弃 → 「要 count」实际跑 content，同一处修掉）；搜索工具**忽略 abort 信号**（`exec-args.ts` 无 `signal`）仍未修。
- 【已修 · `de771a4f`】 `list/glob/grep/tree` 的 `toModelOutput` 缺 `read_file` 的 `ContentPart[]` 幂等 guard（`format-read-file-result.ts:20` 有）→ 会话恢复 / 重跑后对数组输出取 `.matches/.tree/.entries` 得 `undefined`，wire 上出现 `"undefined"`。
  **复核修正**：实际是全部 **24 个声明站点**都缺（含 `run_command` / `webfetch` / `websearch` / `session_read` / `task` / `todo` / plan / skills / memory），其中 `session_search` 会直接**抛异常**、`load_skill`/`memory_read` 返回 `undefined`。触发路径的成文依据在 `mcp/prefer-multimodal-content.ts:101-109`（TanStack 把**数组**结果 `JSON.stringify` 成 `ContentPart[]` 文本后交给投影）。
- 【已修 · `8b244a0e`】 `tree` 的 `ignore` 在二进制路径（`-I` 支持 `|`）与 JS fallback（按名字精确匹配）语义不一致。→ fallback 改为同一契约（basename glob + `|` 备选），`validate:tree-walk` 覆盖。

### shell
- 【已修 · `d1f17c71` + `f7c51658`】 `run-command-tool.ts:220-224` ~~送进 `maybeCacheOutput` 的是 accumulator 的 `snapshot().content`（已按 50KB/2000 行截成**尾部**）→ `cachedOutputPath` 号称"完整输出"，实际 >50KB 时**头部不可恢复**~~ —— **已修**：改为优先用宿主自己的全文缓冲（`result.stdout`/`stderr` 是**全部 chunk 的拼接**，本地宿主与 HTTP 平面都如此），accumulator 仅作「流式但返回空」宿主的 fallback；`validate:command-output-cache` 断言超限输出的**头部标记在文件里**。**仍未修**：`persistIfTruncated` / `fullOutputPath` / `getTempFilePath()` 仍是死代码（取消/超时分支只有 accumulator 可缓存，那时文件仍是尾部 —— 有 `truncated` 信号可让措辞诚实，属可选的下一小步）。→ **两处都已收口（`f7c51658`）**：死代码整体删除（新断言扫描源码确认这五个名字不再出现）；取消/超时分支把 accumulator 的 `truncated` 传进预览，措辞变成 `Output saved to: …（本次运行只保留了尾部）`，只有主路径（宿主给了全文缓冲）才说 `Full output saved to`。
- 【未修】 `util/command-job-registry.ts`：`MAX_FINISHED_JOBS` 只限已结束 job，**运行中的 job 无上限**（各带一个日志 writer/文件）。
- 【已修 · `a011c64e`】 `command-job-registry.ts:158` `markExited` 三元 `… ? "exited" : "exited"` 恒为 `exited`（失败 job 后被报 `completed`）；`kill` 对已结束 job 也返回成功（`kill-command-tool` 里"未在运行"分支成死代码）；`kill_command` 返回 `cachedOutputPath: null`（丢了 `logPath`）。→ 零退出才是 `exited`，其余（含"被信号杀掉、无退出码"）是 `failed`（完成通知本来就把非 `exited` 原样透传，所以**用户可见**地从 "completed" 变成 "failed + 真实退出码"）；`kill` 改为返回"是否真的杀掉了"；`kill_command` 回传 job 的 `logPath` 作为 `cachedOutputPath`（杀掉不等于抹掉输出）。`validate:command-job-registry` 覆盖，且它原有的"日志失败后仍可查询"断言正好成了 `markExited` 的非空转见证。
- 【未修】 `output-accumulator.ts:166,220` 对同一 chunk 重复计数（`totalDecodedBytes` 翻倍，`truncated` 误判）；无消费者，所以是潜伏问题。
- 【未修】 `command-parser.ts:68`（`resolveShellKind`→`getEnv()`）/ `createTreeSitterEnv()` 走 **ambient env**：多 runtime 进程里 shell 种类 / 语法可能取自最后注册的 env（已在 guard allowlist 记为"host-level"，但多 runtime 下方向性风险值得注意）。
- 【未修】 `run-command-tool.ts` 的 `timeout` 无 `.max` + `shell.ts` `setTimeout(timeout*1000)`：超大值会被 Node 钳到 ~1ms → 每个命令立刻超时（低概率）；`RUN_COMMAND_TIMEOUT_MS` 也被 `resolveDefaultCommandTimeout` 接受任意 ≥1000 的有限值。
- 【未修】 其它直接调 `coreEnv.runCommand` 而无 timeout 的调用方（`server/routes/env.ts`、`turn-context/env-context.ts`、`app` workspace utils）仍以 30s 安全网为事实上限（现已被诚实报为 `safety-timeout` + `-1`）。

### web
- 【未修】 `websearch-tool.ts` + `websearch/provider.ts`：`timeout` 是**每个 provider** 一份（primary + 每个 fallback 都拿满预算）→ `timeout:60` 的搜索可跑 ~4-5 分钟；`defineServerTool` 未声明 `timeoutMs`。
- 【未修】 域名过滤在 provider **调用之后** → 过滤空时 provider 返回 `[]`，manager 当成成功、**不再 fallback**（Tavily 支持 `include_domains` 却没用）。
- 【未修】 `providers/duckduckgo.ts:65` 结果块正则要求 `</div>` 紧跟 `<div` 或串尾 → **丢最后一条**（validator 的 stub 是单条无尾随标记，测不出）。
- 【未修】 `webfetch-html.ts`：只解 7 个实体，`&#8211;`/`&#x27;`/`&mdash;` 等原样进 title（UI+模型）；无 SSRF/重定向再校验（`redirect:"follow"`）；`webfetch-tool.ts` scheme 检查大小写敏感（`HTTPS://` 被拒）。
- 【已修 · `0c3142a3`】 provider 的 `response.text()` 无大小上限（同 ④ 类问题，端点相对可信）。

### subagent / session
- 【已修 · `8b244a0e`】 `subagent/task-tool.ts:142-146` 对父模型说 subagent"**没有 `run_command`**"，但 `subagent-tools.ts:23-34` 注册了 `run_command:subagentSafe` → 两个面向模型的表述矛盾（`explore-prompt.ts` 也列了 `run_command`）。→ 描述改为按实际工具集陈述，`validate:subagent-prompt` 逐名断言。
- 【已修 · `5b3df3fe`】 `subagent/task-prefork.ts:181` `start()` **永远返回 `true`** → middleware 里「重复 toolCallId 就摘掉父信号监听」的清理是**死代码**（重复 `TOOL_CALL_END` 泄漏一个监听 + AbortController）。已修：重复注册返回 `false`，middleware 的 disarm 分支生效（`validate:task-prefork` 覆盖）；**被丢弃的 queued 项 `finally` 不跑**那半仍未修（队列项从不进入 `runPreForked`）。
- 【已修 · `78835b24` + `8b244a0e`】 `session-read-tool.ts:109` 无文件大小上限（`session_search` 有 `MAX_SESSION_FILE_BYTES`），大日志 O(file)×页数，每页整读整 fold；其描述里的分页建议（`offset += limit`）在内容上限截断时会**跳过消息**。→ 两半都已修：体积闸门 + 描述改为指向渲染尾部的真实 offset（`validate:session-search` 用 9 条长消息 / `limit: 10` / 实返 7 条覆盖）。
- 【已修 · `d1f17c71`】 subagent 的 `run_in_background` 未被拦（analyzer 只看 `&`），但 subagent 拿不到 `get_command_output`/`kill_command` → 起了读不掉也杀不掉的 job。→ 在 `subagentSafe` 闸门里**先于 analyzer** 拒绝（"命令本身只读"不足以放行），`validate:safe-command` 断言只读+后台被拒、主 agent 仍可后台。
- 【不修 · 有意为之（用户决定）】 丢弃的 pre-fork subagent 只 abort 未 `destroyAgent`（流重启/结束时累积）—— **不修**：`destroyAgent` 会把 subagent 从 catalog 移除，Ctrl+T 的 task 列表（及其预览 / 摘要流）就看不到了，而 `task-tool.ts:204` 本来就用 `autoDestroy: false` 保留它。代价（长会话里 catalog 缓慢增长）是明确接受的。若将来真要回收，方向是「保留最近 N 个已结束的」而不是立刻销毁。
- 【已修 · `4079ee5c`】 `run-stats.ts:144-147` `hitStepBudget` 未加 `!aborted` → 用户取消也可能报 `reachedLimit=true`。→ 取消落在 tool loop 中段，`finishReason` 正是 `tool_calls` 且计数已达顶，于是 task 输出同时带 `aborted: true` + `reachedLimit: true`：transcript 行的状态词（`formatTaskOutput` 两个都推）、给父模型判断的 flag、以及 task 面板继承的 phase 都被污染。`validate:cancel-semantics` 原本就在断言这条不变量，但用的是 `finishReason: null`（取消不会产生这个形状），所以**没加 guard 也能过** —— 现已改用 `tool_calls`。
- 【已修 · `f7c51658`】 `hasSessionHistory`（`session-retrieval.ts:43-54`）把当前会话自己的日志也算作"有历史"。→ 新增 `excludeSessionId`（agent 创建时传 live session id）；`session_search` 本来就默认排除当前会话，所以"只有自己那条日志"的workspace/每次 resume 都不该被宣称"可检索历史"。`validate:session-retrieval` 覆盖。
- 【已修 · `f7c51658`】 `run-subagent.ts:506` 硬编码 `"begin_summary"`（应用 `BEGIN_SUMMARY_TOOL_NAME`）；`task-prefork-middleware.ts:98` 硬编码 `"task"`。→ 分别改用 `BEGIN_SUMMARY_TOOL_NAME` 与 `BUILTIN_TOOL_NAMES.task`（字面量会一直编译通过、却悄悄匹配不到任何东西）；`validate:cancel-semantics` 增加"识别方必须读同一处定义"的断言。

### plan / lsp / code-mode
- 【未修】 LSP 请求**无超时**（各 tool 裸 `await sendRequest`，transport 也无）：server 挂住会永久阻塞该次运行，Esc 也解不开（未透传 abort）。
- 【已修 · `5b3df3fe`】 `lsp-manager.ts:494-527` 崩溃重启的 `setTimeout`（最长 30s）**未被 `shutdownAll` 清理**，`shuttingDown` 复位后会话关闭还会重启一个 server；重启计数/退避也未复位。→ manager 按语言持有 timer 句柄（顺带解决「两条崩溃通知叠两个重启」）、`shutdownAll` 取消并复位计数/退避；`validate:lsp-restart-cleanup` 注入假连接，无需真 server。
- 【未修】 plan-mode "只读" 可被内置 `code_rewrite`（`category:"edits"`，`dry_run=false` 就地写）绕过 —— `PLAN_MODE_EXCLUDED_TOOL_NAMES` 只硬编码了 4 个名字。
- 【未修】 `code-mode/extension.ts:95-142` 的 `console` 补丁**不可重入**（并行 `execute_typescript` 会互相恢复 / 泄漏），`console.warn` 未补。
- 【未修】 `memory-manager.ts:368-372` `MEMORY.md` 的"字节"上限用 `slice` 按**码元**截（CJK 可超 ~3×）；`lsp/tools/tool-shared.ts:23-32` `truncateHead` 的 `maxBytes` 同样是字符比较的启发式。
- 【未修】 `lsp/tools/code-overview.ts:82` `depth` 由模型给且无 clamp。
- 【未修】 `skills/extension.ts:150` 的 `<skill name="…">` 未转义（memory 侧有转义）；skill 目录顺序 `~/.agents/skills` 先于 `.agents/skills`（用户全局**遮蔽**项目，疑似与 Claude Code/opencode 相反）。

---

## 低（`[报告]`，摘要） · 已逐条复核（2026-10-14）

- 【未修】 展示缺换行：`list-file/glob/grep` 的分页头与内容之间无 `\n`（`…limit: 500src/a.ts`）。
- 【未修】 `read_file` 目录分支与文档不符（doc 说 offset/limit 仅文本），越界返回空而非报错；`read_file` 目录用 1-based、`list_file` 用 0-based。
- 【未修】 行数统计把结尾 `\n` 算成额外一行（空文件报 `totalLines: 1`）。
- 【未修】 `grep` 的"源端上限"是每文件（非总量），glob 无源端上限；`truncateLine` 返回超 `MAX_CONTENT_LENGTH`；`stripOuterQuotes` 会误剥（含 `""` → 空 pattern）。
- 【未修】 `todo`：`update` 存 `title.trim()` 但 tool 回传/打印原始 `title`；`ask_user` 客户端路径 OK。
- 【部分修】 `webfetch`：`allowedDomains`+`blockedDomains` 同传不报 schema 错；DDG 可能被 spread 选为主 provider（与"last-resort"文档不符）；文本抽取 skip 状态是单一全局布尔。
- 【未修】 `mcp-client.ts` 只认单行 `data:` 帧 / 只取首个 content block。
- 【部分修 · `0c3142a3`】 `websearch`：`timeout` 每秒/每 provider 语义；`response.text()` 无上限。
- 【未修】 cancel 分支：`run-command-tool` 取消时 `durationMs: 0`、只回一个 `cachedOutputPath`（另一个缓存文件成孤儿）。
- 【已修 · `fce0eb7f`（见 ⑧）】 `presentation/output-format.ts:290` 对**任何**带 cancel 标记的输出都短路成 `TOOL_CANCELLED_MESSAGE`（注释说只该对 synthetic fallback），`run_command` 的 partial stdout 会被隐藏。
- 【不成立 · 早于审计】 `run-command-tool` 的 `RUN_COMMAND_TIMEOUT_MS` 每次前台调用都 `await coreEnv.getEnv()`（remote 时一次 HTTP）。

---

## 复审发现的回归（修复过程中引入）

### ⑦ `read_file` 流式化把「已解码文本」喂给字节探针 → 多字节文本被判成 binary `[已核实 · 已修复]`
- 链路：`tools/util/read-file-detect.ts` 的 `headProbeSample` **字符串分支**用 `charCodeAt(i) & 0xff` 逐个窄化码元（③ 的修复 `7568c385` 引入）；
  `27422970` 让**流式文本路径**把 `readTextPieces` 的第一段（**已解码**字符串，`read-file-tool.ts:422`）交给它 ——
  于是原本只在"宿主不能返回字节"降级路径上可达的 bug 变成了正常路径：每次流式读都走它。
- 影响：`& 0xff` 之后落进 C0 的码点被当成控制字节，其中两个直接是 **NUL** —— `─` U+2500 → `0x00`、`一` U+4E00 → `0x00`，
  而 `isBinaryContent` 见到第一个 NUL 就 `return true`。任何含 `─` 或 `一` 的文本（树形图、中文文档、本仓库自己的文档与日志）
  都会被拒成 `File appears to be binary`，即**流式读对这类文件全线不可用**。
- 修：字符串分支改为**真实 UTF-8 重编码**（`TextEncoder`），不再窄化。启发式实际只看两类信号（NUL / C0 占比，
  `byte < 9 || (byte > 13 && byte < 32)`），二者在"解码 → 重编码"下精确往返（U+0000 → 0x00、U+0001..U+001F → 原字节；≥ 0x20 从不参与判定），
  所以真阳性不受影响；重编码后样本也正好是文件前 `BINARY_PROBE_BYTES` **字节**（旧代码按 UTF-16 码元计数）。
- 同批修掉的相邻缺陷：探针原先只看**第一段**，而段尾切在窗口最后一个换行处 —— 首段很短时只看几十字节，
  4096 字节之后的 NUL 会被放过（旧的整文件路径探的是前 4096 字节）。现改为**按字节累积到 `BINARY_PROBE_BYTES` 再探**
  （循环有界：整窗无换行会一次给满 64 KB，EOF 结束），并把 `withHead` 泛化为 `withPrefix` 以回放已消费的段。
- 验证：`validate:read-file-size` 新增 —— 5 种多字节文本（框线树 / 中文 / 树+中文 / 重音与破折号 / emoji）在**两条读路径**上都必须读成 `text`；
  NUL 在两条路径上都必须被拒；「宿主不能返回字节」的**字符串分支**单独钉一条；「首段只有 2 字节、NUL 在其后」单独钉一条
  （该用例在修复前报 `Missing expected rejection`，非空断言）。

### ⑧ `formatToolOutput` 把「任何 cancel 标记」当成「没有输出」 → 取消后的 partial 输出被隐藏 `[已核实 · 已修复（fce0eb7f）]`
- 现状：`agent/tools/presentation/output-format.ts:293` 那行**正确**的短接被注释掉了 ——
  `// if (isSyntheticCancelOutput(output)) return TOOL_CANCELLED_MESSAGE;` —— 实际生效的是 `:294`
  `if (isCancelledOutputMarker(output)) return TOOL_CANCELLED_MESSAGE;`；`presentation/compute-display.ts:54` 同样。
- 为什么是错的：`isCancelledOutputMarker` 只回答「这是不是一次取消」，`isSyntheticCancelOutput` 才回答「除了取消还有没有东西」
  （框架 fallback 那个 `{ success: false, error, cancelled: true }` —— 任何 tool 的 output schema 都不长这样）。
  换成前者后，**任何**带 cancel 标记的输出都在按 tool 名分派**之前**被短接成 `TOOL_CANCELLED_MESSAGE`：
  被取消的 `run_command` 已经产出的 partial stdout、被取消的 `task` 的 `[Task cancelled by user.]` 都不再进详细块。
  与 `AGENTS.md` 里写明的契约相反：「只有 synthetic 才能跳过渲染」。
- 来源：`0248ac36` 的 body 自己记着 —— 「this also carries a workspace change replacing `isSyntheticCancelOutput`
  with `isCancelledOutputMarker` at both presentation sites … it fails `validate:cancel-semantics` …
  Committed as-is by request; the validator is red until that guard is settled.」即当时把一个工作区改动一起扫进了提交。
- 为什么当时看起来是绿的：`c8b11c29` 把 `validate:cancel-semantics` 里两条判别性断言注释掉了
  （`scripts/validate-cancel-semantics.mjs:174-184`，`TEMPORARILY DISABLED … Re-enable both when the guard is settled`），
  于是全量 validator 报 187 passed / 0 failed / 2 skipped —— **绿是靠削弱 check 换来的**。它是那次复核里唯一一个「行为错了、check 却是绿的」的项：
  绿不是因为对了，而是因为唯一能判它的断言被拿掉了。
- 修（`fce0eb7f`，已完成）：两个站点改回 `isSyntheticCancelOutput`；`c8b11c29` 注释掉的两条断言放回，
  并补上它们没覆盖的另一半 —— 取消的 `run_command` 保留已产出的 partial stdout、且不渲染 stop 时合成的 `exitCode: -1`。
  实测：未修版本下该 validator 在第一条断言即失败（`the detailed block words it as cancelled (Cancelled by user.)`）。
- **不要一起改回**：`tool-state.ts:53` 的 `isCancelledToolCall` / `getInlineSummary` 用 `isCancelledOutputMarker` 是**对的**
  —— 它们只回答「这一行算不算取消」，与「有没有输出可渲染」是两个问题。

---

## 建议修复顺序

> **2026-10-14 更新**：下面的第 1、2 批**已全部完成**（见「修复状态」与「复审状态」）。第 3、4 批仍然适用，只是范围缩小到标注为 `【未修】` 的条目。剩余项按这个顺序推进：

0. ~~**先收「假绿」**：⑧ 的 cancel guard~~ —— **已完成**（`fce0eb7f`：guard 与两条断言一起恢复，并补了 `run_command` 那半）。
1. **模型可见的正确性**（都是小改动、各能配 validator）：~~`list/glob/grep/tree` 的 `toModelOutput` 幂等 guard~~（已完成 · `de771a4f`，实际覆盖 24 个声明站点）· `task-tool` 对父模型说的「没有 `run_command`」与 `subagent-tools` 实际注册的 `run_command:subagentSafe` 自相矛盾 · `session_read` 描述里的 `offset += limit` 建议会跳消息 · `grep` 单文件 `count` 恒解析成 0 · `tree` 的 `ignore` 两套语义。
2. **资源与泄漏**：只剩 **运行中的 job 无上限**。其余四项已定案：被丢弃的 pre-fork 不 `destroyAgent` → **不修**（理由见「中」：会让 task 列表看不到）；`file-mutation-queue` 的 Map 回收、`lsp-manager` 的重启 timer 与计数、`task-prefork.start()` 的返回值 → 已完成（`5b3df3fe`）。
3. **契约 / 安全（按约定先开 OpenSpec change）**：LSP 请求无超时（server 挂住会永久阻塞该次运行，Esc 也解不开）· plan-mode 的「只读」可被内置 `code_rewrite` 绕过（应改为按 tool 的 `present.category` 派生，而不是硬编码 4 个名字）。
4. **其余中 / 低**：写 / 编辑一致性（~~`preview-edit` 与 `edit_file` 共用同一套匹配~~ 已完成 · `d1f17c71`；CRLF 归一化、`delete_file` 入队、`write_file` 的 temp+rename 与真实字节数仍未修）· ~~`run_command` 缓存全文~~（已完成 · `d1f17c71`；死代码清理仍可选）· ~~subagent 起后台 job~~（已完成 · `d1f17c71`）· `command-job-registry` 的状态判定与 `kill_command` 的 `logPath` · web 的域回退与超时叠加 · code-mode 的 console 补丁重入 · memory / skills 的字节与转义 · 低项收尾（展示换行、行数统计、`todo` 回传原值等）。

> 高风险项已逐个核实源码；中 / 低为子代理报告，修复前先按当前源码复现一次（本次复核已发现两条报告项本身不成立）。修复时按仓库约定：契约/安全变更先开 OpenSpec change，功能修复配 validator。
