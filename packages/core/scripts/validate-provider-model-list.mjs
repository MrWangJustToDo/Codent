/**
 * Validates the client side of the remote-provider model contract: the provider supplies the
 * CATALOG, the client picks from it, and a pick it cannot honour falls back to the served model.
 *
 * The two identities a host displays (`active.model` — footer, help, `/models` "(current)") and the
 * one the adapter sends (`resolveModelConfigFromProvider`) must be the SAME model, in both
 * directions:
 *
 * - a pick the catalog offers is displayed AND sent (otherwise `/models` is decorative);
 * - a recorded selection the catalog does not offer is displayed AND sent as the served model
 *   (otherwise the host names a model the proxy will refuse).
 *
 * Both entry sources are covered: the provider source (`--remote-provider`) and a file source whose
 * models.json holds a `remote-provider` entry.
 *
 * Run: pnpm --filter @codent/core run validate:provider-model-list
 */
/* eslint-disable no-undef */

import assert from "node:assert/strict";

import {
  clearModelProvider,
  loadModels,
  registerCoreEnv,
  registerModelProviderForEntry,
  resolveModelConfigFromProvider,
  createRemoteProvider,
} from "../dist/index.mjs";

// ============================================================================
// Stubbed provider info
// ============================================================================

const PROVIDER_URL = "http://provider.test:3100";
const SERVED_MODEL = "deepseek/deepseek-v4-flash-0731";
const OTHER_MODELS = ["deepseek/deepseek-v4.1-flash", "moonshot/kimi-k3", "zhipu/glm-5.3-flash"];

const infos = new Map();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const info = infos.get(String(input));
  // 404 rather than a throw for anything else: models.dev lookups stay offline, and the
  // resolve pipeline already treats "no metadata" as `undefined`.
  return info ? Response.json(info) : new Response("not found", { status: 404 });
};

/** Register the `/api/provider/info` payload a server would answer with. */
function serveProvider(url, config) {
  infos.set(`${url}/api/provider/info`, {
    mode: "remote",
    style: "openai",
    model: SERVED_MODEL,
    basePath: "/api/provider/openai/v1",
    ...(config ? { config } : {}),
  });
}

// ============================================================================
// 1. The provider's catalog is what a client may pick from
// ============================================================================

serveProvider(PROVIDER_URL, { models: [{ type: "direct", style: "anthropic", models: OTHER_MODELS }] });

const state = await loadModels({ kind: "provider", serverUrl: PROVIDER_URL });
const entry = state.entries[0];

assert.equal(state.entries.length, 1, "a provider source collapses to a single entry");
assert.equal(entry.type, "remote");
assert.equal(entry.servedModel, SERVED_MODEL, "the entry records what the provider serves");
assert.deepEqual(
  entry.models,
  [...OTHER_MODELS, SERVED_MODEL],
  "the served model must be selectable even though models.json does not list it"
);
assert.equal(entry.style, "openai", "the entry style follows the connection, not models.json");
assert.equal(entry.baseURL, `${PROVIDER_URL}/api/provider/openai/v1`);
assert.equal(
  state.active.model,
  SERVED_MODEL,
  "with no recorded selection the provider's served model is what runs, so it is what is reported"
);

// The provider carries the same catalog, so bootstrap can check a pick without a second fetch.
const provider = await createRemoteProvider(PROVIDER_URL);
const connection = await provider.getConnection();
assert.deepEqual(
  [...(connection.models ?? [])].sort(),
  [...OTHER_MODELS, SERVED_MODEL].sort(),
  "the provider advertises the ids the proxy will accept"
);

// The invariant all of this exists for: what the host displays (`active.model` — read by
// the footer, help, and the `/models` "(current)" marker) must equal the model the
// adapter will send — for a pick from the catalog AND for a pick it does not offer.
clearModelProvider();
await registerModelProviderForEntry({ ...state, active: { entryIndex: 0, model: "deepseek/deepseek-v4.1-flash" } });
const picked = await resolveModelConfigFromProvider({ model: "deepseek/deepseek-v4.1-flash" });
assert.equal(picked.connection.model, "deepseek/deepseek-v4.1-flash", "a catalog model is sent as picked");
assert.equal(picked.modelFallback, undefined);

const unknown = await resolveModelConfigFromProvider({ model: "gpt-4o-mini" });
assert.equal(unknown.connection.model, SERVED_MODEL, "an id outside the catalog falls back to the served model");
assert.deepEqual(unknown.modelFallback, { requested: "gpt-4o-mini", model: SERVED_MODEL });
clearModelProvider();

// ============================================================================
// 2. No models.json at all
// ============================================================================

serveProvider("http://plain.test:3100");
const plain = await loadModels({ kind: "provider", serverUrl: "http://plain.test:3100" });
assert.deepEqual(plain.entries[0].models, [SERVED_MODEL]);

// ============================================================================
// 3. Chained config: a models.json holding only `remote-provider` entries
// ============================================================================

// An empty `flatMap` is not nullish, so the old `?? (info.model ? …)` fallback never
// applied here and the selectable list came out empty.
serveProvider("http://chained.test:3100", {
  models: [{ type: "remote-provider", url: "http://upstream.test:3200" }],
});
const chained = await loadModels({ kind: "provider", serverUrl: "http://chained.test:3100" });
assert.deepEqual(chained.entries[0].models, [SERVED_MODEL], "an id-less config must still offer the served model");

// ============================================================================
// 4. A file source recording a selection
// ============================================================================

// A recorded selection that the provider still offers survives a reload — it is the client's
// choice, and dropping it is what made `/models` look broken after a restart.
{
  const modelsJson = JSON.stringify({
    models: [{ type: "remote-provider", url: PROVIDER_URL }],
    active: { entryIndex: 0, model: "deepseek/deepseek-v4.1-flash" },
  });
  registerCoreEnv({
    rootPath: "/workspace",
    fs: {
      exists: async (p) => p === "/workspace/.agents/config/models.json",
      readFile: async () => modelsJson,
    },
  });

  const fileState = await loadModels({ kind: "file" });
  assert.equal(fileState.entries[0].type, "remote");
  assert.equal(fileState.active.model, "deepseek/deepseek-v4.1-flash", "a selectable selection is kept");
}

// …and one the provider no longer offers yields to the served model, because that is what a
// request would carry.
{
  const modelsJson = JSON.stringify({
    models: [{ type: "remote-provider", url: PROVIDER_URL }],
    active: { entryIndex: 0, model: "stale-model" },
  });
  registerCoreEnv({
    rootPath: "/workspace",
    fs: {
      exists: async (p) => p === "/workspace/.agents/config/models.json",
      readFile: async () => modelsJson,
    },
  });

  const fileState = await loadModels({ kind: "file" });
  assert.equal(fileState.active.model, SERVED_MODEL, "a stale selection yields to the served model");
  assert.ok(fileState.entries[0].models.includes(SERVED_MODEL), "and the served model stays selectable");
}

// ============================================================================
// 4b. A file read is scoped to the env it is GIVEN, never the ambient registry
// ============================================================================
//
// The config file carries `baseURL`/`apiKey` for every entry. A server hosting several workspaces
// used to read and write whichever root was registered last (the path accepted a `rootPath` but
// the fs came from `getEnv()`), so an edit in workspace B could rewrite workspace A's file.
{
  const ambientConfig = JSON.stringify({
    models: [{ type: "direct", style: "openai", baseURL: "https://ambient.example/v1", models: ["ambient-model"] }],
    active: { entryIndex: 0, model: "ambient-model" },
  });
  const scopedConfig = JSON.stringify({
    models: [{ type: "direct", style: "openai", baseURL: "https://scoped.example/v1", models: ["scoped-model"] }],
    active: { entryIndex: 0, model: "scoped-model" },
  });

  registerCoreEnv({
    rootPath: "/ambient",
    fs: {
      exists: async () => true,
      readFile: async () => ambientConfig,
    },
  });

  const scopedEnv = {
    rootPath: "/scoped",
    fs: {
      exists: async (p) => p === "/scoped/.agents/config/models.json",
      readFile: async (p) => {
        assert.equal(p, "/scoped/.agents/config/models.json", "the injected env's path is what is read");
        return scopedConfig;
      },
    },
  };

  const scoped = await loadModels({ kind: "file", env: scopedEnv });
  assert.equal(scoped.active.model, "scoped-model", "the read follows the injected env, not the ambient root");
  assert.equal(scoped.entries[0].models[0], "scoped-model", "and so does the selectable list");
}

// ============================================================================
// 5. No credential crosses the plane, in either direction
// ============================================================================
//
// The client now READS the provider's model catalog (that is what makes a client-side pick
// checkable), so the boundary deserves an explicit assertion rather than an argument:
//
// - server → client: a payload that carries a credential where a buggy/older server might put it
//   must not reach the client's connection, its catalog, or its `config` — the client only ever
//   maps model IDS out of `/api/provider/info`;
// - client → server: a client-supplied `apiKey` / `baseURL` is replaced by the sentinel + proxy
//   endpoint, so a proxy request never carries the host's own key (and never talks upstream
//   directly, which is the other half of the same guarantee).
{
  const LEAKY_URL = "http://leaky.test:3100";
  const SERVER_SECRET = "sk-server-must-not-leave";
  infos.set(`${LEAKY_URL}/api/provider/info`, {
    mode: "remote",
    style: "openai",
    model: SERVED_MODEL,
    basePath: "/api/provider/openai/v1",
    // A hostile/buggy shape: the secret sits exactly where a careless sanitizer would leave it.
    apiKey: SERVER_SECRET,
    config: {
      apiKey: SERVER_SECRET,
      active: { entryIndex: 0, model: SERVED_MODEL },
      models: [
        {
          type: "direct",
          style: "openai",
          apiKey: SERVER_SECRET,
          baseURL: "https://upstream.example.com/v1",
          models: ["leaky-a", "leaky-b"],
        },
      ],
    },
  });

  // -- server → client, through the provider the host actually registers --
  const leakyProvider = await createRemoteProvider(LEAKY_URL);
  const leakyConnection = await leakyProvider.getConnection();
  assert.equal(leakyConnection.apiKey, "remote-provider", "the client holds the sentinel, never the server key");
  assert.equal(leakyConnection.baseURL, `${LEAKY_URL}/api/provider/openai/v1`, "traffic goes to the proxy");
  assert.ok(
    !JSON.stringify(leakyConnection).includes(SERVER_SECRET),
    "no credential may reach the client through the provider connection"
  );
  assert.ok(
    !JSON.stringify(leakyConnection).includes("upstream.example.com"),
    "nor the upstream endpoint the proxy uses"
  );

  // -- the same payload through the catalog read --
  const leakyState = await loadModels({ kind: "provider", serverUrl: LEAKY_URL });
  const leakyEntry = leakyState.entries[0];
  assert.equal(leakyEntry.apiKey, "remote-provider", "a remote entry carries the sentinel key");
  assert.deepEqual(
    [...leakyEntry.models].sort(),
    ["leaky-a", "leaky-b", SERVED_MODEL].sort(),
    "only model IDS are taken from the provider config"
  );
  assert.ok(!JSON.stringify(leakyEntry).includes(SERVER_SECRET), "the catalog entry carries no credential");
  assert.ok(!JSON.stringify(leakyState).includes(SERVER_SECRET), "nor does the loaded state");

  // -- client → server: the host's own connection cannot be slipped through the proxy --
  clearModelProvider();
  await registerModelProviderForEntry({ ...leakyState, active: { entryIndex: 0, model: "leaky-a" } });
  const forced = await resolveModelConfigFromProvider({
    model: "leaky-a",
    baseURL: "https://api.example.org/v1",
    apiKey: "sk-client-must-not-leave",
  });
  assert.equal(forced.connection.apiKey, "remote-provider", "a client key is replaced by the sentinel");
  assert.equal(forced.connection.baseURL, `${LEAKY_URL}/api/provider/openai/v1`, "and the endpoint by the proxy");
  assert.equal(forced.connection.model, "leaky-a", "while the model stays the client's choice");
  assert.equal(forced.modelInfo?.baseURL, undefined, "metadata cannot smuggle an endpoint back in");
  clearModelProvider();
}

globalThis.fetch = realFetch;

console.log("provider-model-list validation passed");
