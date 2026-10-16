# Implementation checklist

## 1. 唯一解析

- [ ] 1.1 `packages/acp/src/paths.ts`：新增 `toWirePath(target, rootPath)` ——
      绝对路径只归一化、不重定基；相对路径按 `rootPath` 解析；空 root 返回原路径
- [ ] 1.2 绝对性用 `defaultPath.isAbsolute`（认 POSIX / 盘符 / UNC），不用 `startsWith("/")`
- [ ] 1.3 `tools.ts` 的 `toAbsolute` 字符串拼接实现删除，改由 `toWirePath` 承担
      （`toolLocationsFor` / `toolDiffFor` 的 `locations[].path` / `diff.path`）
- [ ] 1.4 `client-env.ts` 本地的 `toWirePath` 删除，改 import 共享实现
      （`fs.readFile` / `fs.writeFile` / `execFile` 的 `cwd`）
- [ ] 1.5 公开面只留一个名字：`index.ts` 导出 `toWirePath` / `resolveRoot`，
      **不**保留 `toAbsolute` 别名或双导出（仓库约定：重命名直接落地）

## 2. root 的绝对性

- [ ] 2.1 `paths.ts` 写明前提「rootPath 必须绝对」：`toWirePath` 只护栏**空** root，
      不护栏**相对** root（`resolve("rel/ws", t)` 仍依赖 `process.cwd()`）
- [ ] 2.2 新增 `resolveRoot(cwd)`，与 `toWirePath` 相邻，使前提与前提的执行不会分家
- [ ] 2.3 `bootstrapLocalAcp({ cwd })` 经 `resolveRoot` 归一化
- [ ] 2.4 `createAcpAgent({ rootPath })` 经 `resolveRoot` 归一化 —— 其 root 会出现在
      client 可见输出（`tool_call.location.path`、`SessionInfo.cwd`），不是局部细节

## 3. `rename` 按写入路由门控

- [ ] 3.1 `rename` 改为 `fallback.fs.rename && !caps.writeTextFile`：
      写入路由到 client 时不暴露，使 `write_file` 走其文档化的直接写分支
- [ ] 3.2 注释照实：这是**能力级**门控，整文件重写对**所有**路径失去 `rename`
      （`.agents/**` 在内）；core 自己记录该退化（`session-journal.ts`：*"Without rename this
      degrades to a direct overwrite … best-effort"*），else 分支是普通 `writeFile` ⇒ 不丢数据，
      只是 compaction 折叠时的日志重写不再崩溃原子
- [ ] 3.3 明确不做：路径级的两全需要 core 的路径感知能力，单独立项，不塞进本 change

## 4. 口径照实（不做成假的行为修复）

- [ ] 4.1 `isLocalOnlyPath` 改用 `toWirePath`，收敛「是否绝对」为一种谓词
- [ ] 4.2 注释与 spec **照实**说明这是卫生改动：两实现在非空 root 下判定一致，
      唯一分歧需 `rootPath === ""`（入口归一化后不可达）
- [ ] 4.3 **不写**无法区分两种实现的行为断言 —— 空断言比注释更糟

## 5. 验证

- [ ] 5.1 §9 每条 wire 路径绝对且以 `rootPath` 为基准（非 `process.cwd()`），各自保持层级；
      绝对路径原样透传
- [ ] 5.2 §10 一个文件一个字符串：location 与其后的 `fs/*` 请求一致；幂等；`..` / `//` 折叠；
      空 root 不触 `process.cwd()`
- [ ] 5.3 §10 绝对性按**文件系统的方式**判定（不落在 `<root>/` 之下），并按 POSIX / 盘符 / UNC
      三种输入各测一次 —— 断言**不得复用实现内部谓词**
- [ ] 5.4 §11 `rename` 门控是能力级（`.agents/**` 也在内）；两个入口都经 `resolveRoot`
      （源码级断言：入口必须出现 `resolveRoot(`，且不得保留裸 `options.<root> ?? ` 回退）
- [ ] 5.5 §11 **自包含**：不驱动完整 `bootstrapLocalAcp`（会触发 models.dev 查找，
      0.8s cached / 4.9s uncached，且依赖机器上的 model 配置 —— 干净检出会失败）
- [ ] 5.6 逐处**独立**变异验证：去掉每一处修复后必须有断言真 FAIL
      （wire 侧解析 → 3 条 + §10 交叉断言；`resolveRoot`/入口裸回退 → 6 条）
- [ ] 5.7 新增断言若在旧实现下仍 ALL PASSED，即**真空断言**，删除
- [ ] 5.8 `.agents/**` 本地写失去原子替换这一代价写进 README 与 spec（已验证 else 分支不丢数据）
