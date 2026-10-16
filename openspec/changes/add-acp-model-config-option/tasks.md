# Tasks — add-acp-model-config-option

## 1. 广告模型选择器（`packages/acp/src/agent.ts`）

- [ ] 1.1 新增 `AcpModelCatalogEntry { index, style, baseURL, apiKey?, models[] }` 与
      `AcpAgentOptions.modelCatalog?: AcpModelCatalogEntry[]`（可选 —— 无 `models.json` 时缺席）
- [ ] 1.2 新增 `applyModel(bridge, value)`：解析 `"<entryIndex>:<model>"` → `resolveModelInfoFromModelsDev`
      → dispatch `model.set`（带 entry 的 `modelStyle` / `modelBaseURL` / `modelApiKey` 与 `modelInfo`）
      → **回读快照**（成功后才更新 `lastAdvertisedConfigModel`）
- [ ] 1.3 抽 `sessionConfigOptions(snapshot, catalog)`：mode 项保持既有形状；catalog 存在时在其**前**插入
      model 项；`currentValue` 不在目录中时作为**首项**补入 `options`
- [ ] 1.4 `session/new` 与 `session/fork` 的响应改用新签名
- [ ] 1.5 `applyMode` 里补发的 `config_option_update` 改为发送**完整**选项集（此前只有 mode 项）
- [ ] 1.6 `set_config_option`：以 `configId` 在声明集中查得**该选项**，按其 `category` 分派
      （`mode` → `applyMode`；`model` → `applyModel`）；未处理的 category 显式报错，
      MUST NOT 退回「把值当 mode」
- [ ] 1.7 `mode` 值的校验仍在 `applyMode` 内（未知 mode 仍然报错，行为不变）
- [ ] 1.8 从未声明的 `configId` 仍显式拒绝（既有行为，回归断言保护）

## 2. 传递目录（`packages/acp/src/bootstrap.ts`）

- [ ] 2.1 `LocalAcpBootstrap` 增 `modelCatalog?`：`loadModels({kind:"file"})` 成功后按 entry 建目录
      （`index` / `style` / `baseURL` / `apiKey` / `models`）
- [ ] 2.2 `bootstrapAcpAgent` 透传到 `AcpAgentOptions.modelCatalog`
- [ ] 2.3 显式 `--model` flags 路径**不**产生目录（与「跳过 models.json」的既有约定一致）
- [ ] 2.4 `.env` 回退路径**不**产生目录

## 3. 验证（`packages/acp/scripts/validate-acp-catalog.mjs`）

- [ ] 3.1 `session/new` 广告集含 `category: "model"` 的 select，且 `mode` 项仍在
- [ ] 3.2 模型项 `currentValue` 恒等于会话当前模型，**且是该选项 `options` 的成员**（协议硬要求）
- [ ] 3.3 选项值编码 entry：目录有多 entry 且同名模型时，两者取值不同
- [ ] 3.4 无目录（flags 路径）时**不广告**模型项，且 `mode` 项不受影响
- [ ] 3.5 `set_config_option(configId:"model")` 真的切换了会话模型（回读快照）
- [ ] 3.6 切换**连带连接**：换成另一 entry 的模型后，会话的 `modelBaseURL` 随之改变
- [ ] 3.7 响应含**完整**选项集，且模型项 `currentValue` = 会话实际模型
- [ ] 3.8 `config_option_update` 携带**完整**选项集（含模型项），非只有 mode 项
- [ ] 3.9 未知模型值被拒绝，且会话模型**未被改变**
- [ ] 3.10 未声明的 `configId` 仍被拒绝（回归）
- [ ] 3.11 `session/fork` 同样广告模型项
- [ ] 3.12 变异验证：逐条篡改 `dist` 确认断言会失败（锚点须显式指名 hashed chunk）

## 4. 文档

- [ ] 4.1 `packages/acp/README.md`：记录模型选择器（`category: "model"`）与「换模型即换 provider 连接」
- [ ] 4.2 `packages/acp/README.md`：Known limitations 补 `load`/`resume` 不下发 `configOptions`
- [ ] 4.3 `openspec validate add-acp-model-config-option --strict` 通过

## 5. 门禁（串行，不与 build 并发）

- [ ] 5.1 `pnpm build`
- [ ] 5.2 `pnpm lint` / `pnpm typecheck`
- [ ] 5.3 `pnpm --filter @codent/app test`
- [ ] 5.4 `node scripts/run-all-validators.mjs --all`
- [ ] 5.5 `pnpm --filter @codent/acp run validate:acp`
- [ ] 5.6 `npx openspec validate --changes --strict` / `--specs --strict`
