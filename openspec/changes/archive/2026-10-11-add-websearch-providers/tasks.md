## 1. Provider registry foundation

- [x] 1.1 Add `agent/tools/websearch/registry.ts` exporting a `PROVIDER_REGISTRY` table (`{ name, create }` per provider), a key-wiring map in `key-fields.ts`, and a session-hash helper (`hashToIndex`) for free-provider spreading
- [x] 1.2 Extend `WebsearchToolConfig` (`agent/tools/tool-config.ts`) with `exaApiKey`, `parallelApiKey`, `tavilyApiKey` (keep `braveApiKey`, `provider`)
- [x] 1.3 Refactor `ProviderManager.configure` (`provider.ts`) to store a per-provider key map (driven by `PROVIDER_KEY_FIELDS`, no per-provider switch) + preferred provider + session id; add a `sessionId?` option to `SearchOptions` and `setSessionId` on the manager
- [x] 1.4 Build registrations from the registry in `websearch/index.ts` (replace the hardcoded `pm.register(...)` calls); keep order Brave → Parallel → Exa → Tavily → DuckDuckGo
- [x] 1.5 Implement selection: explicit available provider → available provider with a configured key (keyed wins the free pool) → free-provider session hash (when >1 available) → first available → last registered; never pick an unavailable provider

## 2. Selection & fallback behavior

- [x] 2.1 Verify `ProviderManager.search` fallback walks registration order and reports the succeeding provider name (preserve the abort short-circuit at `provider.ts:94`)
- [x] 2.2 Thread the session id from `createWebsearchTool` (via `managed`/session context) into the manager so hashing is stable per session
- [x] 2.3 Keep timeout-vs-abort semantics: a provider timeout still falls back; a run abort still does not

## 3. New providers

- [x] 3.1 Add `providers/parallel.ts` — public MCP `https://search.parallel.ai/mcp`, tool `web_search`; free transport; optional `PARALLEL_API_KEY` → official API
- [x] 3.2 Add `providers/tavily.ts` — official MCP/REST, requires `TAVILY_API_KEY`; `isAvailable()` false without a key
- [x] 3.3 Convert `providers/exa.ts` to dual transport: `EXA_API_KEY` → official API, no key → public MCP (existing behavior unchanged when no key)
- [x] 3.4 Confirm the live Parallel MCP request/response shape (tool name + arguments) with a real probe before finalizing 3.1; adjust the parser to the observed payload
- [x] 3.5 Reuse `filterResultsByDomain` + `maxResults` slicing in both new providers so they honor allow/block lists identically

## 4. Configuration plumbing

- [x] 4.1 Rename `ModelsConfigGlobal.toolConfig.websearchProvider` → `provider` in `models-config.ts` schema + type; accept legacy `websearchProvider` on read and map to `provider`
- [x] 4.2 Update `packages/app/src/utils/merge-models-config.ts` (and its test/validator) for the renamed key so editing/saving preserves it
- [x] 4.3 Apply `models.json` `global.toolConfig` in `useConfig.init` (`packages/app/src/hooks/use-config.ts:83`) — merge under the host value per field, before agent creation
- [x] 4.4 Extend the CLI env path (`packages/cli/src/args.ts:141`, and `packages/codent/src/args.ts`) to read `EXA_API_KEY` / `PARALLEL_API_KEY` / `TAVILY_API_KEY` into `toolConfig.websearch`
- [x] 4.5 Confirm precedence end to end: CLI/env > `models.json` > defaults, applied per field

## 5. Remote-session passthrough

- [x] 5.1 Add optional `toolConfig` to `createBodySchema` in `packages/server/src/routes/agent-session.ts:169`
- [x] 5.2 Forward `toolConfig` into `host.create` at the create call site (`agent-session.ts:325`) when present
- [x] 5.3 Verify the field is never echoed into snapshots and that keys are not leaked by existing sanitizers

## 6. Validation & docs

- [x] 6.1 Extend `packages/core/scripts/validate-websearch-providers.mjs`: registry order, free spreading determinism, keyed-vs-free transport selection, Tavily unavailable without key, abort short-circuit (keep existing assertions)
- [x] 6.2 Add a negative-patch check per the repo's assertion convention: deleting a provider from the registry / breaking the spread must make the validator fail on the specific assertion
- [x] 6.3 Update `packages/codent/README.md` env-var docs (`EXA_API_KEY` / `PARALLEL_API_KEY` / `TAVILY_API_KEY`, `WEBSEARCH_PROVIDER`) and the tool description in `websearch-tool.ts:84`
- [x] 6.4 Run `pnpm build && pnpm --filter @codent/core run validate:websearch-providers`, `pnpm typecheck`, and `pnpm --filter @codent/app test`
- [x] 6.5 `openspec validate add-websearch-providers --strict` and archive when implementation lands

## 7. Audit remediation

- [x] 7.1 Keyed providers win auto-selection (the free-provider spread must exclude explicit/keyed providers); spec R3 + validator updated
- [x] 7.2 MCP `result.isError` must throw in `mcp-client.ts` (`parseMcpResponse`) so the manager falls back instead of reporting a successful empty search
- [x] 7.3 `remote-session-host` must forward `toolConfig` in the create body (threading alone did not send it)
- [x] 7.4 Subagent websearch `sessionId` falls back to `managed.id` (subagents have no session data), so Parallel still receives `session_id`
- [x] 7.5 Legacy `websearchProvider` rewritten to `provider` on save (`normalizeRawGlobalToolConfig` in the app's edit path)
- [x] 7.6 Key wiring driven by one `PROVIDER_KEY_FIELDS` map (registry `keyField` dead metadata removed)
- [x] 7.7 Redact `toolConfig`/`apiKey` from `AGENT_SESSION_DEBUG=1` request logging; drop dead `parseExaResponse`; root `README.md` Web row updated
- [x] 7.8 Negative-patch harness (`negative-patch-websearch.sh`) with `set -e`/trap, 12 proven mutations, and a CI step (`ci.yml`) that runs it; new server validator `validate:websearch-tool-config`
- [x] 7.9 `validate:core-no-env-config` extended to the new provider key names; provider comments no longer name env vars
