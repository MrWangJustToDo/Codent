# Tasks — add-acp-model-config-option

## 1. 广告模型选择器（`packages/acp/src/agent.ts`）

- [x] 1.1 新增 `AcpModelCatalogEntry { index, style, baseURL, apiKey?, models[] }` 与
      `AcpAgentOptions.modelCatalog?: AcpModelCatalogEntry[]`（可选 —— 无 `models.json` 时缺席）
- [x] 1.2 新增 `applyModel(bridge, value)`：解析 `"<entryIndex>:<model>"` → `resolveModelInfoFromModelsDev`
      → dispatch `model.set`（带 entry 的 `modelStyle` / `modelBaseURL` / `modelApiKey` 与 `modelInfo`）
      → **回读快照**（成功后才更新 `lastAdvertisedConfigModel`）
- [x] 1.3 抽 `sessionConfigOptions(snapshot, catalog)`：mode 项保持既有形状；catalog 存在时在其**前**插入
      model 项；`currentValue` 不在目录中时作为**首项**补入 `options`
- [x] 1.4 `session/new` 与 `session/fork` 的响应改用新签名
- [x] 1.5 `applyMode` 里补发的 `config_option_update` 改为发送**完整**选项集（此前只有 mode 项）
- [x] 1.6 `set_config_option`：以 `configId` 在声明集中查得**该选项**，按其 `category` 分派
      （`mode` → `applyMode`；`model` → `applyModel`）；未处理的 category 显式报错，
      MUST NOT 退回「把值当 mode」
- [x] 1.7 `mode` 值的校验仍在 `applyMode` 内（未知 mode 仍然报错，行为不变）
- [x] 1.8 从未声明的 `configId` 仍显式拒绝（既有行为，回归断言保护）

## 2. 传递目录（`packages/acp/src/bootstrap.ts`）

- [x] 2.1 `LocalAcpBootstrap` 增 `modelCatalog?`：`loadModels({kind:"file"})` 成功后按 entry 建目录
      （`index` / `style` / `baseURL` / `apiKey` / `models`）
- [x] 2.2 `bootstrapAcpAgent` 透传到 `AcpAgentOptions.modelCatalog`
- [x] 2.3 显式 `--model` flags 路径**不**产生目录（与「跳过 models.json」的既有约定一致）
- [x] 2.4 `.env` 回退路径**不**产生目录

## 3. 验证（`packages/acp/scripts/validate-acp-catalog.mjs`）

- [x] 3.1 `session/new` 广告集含 `category: "model"` 的 select，且 `mode` 项仍在
- [x] 3.2 模型项 `currentValue` 恒等于会话当前模型，**且是该选项 `options` 的成员**（协议硬要求）
- [x] 3.3 选项值编码 entry：目录有多 entry 且同名模型时，两者取值不同
- [x] 3.4 无目录（flags 路径）时**不广告**模型项，且 `mode` 项不受影响
- [x] 3.5 `set_config_option(configId:"model")` 真的切换了会话模型（回读快照）
- [x] 3.6 切换**连带连接**：换成另一 entry 的模型后，会话的 `modelBaseURL` 随之改变
- [x] 3.7 响应含**完整**选项集，且模型项 `currentValue` = 会话实际模型
- [x] 3.8 `config_option_update` 携带**完整**选项集（含模型项），非只有 mode 项
- [x] 3.9 未知模型值被拒绝，且会话模型**未被改变**
- [x] 3.10 未声明的 `configId` 仍被拒绝（回归）
- [x] 3.11 `session/fork` 同样广告模型项
- [x] 3.12 变异验证：逐条篡改 `dist` 确认断言会失败（锚点须显式指名 hashed chunk）
      结果 M1=4 · M2=1 · M3=1 · M4=4 · M5=3 · M6=4 · M7=6 · M9=2 · M10=2 · M11=6；
      M5/M8 首轮以未处理异常崩溃（exit≠0 且 FAIL=0，会被误读为"断言没牙"）⇒ 已把
      `session/new` 与写回请求包进 try/catch，改为干净 FAIL
- [x] 3.13 **实现期发现的真 bug**：`resolveModelInfoFromModelsDev` 在 models.dev 不可达且无缓存时
      **抛异常**，使整个模型切换失败 —— 而切换本不需要 metadata。已按 core 既有约定改为
      best-effort（catch → `undefined` = "unknown"），并断言"无 metadata 也能切换" 

## 4. 文档

- [x] 4.1 `packages/acp/README.md`：记录模型选择器（`category: "model"`）与「换模型即换 provider 连接」
- [x] 4.2 `packages/acp/README.md`：Known limitations 补 `load`/`resume` 不下发 `configOptions`
- [x] 4.3 `openspec validate add-acp-model-config-option --strict` 通过

## 5. 规模（项目规则：抽代码而非豁免 max-lines 800）

- [x] 5.1 `agent.ts` 由 792 → 968 非空行（超限）⇒ 抽出两个内聚模块，回到 704
- [x] 5.2 `packages/acp/src/session-config-options.ts`（新）：模型/模式选项的构造 + 两条写回通路
- [x] 5.3 `packages/acp/src/interactions.ts`（新）：permission / elicitation 两个 client 往返
      （`askUserOutput` 原样搬运，保持 `askUserOutputSchema` 契约）

## 6. 门禁（串行，不与 build 并发）

- [x] 5.1 `pnpm build`
- [x] 5.2 `pnpm lint` / `pnpm typecheck`
- [x] 5.3 `pnpm --filter @codent/app test`
- [x] 5.4 `node scripts/run-all-validators.mjs --all`
- [x] 5.5 `pnpm --filter @codent/acp run validate:acp`
- [x] 5.6 `npx openspec validate --changes --strict` / `--specs --strict`
