## Why

The `websearch` tool's only reliable free provider is one unauthenticated public MCP endpoint
(Exa), so when that endpoint is rate-limited or blocked the tool degrades all the way to
DuckDuckGo HTML scraping — the failure mode that started this work. Separately, websearch
configuration is half-wired: `.agents/config/models.json`'s `global.toolConfig` is inert (no
runtime reader, and its `websearchProvider` key does not match the runtime `provider`), no
per-provider API keys are honored, and the remote-session plane (`POST /api/agent`) drops
`toolConfig` entirely, so `--remote-session` cannot carry a key or a provider choice.

## What Changes

- **New providers.** Add a **Parallel** provider (free public MCP endpoint, no key) and a
  **Tavily** provider (official MCP/REST, key required). Both become selectable with the
  existing automatic fallback.
- **Multiple free providers with quota spreading.** With more than one free no-key provider,
  auto-selection deterministically spreads sessions across them (hash of `sessionId`) instead
  of always hammering the first one, while an explicit preference still wins. In a single
  interactive session this stays contiguous until a call actually fails.
- **Provider key registry.** Honor `EXA_API_KEY`, `PARALLEL_API_KEY`, and `TAVILY_API_KEY`. A
  key selects that provider's official API transport; without a key the provider falls back to
  its public MCP endpoint (Exa/Parallel) or stays unavailable (Tavily).
- **Provider registry module.** Refactor the provider layer to a registry with per-provider
  metadata (name, key builder, free/keyed transport, availability), so adding a provider is a
  single module plus a table entry rather than edits scattered across selection logic.
- **Config plumbing.** Make `global.toolConfig` from `.agents/config/models.json` actually
  reach `AgentToolConfig`, rename its `websearchProvider` key to `provider` (matching the
  runtime shape), and keep the existing `BRAVE_API_KEY` / `WEBSEARCH_PROVIDER` env path.
- **Remote-session passthrough.** Add `toolConfig` to the `POST /api/agent` create body and
  forward it to `host.create`, so a `--remote-session` client can bring websearch keys /
  provider preference to the server-side agent loop.
- **Not included:** a dedicated CLI flag for the provider (env + config file are enough), and
  a provider-hosted mode (using Anthropic's server-side `web_search` tool).

## Capabilities

### New Capabilities

- `websearch-providers`: the multi-provider websearch architecture — provider registry and
  metadata, transport selection (official API with a key vs public MCP without), selection
  order and free-quota spreading, failure fallback, and the configuration surface
  (env vars, `models.json` `global.toolConfig`, remote-session passthrough).

### Modified Capabilities

<!-- No existing capability's requirements change. `core-tool-layout` only fixes where the
     websearch provider modules live, not their behavior. -->

## Impact

- **Core** (`@codent/core`): `agent/tools/websearch/` (new `registry.ts`, `providers/parallel.ts`,
  `providers/tavily.ts`, edits to `providers/exa.ts` + `providers/brave.ts`, `provider.ts`,
  `index.ts`), `agent/tools/tool-config.ts`, `agent/tools/websearch-tool.ts`,
  `models/config/models-config.ts` (`global.toolConfig` schema/type).
- **App** (`@codent/app`): `hooks/use-config.ts` (apply file `toolConfig` onto `AppConfig`
  before agent creation), possibly `utils/merge-models-config.ts` (key rename).
- **Server** (`@codent/server`): `routes/agent-session.ts` (`createBodySchema` + `host.create`).
- **CLI / codent host**: no new flags; `args.ts` env parsing continues to work (optionally
  reads the new per-provider keys).
- **Scripts**: extend `packages/core/scripts/validate-websearch-providers.mjs`; register any
  new entry in `tsdown` if needed (provider modules are bundled through existing entries).
- **Dependencies:** none new — Parallel/Tavily are plain HTTP calls over `CoreEnv.fetch`.
