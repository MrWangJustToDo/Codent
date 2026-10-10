## Context

`websearch` currently registers three providers in a fixed order — `brave` (key required) →
`exa` (no key, public MCP at `https://mcp.exa.ai/mcp`) → `duckduckgo` (no key, HTML scrape) —
and `ProviderManager` selects "first available", falls back in registration order on failure,
and never surfaces which provider actually ran beyond the returned `provider` name
(`packages/core/src/agent/tools/websearch/provider.ts:50`, `:79`; registered in `index.ts:41`).

What drives this change:

- The free tier rests on a **single unauthenticated public MCP endpoint**. When it is
  rate-limited or blocked the tool falls back to DuckDuckGo HTML parsing, which is itself
  increasingly anti-bot challenged — the observed failure that motivated adding Exa.
- Configuration is **half-wired**. `models.json`'s `global.toolConfig` accepts
  `{ braveApiKey, websearchProvider }` (`models/config/models-config.ts:44`) but has no runtime
  reader, and its key name does not match the runtime `WebsearchToolConfig.provider`
  (`agent/tools/tool-config.ts:13`). No per-provider API keys (`EXA_API_KEY`, …) are honored.
  The only live producer is `BRAVE_API_KEY` / `WEBSEARCH_PROVIDER` in `packages/cli/src/args.ts:141`.
- The **remote-session plane drops tool config**: `POST /api/agent`'s `createBodySchema`
  (`packages/server/src/routes/agent-session.ts:169`) has no `toolConfig`, and `host.create`
  never receives one, so a `--remote-session` client cannot bring keys or a provider choice to
  the server-side loop.

Peer implementations confirm the shape we want: opencode's `websearch` is a client-side tool
hitting Exa/Parallel MCP endpoints, selecting a provider by explicit env override else
`checksum(sessionID) % 2`; Claude Code instead delegates to Anthropic's server-side
`web_search_20250305` (out of scope here).

## Goals / Non-Goals

**Goals:**

- Two new providers — **Parallel** (free public MCP, no key) and **Tavily** (official
  MCP/REST, key required) — selectable with automatic fallback.
- A **provider registry**: per-provider metadata (name, key builder, free vs keyed transport,
  availability) so a new provider is one module plus one table entry.
- **Multiple free providers** with deterministic quota spreading (hash of `sessionId`) when no
  explicit preference is set.
- Config that actually works: `global.toolConfig` reaches `AgentToolConfig`, `provider` is the
  single field name, per-provider keys are honored.
- `--remote-session` can carry `toolConfig` to the server.

**Non-Goals:**

- No new CLI flag (`--websearch-provider`): env var + `models.json` are sufficient surface.
- No provider-hosted mode (Anthropic server-side `web_search`); no streaming answer synthesis.
- No page-content extraction/answering. Providers still return `{title, url, snippet}`
  (`websearch/types.ts:9`); `webfetch` remains the page reader.
- No request-level load balancing across providers.

## Decisions

### Decision 1 — Static provider registry module, not dynamic plugins

Add `agent/tools/websearch/registry.ts` exporting a `PROVIDER_REGISTRY` table of metadata and
have `index.ts` build `ProviderManager` registrations from it. Each provider keeps its own
module under `providers/`.

- **Why:** the repo's conventions favor explicit, statically-imported modules (`createTools`
  assembles tools from static imports; built-in extensions are `createXxxExtension` with no
  dynamic loading). A registry table makes "add a provider" a data change, but stays greppable
  and bundler-friendly.
- **Alternatives considered:** dynamic `import()` discovery by filename (opencode's plugin
  dir) — rejected: invisible to bundlers, breaks the curated build, and the provider count is
  small and known. A heavyweight `SearchProviderPlugin` interface with lifecycle hooks —
  rejected as over-engineering (openspec "complexity triggers": no scale requirement).

Registry metadata per provider carries the facts selection needs without instantiating HTTP
clients. The key wiring is *not* on the registry row — it lives in one `PROVIDER_KEY_FIELDS`
map (`key-fields.ts`) that `ProviderManager.configure` reads, because `registry.ts` imports the
provider modules, which import `provider.ts`; a direct `provider.ts → registry.ts` edge would
close a module cycle, and duplicating the mapping in both places is exactly the drift this
change removes.

```ts
interface ProviderRegistration {
  name: string;              // "parallel" | "tavily" | ... (also the `provider` value)
  /** Build the SearchProvider for the configured transport. */
  create(): SearchProvider;
}

// key-fields.ts — the single key-wiring map, no per-provider switch anywhere else:
const PROVIDER_KEY_FIELDS: Record<string, keyof WebsearchToolConfig> = {
  brave: "braveApiKey", parallel: "parallelApiKey", exa: "exaApiKey", tavily: "tavilyApiKey",
};
```

### Decision 2 — One provider module serves both transports (keyed vs free)

A provider like Exa exposes **one** `SearchProvider` whose `search()` uses the official REST
API when a key is present and the public MCP endpoint otherwise. `isAvailable()` is true when
either transport exists (Exa/Parallel: always; Tavily: only with a key).

- **Why:** `ProviderManager` selects by name; two entries per provider would produce duplicate
  names and ambiguous fallback. One entry per provider keeps selection, listing, and the
  reported `provider` name coherent.
- **Alternatives considered:** separate `exa` and `exa-api` registrations — rejected: leaks
  transport into the user-visible provider namespace and doubles fallback targets.

### Decision 3 — Auto-selection: explicit → keyed → free-provider spread

Selection resolves to: **explicit `provider` (when available) → else an available provider with a
configured API key (keyed wins the free pool) → else, among available _free_ providers,
`hash(sessionId) % n` → else first available → else last-registered (DDG)**. Fallback-on-failure
still walks providers in registration order.

- **Why (keyed priority):** a configured key is a deliberate choice of the official, higher-quality
transport. Without this step first, the free-provider spread swallows it — the motivating bug:
with any session id set, a configured Brave key was never selected (`w/ brave key select ->
parallel`), so the key looked ignored.
- **Why (spreading):** this is structurally what opencode does, and it directly addresses the
  motivating failure (never depend on one free endpoint). Hashing is **deterministic per session**,
  so a single interactive session stays contiguous and does not re-shuffle mid-conversation; the
  observable effect is that different sessions use different free providers, spreading quota.
  Failures still hop to the next provider immediately.
- **Alternatives considered:** random or round-robin per call — rejected: churny, harder to
  reason about, and (round-robin) diverges from the `ProviderManager` "one selected provider +
  fallback" contract. Explicit-only selection (no spreading) — rejected: leaves the single
  free endpoint as the common case.
- **Caveat recorded in Risks:** a single long interactive session still concentrates on one
  free provider. That is accepted; the fallback chain is the safety net, and per-request
  balancing is a non-goal.

### Decision 4 — `provider` is the single config field name; `models.json` value wins

Rename `ModelsConfigGlobal.toolConfig.websearchProvider` → `provider` (schema + type +
round-trip writers), and **read `global.toolConfig` at agent creation**, merging it under the
host/CLI-provided `toolConfig`.

- Precedence: **CLI/env `toolConfig` > `models.json` `global.toolConfig` > defaults**, applied
  per field (a file that sets `provider: "parallel"` while the env sets a Brave key yields both).
- **Backward compatibility:** `parseModelsConfig` accepts a legacy `websearchProvider` key and
  maps it to `provider` on read, so existing files keep working; writers emit `provider` only.
- **Why merge rather than replace:** `toolConfig` already flows host → `AppConfig` → `Host.create`
  (`apply-app-config.ts:11` → `create-agent.ts:84` → `host-types.ts:44`). The gap is only that
  the file value never enters that path. Merging at the same place keeps one source of truth
  for "secrets and prefs" and avoids a second plumbing path.
- **Alternatives considered:** make `loadModels` return a separate `websearch` section and have
  `use-config.ts` apply it — equivalent but adds a field to `LoadedModelsState` that only
  websearch reads. Chosen the narrower merge.

### Decision 5 — Apply the file config in `useConfig.init` before agent creation

`useConfig.init` already runs the model pipeline (`use-config.ts:83`). It reads the loaded
`ModelsConfig.global.toolConfig` and merges it into `state.config.toolConfig` there, before
`adapter.initialize` builds the session. No change to the `Session`/`ManagedAgent` surface.

- **Why:** the config is loaded once at init and is available at the exact moment `toolConfig`
  must be finalized. Doing it later would race agent creation.

### Decision 6 — Remote-session passthrough on `POST /api/agent`

Add `toolConfig` to `createBodySchema` and forward it into `host.create` when present.

- **Why:** closes the parity gap; the server-side loop then has the same keys/prefs a local
  loop would. The field is the same `AgentToolConfig` shape already used by `host.create`.
- **Security note:** `toolConfig` carries API keys, so it must be treated like the model
  `apiKey` field already in the body (never echoed back in snapshots; `/api/env/vars` already
  strips `*_API_KEY`, `packages/server/.../env.ts:20`).
- **Alternatives considered:** a separate `POST /api/websearch/config` route — rejected: more
  surface, and it duplicates the create-time contract.

## Risks / Trade-offs

- **Public MCP endpoints are unofficial and can rate-limit/block without notice** → multiple
  free providers with fallback + optional API keys; DDG stays as the final fallback.
- **Hash spreading only operates across sessions** (see Decision 3) → accepted; the fallback
  chain covers a rate-limited endpoint within a session.
- **Key rename is user-visible in `models.json`** → legacy key still read; writers emit the new
  name; `merge-models-config` updated so editing/saving does not drop or duplicate it.
- **`toolConfig` now travels over HTTP** → keys land in server request bodies; documented and
  consistent with the existing `apiKey` field, never persisted into session snapshots.
- **Tavily without a key is unavailable** → `listProviders()` must report it unavailable rather
  than letting it be selected and throw; selection never picks an unavailable provider.
- **Registry indirection could drift from reality** (a provider added to the table but not
  exported, or a keyed provider missing from the key-wiring map) → `validate:websearch-providers`
  asserts registry order, the key-wiring map, and selection outcomes against the real
  `ProviderManager`; the negative-patch harness (`negative-patch-websearch.sh`) proves each
  assertion fails on its exact defect (keyed priority, spreading, isError, remote forward).

## Migration Plan

1. Land the registry + transport refactor with the existing three providers unchanged in
   behavior (no new provider yet) so selection/fallback tests stay green.
2. Add Parallel (free) and Tavily (keyed) modules + registry entries.
3. Add keyed API-key plumbing (`EXA_API_KEY` / `PARALLEL_API_KEY` / `TAVILY_API_KEY`) and the
   `models.json` field rename with legacy read.
4. Add remote-session `toolConfig` passthrough.
5. Rollback: each step is independently revertable; the provider registry and config merge add
   behavior only when the new keys/fields are present, so reverting is config-neutral.

## Open Questions

- ~~Parallel's exact public MCP tool name/argument shape~~ **RESOLVED (probe, 2026-10-10):** endpoint
  `https://search.parallel.ai/mcp`, tool `web_search`, required arguments `objective` (string) and
  `search_queries` (string[]); optional `session_id` / `model_name`. Results come back as a JSON
  string in the tool's text content: `{ results: [{ url, title, publish_date, excerpts: string[] }] }`.
  A keyed tier is the same endpoint with `?apiKey=<key>`.
- **Exa keyed transport:** the REST API is x402-paywalled (HTTP 402 without payment), so the keyed
  transport reuses the MCP endpoint with `?exaApiKey=<key>` rather than the REST API.
- **Tavily transport:** no free tier (401 without a key); its MCP endpoint requires a session
  handshake, so the implementation uses the REST API (`POST https://api.tavily.com/search`,
  `Authorization: Bearer`).
- Whether the free-quota hash should key on `sessionId` only or `sessionId + query-class`; start
  with `sessionId` and revisit if quota exhaustion is observed.
