/**
 * Validates the model-selection rule (`selectModel`) — whose model choice wins when a plane
 * already serves one.
 *
 * A remote provider supplies the CONNECTION and the selectable catalog; the client picks the model.
 * Three cases decide everything, and each one has a different failure mode if it goes wrong:
 *
 * - a selectable request is kept (otherwise `/models` would be decorative);
 * - a request the provider does not offer falls back to the served model (otherwise the proxy
 *   refuses it, or worse, a session runs a model the user did not pick);
 * - an UNVERIFIABLE request is kept, because "the plane advertises no list" is not evidence the
 *   client is wrong — a direct provider has no allowlist at all.
 *
 * Run: pnpm --filter @codent/core run validate:model-selection
 */

import assert from "node:assert/strict";

import { selectModel, selectableModelIds } from "../dist/index.mjs";

// ============================================================================
// 1. A selectable request wins
// ============================================================================

assert.deepEqual(
  selectModel({
    requested: "deepseek-v4.1-flash",
    fallback: "served-model",
    allowed: ["served-model", "deepseek-v4.1-flash"],
  }),
  { model: "deepseek-v4.1-flash" },
  "a model the provider advertises must be used as requested"
);

// Whitespace around a flag value must not smuggle in a miss (`--model " gpt-x "`).
assert.deepEqual(selectModel({ requested: "  served-model  ", fallback: "served-model", allowed: ["served-model"] }), {
  model: "served-model",
});

// ============================================================================
// 2. A request outside the catalog falls back, and says so
// ============================================================================

assert.deepEqual(selectModel({ requested: "not-offered", fallback: "served-model", allowed: ["served-model"] }), {
  model: "served-model",
  fallback: { requested: "not-offered", model: "served-model" },
});

// The fallback report exists for logging: an accepted request carries none, so a healthy
// bootstrap does not log a substitution on every start.
assert.equal(
  selectModel({ requested: "served-model", fallback: "served-model", allowed: ["served-model"] }).fallback,
  undefined
);

// ============================================================================
// 3. An unverifiable request is trusted, not dropped
// ============================================================================

// No catalog at all (a direct provider, or an agent built without a `loadModels` read).
assert.deepEqual(selectModel({ requested: "gpt-x", fallback: "served-model" }), { model: "gpt-x" });
assert.deepEqual(selectModel({ requested: "gpt-x", fallback: "served-model", allowed: [] }), { model: "gpt-x" });
// A catalog whose ids are all blank is the same "cannot verify" case.
assert.deepEqual(selectModel({ requested: "gpt-x", fallback: "served-model", allowed: ["", "  "] }), {
  model: "gpt-x",
});

// ============================================================================
// 4. No request at all: the fallback IS the answer
// ============================================================================

assert.deepEqual(selectModel({ fallback: "served-model", allowed: ["other"] }), { model: "served-model" });
assert.deepEqual(selectModel({ requested: "   ", fallback: "served-model" }), { model: "served-model" });
// Nothing to fall back to: the request is the only model we know about.
assert.deepEqual(selectModel({ requested: "gpt-x" }), { model: "gpt-x" });

// ============================================================================
// 5. `selectableModelIds` — the catalog's allowlist, across entries
// ============================================================================

// One runtime can hold several entries (direct + remote); a persisted model is selectable when
// ANY of them offers it, because which entry serves the running model is the session's decision.
assert.deepEqual(
  selectableModelIds({
    entries: [{ models: ["a", "b"] }, { models: ["b", "c"] }, { models: [] }],
  }),
  ["a", "b", "c"],
  "the union, deduplicated, over every entry"
);

// No catalog / no ids means "cannot verify" — which `selectModel` reads as trust, not as refusal.
assert.equal(selectableModelIds(undefined), undefined);
assert.equal(selectableModelIds({ entries: [] }), undefined);
assert.equal(selectableModelIds({ entries: [{ models: [""] }] }), undefined);

// The two functions compose: a persisted model outside this catalog falls back, one inside it does not.
const catalog = { entries: [{ models: ["served-model", "deepseek-v4.1-flash"] }] };
const allowed = selectableModelIds(catalog);
assert.equal(
  selectModel({ requested: "deepseek-v4.1-flash", fallback: "served-model", allowed }).model,
  "deepseek-v4.1-flash"
);
assert.equal(selectModel({ requested: "stale-model", fallback: "served-model", allowed }).model, "served-model");

console.log("model-selection validation passed");
