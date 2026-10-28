/**
 * One websearch `toolConfig` mapping for every host.
 *
 * Two helpers live here now, and both used to exist per host — which is exactly how a key that
 * worked in the TUI (`BRAVE_API_KEY` → `toolConfig`) was dead over ACP, whose bootstrap only read
 * `models.json`:
 *
 * - `websearchToolConfigFromEnv`: env record → `{ websearch: { … } }` (CLI TUI + ACP).
 * - `mergeModelsConfigToolConfig`: file `global.toolConfig` merged UNDER the host value, per field.
 *
 * Run: pnpm --filter @codent/core run validate:websearch-tool-config
 */
import assert from "node:assert/strict";

import { mergeModelsConfigToolConfig, websearchToolConfigFromEnv } from "../dist/dev.mjs";

// ---------------------------------------------------------------------------
// 1. Env mapping — every key, and "nothing set" means no config at all
// ---------------------------------------------------------------------------

assert.equal(websearchToolConfigFromEnv({}), undefined, "no keys ⇒ no config (not an empty block)");

{
  const config = websearchToolConfigFromEnv({
    BRAVE_API_KEY: "brave",
    EXA_API_KEY: "exa",
    PARALLEL_API_KEY: "parallel",
    TAVILY_API_KEY: "tavily",
    WEBSEARCH_PROVIDER: "exa",
  });
  assert.deepEqual(
    config,
    {
      websearch: {
        braveApiKey: "brave",
        exaApiKey: "exa",
        parallelApiKey: "parallel",
        tavilyApiKey: "tavily",
        provider: "exa",
      },
    },
    "every documented env key reaches its field"
  );
}

// An empty value is "not set" (a shell `BRAVE_API_KEY=` must not create an empty key).
assert.equal(websearchToolConfigFromEnv({ BRAVE_API_KEY: "" }), undefined, "empty value is unset");

// `WEBSEARCH_PROVIDER` alone is a real preference (no key needed).
assert.deepEqual(websearchToolConfigFromEnv({ WEBSEARCH_PROVIDER: "duckduckgo" }), {
  websearch: { provider: "duckduckgo" },
});

// ---------------------------------------------------------------------------
// 2. File merge — host wins per field, the file fills the gaps
// ---------------------------------------------------------------------------

// No file toolConfig → host config passes through untouched (and by reference).
{
  const host = { websearch: { braveApiKey: "sk-brave", provider: "brave" } };
  assert.equal(mergeModelsConfigToolConfig(host, {}) === host, true);
  assert.equal(mergeModelsConfigToolConfig(undefined, undefined), undefined);
  assert.equal(mergeModelsConfigToolConfig(undefined, { toolConfig: undefined }), undefined);
}

// File fills gaps the host leaves open.
{
  const merged = mergeModelsConfigToolConfig(undefined, {
    toolConfig: { provider: "parallel", exaApiKey: "exa-from-file" },
  });
  assert.equal(merged.websearch.provider, "parallel");
  assert.equal(merged.websearch.exaApiKey, "exa-from-file");
}

// Per-field precedence: the host wins on `provider`, the file still supplies its own key.
{
  const merged = mergeModelsConfigToolConfig(
    { websearch: { provider: "brave", braveApiKey: "sk-brave" } },
    { toolConfig: { provider: "parallel", tavilyApiKey: "tvly" } }
  );
  assert.equal(merged.websearch.provider, "brave", "host provider wins");
  assert.equal(merged.websearch.braveApiKey, "sk-brave", "host key kept");
  assert.equal(merged.websearch.tavilyApiKey, "tvly", "file-only key filled in");
}

// An empty host string does not clobber a file value.
{
  const merged = mergeModelsConfigToolConfig({ websearch: { provider: "" } }, { toolConfig: { provider: "exa" } });
  assert.equal(merged.websearch.provider, "exa");
}

// The two helpers compose the way both hosts use them: env above the file.
{
  const fromEnv = websearchToolConfigFromEnv({ BRAVE_API_KEY: "env-brave" });
  const merged = mergeModelsConfigToolConfig(fromEnv, {
    toolConfig: { braveApiKey: "file-brave", exaApiKey: "file-exa", provider: "exa" },
  });
  assert.deepEqual(merged, {
    websearch: { braveApiKey: "env-brave", exaApiKey: "file-exa", provider: "exa" },
  });
}

console.log("websearch-tool-config validation passed");
