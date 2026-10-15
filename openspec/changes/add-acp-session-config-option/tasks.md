## 1. 实现

- [x] 1.1 `packages/acp/src/agent.ts`：抽出 `applyMode(bridge, mode)`（校验 mode → `mode.set` 分发 → 回读快照 → 必要时补发 `config_option_update`），`session/set_mode` 改为调用它（对外行为不变）
- [x] 1.2 `packages/acp/src/agent.ts`：注册 `session/set_config_option` —— 按 `configId` 在当前声明的选项集中查找（查表，非硬编码）；未找到即抛错；`value` 经 `applyMode` 应用
- [x] 1.3 `packages/acp/src/agent.ts`：会话不存在（无 live bridge）时抛错，与 `session/delete` 的显式拒绝一致
- [x] 1.4 响应回**完整**选项集（协议要求必填），取自会话实际状态

## 2. 验证（`packages/acp/scripts/validate-acp-catalog.mjs`）

- [x] 2.1 广告过的 `configId` 可写回：模式真的变了
- [x] 2.2 响应含完整选项集，且 `category: "mode"` 项等于会话实际模式
- [x] 2.3 两个入口等价：同一模式经 `set_config_option` 与 `set_mode` 切换，产生的 `config_option_update` **逐字段相同**
- [x] 2.4 未声明的 `configId` 被拒绝，且模式未被改变
- [x] 2.5 不存在的 `sessionId` 被拒绝（不是静默成功）
- [x] 2.6 已是该模式时不再重复广播
- [x] 2.7 变异验证：逐条篡改 `dist` 确认断言会失败（守卫锚点须显式指名 hashed chunk）

## 3. 文档与提案

- [x] 3.1 归档基线 `acp-session-catalog` 的「会话配置选项下发」加入写回要求（本 change 的 delta）
- [x] 3.2 `packages/acp/README.md` 能力表补 `session/set_config_option` 行
- [x] 3.3 `openspec validate add-acp-session-config-option --strict` 通过

## 4. 顺带修复（根文档缺口，非本 change 引入）

- [x] 4.1 `packages/core/ARCHITECTURE.md:169`：`host.bind(agentId)` 是**幽灵方法**（`AgentSessionHost` 只有 `create` / `connect` / `list` / `destroy` 及可选的 `listPersistedSessions` / `deleteSession`）——改为指向真实寻址面
- [x] 4.2 `AGENTS.md` 的 `CoreEnv` 接口块：补 `cwd()`，并把 `// Optional:` 清单一并补全（`execFile`、`appendFile`、`rename`、`startCommand`、`getShellInfo`）

## 5. 跟进项（本 change 不做，先记录）

- [x] 5.1 `session/set_mode` 对**不存在的会话**静默返回 `{}`（报告成功），与 `fork` / `delete` / `prompt` 的显式拒绝不一致——属既有行为，改动会影响既有客户端，留待独立跟进
