/**
 * Validates resolveModelConfigFromProvider's remote/direct merge rules.
 *
 * The split is deliberate and asymmetric:
 * - baseURL / apiKey / style are FORCED from a remote provider (the key-holding proxy owns them,
 *   and a client-supplied endpoint would bypass it);
 * - the MODEL belongs to the client, chosen from the catalog the provider advertises. A pick
 *   outside that catalog falls back to the served model and reports the substitution, so a stale
 *   session or a bad flag cannot produce a request the proxy will refuse.
 *
 * Run: pnpm --filter @codent/core run validate:resolve-from-provider
 */

import assert from "node:assert/strict";

import { clearModelProvider, registerModelProvider, resolveModelConfigFromProvider } from "../dist/index.mjs";

const REMOTE_BASE = "http://remote/api/provider/openai/v1";
const CATALOG = ["server-model", "other-model", "third-model"];

clearModelProvider();

registerModelProvider({
  getConnection: async () => ({
    mode: "remote",
    style: "openai",
    model: "server-model",
    baseURL: REMOTE_BASE,
    apiKey: "remote-provider",
    models: CATALOG,
  }),
});

// A client pick FROM the catalog is what runs. It used to be overwritten by the served model,
// which made `/models` decorative under `--remote-provider`.
const picked = await resolveModelConfigFromProvider({
  model: "other-model",
  style: "anthropic",
  baseURL: "http://evil.example/v1",
  apiKey: "sk-client",
});
assert.equal(picked.connection.model, "other-model", "a selectable client model is kept");
assert.equal(picked.connection.style, "openai", "remote forces provider style");
assert.equal(picked.connection.baseURL, REMOTE_BASE, "remote forces the proxy endpoint");
assert.equal(picked.connection.apiKey, "remote-provider", "remote forces the placeholder key");
assert.equal(picked.providerMode, "remote");
assert.equal(picked.modelFallback, undefined, "a selectable pick is not reported as a fallback");

// A pick the provider does not offer falls back to the served model, and says which one it dropped.
const stale = await resolveModelConfigFromProvider({ model: "retired-model" });
assert.equal(stale.connection.model, "server-model", "an un-offered model yields to the served one");
assert.deepEqual(stale.modelFallback, { requested: "retired-model", model: "server-model" });

// No pick at all: the served model.
const implicit = await resolveModelConfigFromProvider({});
assert.equal(implicit.connection.model, "server-model");
assert.equal(implicit.modelFallback, undefined);

// models.dev / MODEL_* metadata must not clobber the proxy baseURL
const proxiedMeta = await resolveModelConfigFromProvider({
  model: "other-model",
  modelInfo: {
    id: "other-model",
    name: "other-model",
    style: "openai",
    apiModel: "other-model",
    capabilities: [],
    baseURL: "https://api.openai.com/v1",
  },
});
assert.equal(proxiedMeta.connection.baseURL, REMOTE_BASE, "metadata cannot reroute the request");
assert.equal(proxiedMeta.connection.model, "other-model");
assert.equal(proxiedMeta.modelInfo?.baseURL, undefined);

// A provider that advertises no catalog cannot be checked against, so the request is trusted.
clearModelProvider();
registerModelProvider({
  getConnection: async () => ({
    mode: "remote",
    style: "openai",
    model: "server-model",
    baseURL: REMOTE_BASE,
    apiKey: "remote-provider",
  }),
});
const unchecked = await resolveModelConfigFromProvider({ model: "unlisted-model" });
assert.equal(unchecked.connection.model, "unlisted-model", "no catalog means the request is trusted, not dropped");
assert.equal(unchecked.modelFallback, undefined);

clearModelProvider();

// Direct mode is untouched: the client owns everything.
registerModelProvider({
  getConnection: async () => ({
    mode: "direct",
    style: "openai",
    model: "local-model",
    baseURL: "http://localhost:11434/v1",
    apiKey: "local-key",
  }),
});

const direct = await resolveModelConfigFromProvider({
  model: "gpt-test",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-local",
});
assert.equal(direct.connection.model, "gpt-test");
assert.equal(direct.connection.baseURL, "https://api.openai.com/v1");
assert.equal(direct.connection.apiKey, "sk-local");
assert.equal(direct.providerMode, "direct");

clearModelProvider();
console.log("resolve-from-provider validation passed");
