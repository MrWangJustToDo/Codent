## Why

"Which models are available?" has two answers today. The TUI reads it through the shared pipeline
(`loadModels` in `core/models/config/models-config.ts`), which builds an entry per plane — including the
remote-provider plane, where it lists the server's `models.json` ids plus the model the server actually
serves. The ACP bootstrap does **not** use that pipeline on the remote-provider path: it calls
`createRemoteProvider` + `resolveModelConfigFromProvider` directly, gets a connection and no catalog, and
the connection side (`sessionConfigOptions`) therefore had to invent a fallback — one fixed, non-switchable
model — to avoid showing nothing at all.

That is the wrong seam. A read that both hosts need belongs on the runtime instance, next to `env` and the
message store, so a host **projects** it instead of re-deriving it. Two consequences of the current split
were reported: `--remote-provider` cannot switch models (the list is a single value the host cannot
validate against), and the ACP host carries catalog plumbing (`modelCatalog` / `modelCatalogActiveIndex`
options threaded from bootstrap) that every new plane has to be taught about.

## What Changes

- **`CodentAgent` carries and exposes the resolved model read.** `CodentAgent.create({ models })` accepts
  the result of one `loadModels(...)` call and `runtime.readModels()` returns it (entries + active +
  each entry's selectable list). The runtime **carries** the read; it does not resolve it a second time.
- **The ACP bootstrap uses the one pipeline for every plane.** `bootstrapLocalAcp` calls
  `loadModels({ kind: "file" | "provider" | "session", ... })` instead of branching on
  `--remote-provider`; its bespoke `createRemoteProvider` + `resolveModelConfigFromProvider` branch goes
  away, and it stops returning `modelCatalog` / `modelCatalogActiveIndex`.
- **The ACP host reads from its runtime.** `sessionConfigOptions`, `legacySessionModelState`,
  `applyModel`, `session/set_config_option` and the legacy `session/set_model` all read
  `bridge.runtime.readModels()`; the "no catalog ⇒ one fixed value" fallback is deleted, because the read
  always contains the active model by construction.
- **The app reads the same member.** `AgentRuntimePort` gains `readModels()`, and `/models` projects it, so
  TUI and ACP cannot disagree.
- **BREAKING (embedders of `createAcpAgent`)**: `AcpAgentOptions.modelCatalog` /
  `modelCatalogActiveIndex` are removed; the catalog comes from the runtime the host builds.
- **Behaviour fixed**: under `--remote-provider` the model selector lists what the provider serves (its
  `models.json` ids, its active model, and the served model) and switching is validated against that list,
  instead of a single unsupported value.

## Capabilities

### New Capabilities

- (none — the read is a member of an existing capability)

### Modified Capabilities

- `agent-runtime-instances`: the runtime carries the resolved model read and exposes it (new requirement:
  one read, no host-side re-derivation; remote-session runtimes expose the server's list).
- `acp-session-catalog`: the model selector's source becomes the runtime read; the "no catalog ⇒ omit"
  rule is replaced (provider plane lists the served models; flags/`.env` expose one fixed value); the
  legacy `models` field and `session/set_model` are documented as reading the same result; `session/load`
  and `session/resume` responses carry the selectors (drift from the earlier change, fixed here).

## Impact

- `packages/core/src/runtime/codent-agent.ts` (options + `readModels()`), `models/config/models-config.ts`
  (exported read shape; no behaviour change).
- `packages/acp/src/bootstrap.ts` (one pipeline call; no catalog in the return), `agent.ts` (selectors /
  write paths read the runtime; drop the two options), `session-config-options.ts` (delete
  `fixedModelOption`; take the read), `session-status.ts` (`sessionSelectors` takes the read).
- `packages/app/src/adapter/types.ts` (`AgentRuntimePort.readModels()`), `commands/models.ts`.
- Validators: `validate-acp-catalog.mjs`, `validate-acp-projection.mjs`, plus a core assertion that the
  provider/session planes always include the active model in their list.
- Specs: `agent-runtime-instances`, `acp-session-catalog`.
