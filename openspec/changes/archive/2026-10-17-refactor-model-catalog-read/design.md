## Context

Model resolution already has one pipeline: `packages/core/src/models/config/models-config.ts` exposes
`loadModels({ kind: "file" | "provider" | "session" })` and `LoadedModelsState { config, entries, active }`.
The `provider` kind asks `GET /api/provider/info` and builds the entry the client needs — proxy `baseURL`,
a sentinel key, and a selectable list assembled from the server's `models.json` ids, its recorded active
model, and the model it actually serves (`servedModel`).

Who reads it varies by host:

| host | how it reads | catalog? |
|---|---|---|
| TUI (`@codent/app` + release host) | `loadModels(...)` through the adapter | yes, including provider |
| ACP (`bootstrapLocalAcp`) | `loadModels({ kind: "file" })` for the file plane; **`createRemoteProvider` + `resolveModelConfigFromProvider`** for the provider plane | **no** on the provider plane |

The ACP host then passes whatever it has to `createAcpAgent` as `modelCatalog` / `modelCatalogActiveIndex`,
and `sessionConfigOptions` / `legacySessionModelState` / `applyModel` take it as an argument. So the
"available models" question is answered by (a) the pipeline for the TUI, (b) the ACP bootstrap for ACP, and
(c) a fallback inside the connection layer when (b) has nothing. Three places for one question — and the
fallback (a single fixed, non-switchable value) is what a `--remote-provider` user sees.

Constraints:

- `CodentAgent` already owns `env` + `provider` + `AgentSessionHost`; hosts receive it as
  `AgentRuntimePort`. A runtime read is therefore available where it is needed.
- The remote-session plane has no local provider at all, yet a client can still choose a model from the
  server (`/api/agent/models`) — so the read cannot live on `ModelProvider` alone.
- `loadModels` is async and must run before the runtime is created (it also registers the provider).

## Goals / Non-Goals

**Goals:**

- One read of "which models are available, and which is active", owned by the runtime instance.
- Hosts project that read; no host re-derives or fills gaps.
- `--remote-provider` exposes its real selectable list (and switching is validated against it).
- Delete the "no catalog ⇒ fixed single value" fallback and its assertions.
- Keep the legacy `models` field / `session/set_model` served from the same read.

**Non-Goals:**

- No change to `loadModels`' resolution rules or to the provider proxy.
- No new model plane; no per-session overrides beyond the existing `model.set`.
- Not converging `CoreEnv` reads (they already are, through the runtime's `env`).
- The app's model-editing UX (`/models` writer, settings) is unchanged except for its read source.

## Decisions

**D1 — The read lives on `CodentAgent` (`readModels()`), not on `ModelProvider`.**
A remote-session runtime has no local provider but still has a selectable list; a provider has a connection
but not a catalog (the list is assembled by the pipeline). The runtime is the only object both hosts
already hold. *Alternative considered:* `ModelProvider.readCatalog()` — rejected: unusable for
remote-session and it would put list assembly in the provider.

**D2 — The runtime carries the read; it does not resolve it.**
`CodentAgent.create({ models })` takes the `loadModels` result and `readModels()` returns it. Re-resolving
inside the runtime would create a second pipeline (the exact failure being removed), and would re-fetch
`/api/provider/info` per session. *Alternative:* lazy resolution on first `readModels()` — rejected for the
same reason; the read is known at bootstrap time.

**D3 — The ACP bootstrap calls the one pipeline for every plane.**
`bootstrapLocalAcp` becomes: pick the source (`file` / `provider` / `session`), `loadModels(source)`, create
the runtime with the result. Its bespoke provider branch and the `modelCatalog*` fields in
`LocalAcpBootstrap` / `AcpAgentOptions` are removed (**BREAKING** for embedders of `createAcpAgent`, which is
internal-first; the release host builds the runtime itself).

**D4 — The connection layer projects, never filters.**
`sessionConfigOptions`, `legacySessionModelState`, `applyModel` and the two write paths take the runtime
read (or the bridge's runtime) instead of a catalog argument. The invariant that makes the fallback
unnecessary — the active model is always a member of its entry's list — is guaranteed by the pipeline
(it already lists the served/active model); it is asserted there, not re-checked by every reader.

**D5 — Remote-provider selection stays on the per-session path.**
Switching still dispatches `model.set` with the chosen entry's `style` / `baseURL` / `apiKey`; for a
provider entry that is the proxy baseURL + sentinel key, so no process-global provider is registered and one
session's switch cannot leak into another (`acp-session-catalog` already requires this).

**D6 — Legacy surfaces read the same result.**
`models` (legacy field) and `session/set_model` are projections of the same read, so a client reading either
surface names the same model ids in the same order. This is documented in the delta instead of being an
undocumented extra.

## Risks / Trade-offs

- **A provider entry's `models` list is derived from the server's `models.json` + served model, which can be
  stale relative to the server's live selection.** → It is the same list the TUI already trusts, and a
  switch is validated by `model.set` on the server side; a mismatch surfaces as a refused switch, not as a
  silent wrong model.
- **`model.set` to another model within the same remote entry re-sends the proxy baseURL + sentinel key.**
  → Same values the entry already carries; asserted by the existing "no process-global provider" gate.
- **Removing `AcpAgentOptions.modelCatalog*` breaks out-of-repo embedders.** → Marked BREAKING; the release
  host is the only in-repo caller and builds the runtime itself.
- **Two runtime instances with different provider planes** → Each carries its own read, which is the
  property `agent-runtime-instances` already requires for `env` / `ModelProvider`.

## Migration Plan

1. `core`: add the read shape export + `CodentAgent.create({ models })` + `readModels()`; keep every
   existing caller working (`models` optional; when absent, `readModels()` returns `undefined` and the ACP
   host keeps its current behaviour until it migrates).
2. `core` validator: assert the `provider` and `session` planes produce a list that contains the active
   model (the invariant D4 depends on).
3. `acp`: bootstrap → one `loadModels` call; pass `models` to the runtime; remove `modelCatalog*` from the
   options and the return.
4. `acp`: selectors + write paths read `bridge.runtime.readModels()`; delete `fixedModelOption` and the
   `applyModel` no-catalog branch; update `validate-acp-catalog.mjs` / `validate-acp-projection.mjs` (the
   "no catalog" scenarios become "provider lists", "flags/`.env` single value").
5. `app`: `AgentRuntimePort.readModels()`; `/models` reads it.
6. Docs: `acp-session-catalog` delta (selectors from the runtime; provider selectable; legacy surfaces) and
   `agent-runtime-instances` (the read member).

Rollback: the change is additive first (step 1), so reverting steps 3-5 returns the ACP host to the
bootstrap-supplied catalog without touching `core`.
