/**
 * Mid-session model-config edit — the real write path, against a real filesystem.
 *
 * `/settings config` saves `applyModelsConfigEdit`, which is the only place where a
 * bug is destructive: it rewrites `.agents/config/models.json`. Three properties
 * have to hold together and none is visible in the pure unit test:
 *
 * 1. **The file is the merge authority, not the in-memory store.** A session whose
 *    store is empty (config failed to load, or the file appeared after startup) must
 *    still keep every entry it was not editing. Reading from the store instead of
 *    the disk silently wiped sibling entries — this is the regression that caught it.
 * 2. **Unknown keys survive the write.** `parseModelsConfig` strips everything the
 *    schema does not declare, so a save that validated before writing deleted the
 *    user's own `$schema` / `headers` / future `global` keys while reporting success.
 *    The write path reads raw and merges raw; this case asserts the bytes come back.
 * 3. **The reload failure is not an edit failure.** `loadModels` fetches every
 *    `remote-provider` entry, so one unreachable sibling server makes the reload
 *    throw — after the write. The edit must stay committed and report the degraded
 *    state (`reloadError`), never roll back or claim the model went live.
 * 4. **The edited entry keeps its index and identity**, so `active` follows it
 *    instead of jumping to entry 0.
 *
 * Run: pnpm --filter @codent/app run validate:models-config-edit
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";

const root = mkdtempSync(join(tmpdir(), "codent-config-edit-"));
const configPath = join(root, ".agents", "config", "models.json");
const write = (obj) => writeFileSync(configPath, JSON.stringify(obj, null, 2));
const read = () => JSON.parse(readFileSync(configPath, "utf8"));

const { createNodeEnv } = await import(new URL("../../node/dist/index.mjs", import.meta.url).href);
const { clearCoreEnv, parseModelsConfig, registerCoreEnv } = await import(
  new URL("../../core/dist/index.mjs", import.meta.url).href
);
const { applyModelsConfigEdit, mergeModelsConfig } = await import(new URL("../dist/index.mjs", import.meta.url).href);

const draft = (entry) => parseModelsConfig(JSON.stringify({ models: [entry] }));

try {
  mkdirSync(join(root, ".agents", "config"), { recursive: true });

  // ---------------------------------------------------------------------------
  // 1. Happy path — merge on disk, reload live
  // ---------------------------------------------------------------------------
  write({
    global: { maxIterations: 25, toolConfig: { braveApiKey: "sk-brave-keep-me" } },
    models: [
      { type: "direct", style: "openai", baseURL: "https://old.example/v1", apiKey: "sk-old", models: ["gpt-4o"] },
      { type: "direct", style: "openai", baseURL: "https://sibling.example/v1", models: ["m-sib"] },
    ],
    active: { entryIndex: 0, model: "gpt-4o" },
  });

  registerCoreEnv(createNodeEnv({ rootPath: root, mode: "native" }));

  const first = await applyModelsConfigEdit(
    draft({
      type: "direct",
      style: "anthropic",
      baseURL: "https://new.example",
      apiKey: "sk-new",
      models: ["claude-x"],
    }),
    { entryIndex: 0 }
  );
  assert.equal(first.ok, true, `apply failed: ${first.error}`);
  assert.equal(first.reloadError, undefined, `unexpected reload failure: ${first.reloadError}`);

  const w1 = read();
  assert.equal(w1.models.length, 2, "sibling entry preserved");
  assert.equal(w1.models[1].baseURL, "https://sibling.example/v1", "sibling untouched");
  assert.equal(w1.models[0].baseURL, "https://new.example", "edited entry rewritten");
  assert.equal(w1.models[0].style, "anthropic", "style follows the draft");
  assert.equal(w1.global.maxIterations, 25, "a hand-written global key is preserved by the raw write");
  assert.equal(w1.global.toolConfig.braveApiKey, "sk-brave-keep-me", "nested global preserved");
  assert.deepEqual(w1.active, { entryIndex: 0, model: "claude-x" }, "active follows the draft's models");
  assert.equal(first.loaded.entries.length, 2, "reloaded entry list");
  assert.equal(first.loaded.active.model, "claude-x", "reloaded active model");
  assert.equal(first.model, "claude-x", "live model reported");

  // The store was never populated in this process — the merge read the disk. If it
  // had read the (empty) store, step 1 would have written a one-entry file.
  assert.equal(read().models.length, 2, "file is the merge authority, not the store");

  // ---------------------------------------------------------------------------
  // 2. Editing the second entry leaves the first alone and follows it
  // ---------------------------------------------------------------------------
  const second = await applyModelsConfigEdit(
    draft({ type: "direct", style: "openai", baseURL: "https://b.example/v1", models: ["m-b"] }),
    { entryIndex: 1 }
  );
  assert.equal(second.ok, true, `second apply failed: ${second.error}`);
  const w2 = read();
  assert.equal(w2.models.length, 2);
  assert.equal(w2.models[0].baseURL, "https://new.example", "entry 0 survived the second edit");
  assert.equal(w2.models[1].baseURL, "https://b.example/v1", "entry 1 rewritten");
  assert.deepEqual(w2.active, { entryIndex: 1, model: "m-b" }, "active followed entry 1");

  // ---------------------------------------------------------------------------
  // 3. Unknown keys survive the round trip
  // ---------------------------------------------------------------------------
  write({
    $schema: "https://example.com/models.schema.json",
    global: { maxIterations: 25, futureSetting: "keep-me" },
    models: [
      {
        type: "direct",
        style: "openai",
        baseURL: "https://old.example/v1",
        models: ["gpt-4o"],
        headers: { "X-Custom": "keep-me" },
        label: "my-own-field",
      },
      {
        type: "direct",
        style: "openai",
        baseURL: "https://sib.example/v1",
        models: ["m-sib"],
        headers: { "X-Sib": "keep" },
      },
    ],
    active: { entryIndex: 0, model: "gpt-4o" },
  });

  const preserved = await applyModelsConfigEdit(
    draft({ type: "direct", style: "anthropic", baseURL: "https://newer.example", models: ["claude-y"] }),
    { entryIndex: 0 }
  );
  assert.equal(preserved.ok, true, `apply failed: ${preserved.error}`);

  // Assert on the bytes, not on a parsed-and-revalidated view — that is the whole point.
  const rawText = readFileSync(configPath, "utf8");
  const raw = JSON.parse(rawText);
  assert.equal(raw.$schema, "https://example.com/models.schema.json", "$schema survived the write");
  assert.equal(raw.global.futureSetting, "keep-me", "global unknown key survived the write");
  assert.equal(raw.global.maxIterations, 25, "a hand-written global key survives (no longer schema-declared)");
  assert.deepEqual(raw.models[0].headers, { "X-Custom": "keep-me" }, "edited entry's unknown key survived");
  assert.equal(raw.models[0].label, "my-own-field", "edited entry's arbitrary key survived");
  assert.deepEqual(raw.models[1].headers, { "X-Sib": "keep" }, "untouched entry's unknown key survived");
  assert.equal(raw.models[0].baseURL, "https://newer.example", "the wizard's field was applied");
  assert.equal(raw.models[0].style, "anthropic");

  // And the same document must still validate + load through the normal pipeline
  // (unknown keys are inert, not corrupting).
  assert.equal(preserved.reloadError, undefined, `reload failed: ${preserved.reloadError}`);
  assert.equal(preserved.loaded.active.model, "claude-y");

  // ---------------------------------------------------------------------------
  // 4. Degraded reload — the write stands and is reported as not-live-yet
  // ---------------------------------------------------------------------------
  write({
    models: [
      { type: "direct", style: "openai", baseURL: "https://old.example/v1", models: ["gpt-4o"] },
      // Unreachable on purpose: `loadModels` fetches every remote-provider entry.
      { type: "remote-provider", url: "http://127.0.0.1:3999" },
    ],
    active: { entryIndex: 0, model: "gpt-4o" },
  });

  const third = await applyModelsConfigEdit(
    draft({ type: "direct", style: "openai", baseURL: "https://c.example/v1", models: ["m-c"] }),
    { entryIndex: 0 }
  );
  assert.equal(third.ok, true, "a written file is a successful save even when the reload fails");
  assert.equal(third.loaded, null, "no live pipeline state");
  assert.ok(third.reloadError, "the reload failure is surfaced");
  const w3 = read();
  assert.equal(w3.models.length, 2, "the write was not rolled back");
  assert.equal(w3.models[0].baseURL, "https://c.example/v1", "the edit is on disk");
  assert.equal(w3.models[1].type, "remote-provider", "the unreachable sibling is preserved");

  // ---------------------------------------------------------------------------
  // 5. Pure merge contract (no fs): a missing file cannot produce an invalid write
  // ---------------------------------------------------------------------------
  assert.deepEqual(
    mergeModelsConfig(null, draft({ type: "direct", style: "openai", baseURL: "https://x/v1", models: ["m"] })).models
      .length,
    1
  );
  assert.deepEqual(
    mergeModelsConfig(
      { models: [{ type: "direct", style: "openai", baseURL: "https://x/v1" }], active: { entryIndex: 0 } },
      { models: [] }
    ),
    { models: [{ type: "direct", style: "openai", baseURL: "https://x/v1" }], active: { entryIndex: 0 } },
    "an empty draft is a no-op"
  );

  console.log("models-config-edit: ok");
} finally {
  clearCoreEnv();
  rmSync(root, TEMP_RM_OPTIONS);
}
