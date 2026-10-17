## 1. Core: the runtime carries the read

- [x] 1.1 Export the model-read shape from `models/config/models-config.ts` (entries + active + each entry's
      selectable models, aliasing `LoadedModelsState` rather than inventing a second type).
- [x] 1.2 `CodentAgentOptions.models?: <read>` + `CodentAgent.readModels()` returning it unchanged
      (`undefined` when not supplied); document that the runtime carries, never resolves.
- [x] 1.3 Thread the read through `createLocalAgentSessionHost` / the runtime surface exposed to hosts as
      `AgentRuntimePort` (no behaviour change for existing callers).
- [x] 1.4 Read-surface assertions in `validate-agent-runtime-instances.mjs`: `readModels()` returns the
      SAME read it was created with (carried, not re-resolved), `undefined` when none was supplied, and two
      runtimes do not share one.
- [x] 1.5 Pipeline-invariant assertion (an entry's list contains its active model) for the `provider` and
      `session` planes, against a mock `/api/provider/info` — lands with 5.1 where that mock exists.

## 2. ACP: one pipeline at bootstrap

- [x] 2.1 `bootstrapLocalAcp` picks a source (`file` / `provider` / `session`) and calls `loadModels` ONCE;
      delete the bespoke `createRemoteProvider` + `resolveModelConfigFromProvider` branch.
- [x] 2.2 Pass the read into `CodentAgent.create({ env, models })`; remove `modelCatalog` /
      `modelCatalogActiveIndex` from `LocalAcpBootstrap` and `AcpAgentOptions` (**BREAKING** for embedders —
      note it in the acp README).
- [x] 2.3 Keep the "no model configured" error path unchanged (`loadModels` returning nothing still throws
      with the same message).

## 3. ACP: the connection layer projects the runtime read

- [x] 3.1 `sessionConfigOptions` / `legacySessionModelState` take the read (not a `catalog` array); delete
      `fixedModelOption`.
- [x] 3.2 `applyModel`, `session/set_config_option` and the legacy `session/set_model` validate against the
      same read (展示与写入同源); delete the `no catalog` refusal branch that only existed for the missing
      list.
- [x] 3.3 `sessionSelectors` reads `bridge.runtime.readModels()`; all four session-creating responses
      (`new` / `load` / `resume` / `fork`) carry the same selectors.
- [x] 3.4 Legacy `models` field keeps matching the model option exactly (ids, order, current value).

## 4. App: read through the port

- [x] 4.1 `AgentRuntimePort.readModels()` (optional member; hosts that cannot supply it degrade to today's
      behaviour).
- [x] 4.2 `/models` and the model selector project it instead of calling `loadModels` a second time.

## 5. Gates, docs, and verification

- [x] 5.1 `validate-acp-catalog.mjs`: file plane lists every model; provider plane lists the server's set
      (mock `/api/provider/info`); flags/`.env` plane yields ONE fixed value (and a write is refused);
      legacy `models` matches the config option on every plane.
- [x] 5.2 `validate-acp-projection.mjs`: the `session/new` response check follows the same three planes
      (replace the current "no catalog ⇒ drop the option" expectation).
- [x] 5.3 Mutation-check each new assertion (revert per-step/projection change → the specific check fails).
- [x] 5.4 Update `packages/acp/README.md` (model resolution + breakage note) and the two spec deltas land in
      `openspec/specs/` at archive time.
- [x] 5.5 Full verification: `pnpm --filter @codent/acp run validate:acp` (all scripts), `pnpm build:codent`,
      a real `--remote-provider` smoke (selector lists the served models, a switch takes effect).
