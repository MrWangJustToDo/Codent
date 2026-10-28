/**
 * `undefined` (unknown) and `[]` (declared none) must stay different at every hop.
 *
 * These two states look alike and mean opposite things:
 *
 *   - `undefined` — nothing was declared. `CapabilityProbe.hasCapability` is permissive, so the
 *     gates allow everything. Correct for a model we cannot describe.
 *   - `[]` — capabilities were resolved and the model declares none. The gates are strict, so a
 *     text-only model really does have its images stripped before send.
 *
 * `streaming` used to paper over the difference: it was granted to every model purely to keep the
 * list non-empty, because empty was indistinguishable from unknown. With it gone, each hop that
 * touches the value has to preserve the distinction, and two of them did not:
 *
 *   - `mergeModelInfo` tested `override.capabilities.length > 0`, so a caller who explicitly
 *     declared `[]` was silently upgraded to the catalog's list for the same model id.
 *   - `UsageTracker.hasCapability` treated an empty array as unknown, so a resolved model that
 *     declared nothing was exempt from pre-send stripping.
 *
 * `validate:model-capabilities` covers the mapping (metadata → list). This covers the transports
 * (merge, probe), because a correct mapping piped through a collapsing hop is still wrong.
 *
 * Run: pnpm --filter @codent/core run validate:capability-unknown-vs-none
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { UsageTracker, clearCoreEnv, defaultPath, registerCoreEnv, resolveModelConfig } from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// `resolveModelConfig` reads the models.dev CACHE through CoreEnv, so without a reachable catalog
// it returns `modelInfo: null` and every merge assertion below would pass trivially — the merge
// would never run, and "the override survived" would prove nothing.
//
// A workspace cache is the wrong source for that: whether `.agents/cache/models-dev.json` exists
// depends on a human having run the CLI, so this file used to *skip* three of its ten assertions in
// CI while still exiting 0 (and the suite counted it as `passed`). A temp root with a
// stale-but-readable fixture makes the merge path run everywhere, offline, and deterministically.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capability-unknown-vs-none-"));
const fixtureCacheDir = path.join(fixtureRoot, ".agents", "cache");
const CACHE = path.join(fixtureCacheDir, "models-dev.json");
fs.mkdirSync(fixtureCacheDir, { recursive: true });
fs.writeFileSync(
  CACHE,
  JSON.stringify({
    openai: {
      id: "openai",
      name: "OpenAI",
      api: "https://api.openai.com/v1",
      npm: "@ai-sdk/openai",
      env: ["OPENAI_API_KEY"],
      models: {
        "gpt-4o": {
          id: "gpt-4o",
          name: "GPT-4o",
          // `modalities.input` is what `deriveCapabilities` reads for `vision`; the assertion
          // "omitting capabilities does not manufacture an empty declaration" depends on it.
          modalities: { input: ["text", "image"], output: ["text"] },
          tool_call: true,
          limit: { context: 128000, output: 16384 },
          cost: { input: 2.5, output: 10, cache_read: 1.25 },
        },
      },
    },
  })
);

registerCoreEnv({
  rootPath: fixtureRoot,
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => fixtureRoot,
  path: defaultPath,
  fs: {
    readFile: async (p) => fs.readFileSync(p, "utf8"),
    writeFile: async () => {
      throw new Error("read-only");
    },
    appendFile: async () => {
      throw new Error("read-only");
    },
    mkdir: async () => {},
    exists: async (p) => fs.existsSync(p),
    readdir: async (p) =>
      fs
        .readdirSync(p, { withFileTypes: true })
        .map((d) => ({ name: d.name, type: d.isFile() ? "file" : "directory" })),
    remove: async () => {
      throw new Error("read-only");
    },
    stat: async (p) => {
      const st = fs.statSync(p);
      // An ancient mtime keeps the cache "stale", so `fetchModelsDev` takes the blocking path and
      // falls straight through to the disk cache when the network call below fails. That avoids the
      // fire-and-forget revalidation the fresh path starts, which would leave a live request behind.
      return { size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory(), mtime: new Date(0) };
    },
  },
  runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  // Offline by construction: `fetchModelsDev` catches this and serves the fixture instead.
  fetch: async () => {
    throw new Error("offline fixture: models.dev must not be fetched by this validator");
  },
});

const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}: ${err?.message ?? err}`);
  }
}

/** Guard against a green-but-empty run: the merge checks need the fixture catalog to be reachable. */
async function checkMerge(name, fn) {
  // Prove the merge is actually reachable before asserting anything about it, so a broken env
  // stub cannot silently turn these into no-op passes. The fixture above makes this deterministic;
  // there is no "no corpus" branch to skip through.
  const probe = await resolveModelConfig({ model: "gpt-4o" });
  if (!probe.modelInfo) {
    failures.push({ name, err: new Error("merge unreachable: resolveModelConfig returned no modelInfo") });
    console.log(`  FAIL ${name}: merge unreachable (the models.dev fixture was not served)`);
    return;
  }
  await check(name, fn);
}

// ============================================================================
// 1. The metadata merge must not promote "declared none" to the catalog's list
// ============================================================================

await checkMerge("an explicit [] wins over models.dev metadata for the same id", async () => {
  // `gpt-4o` carries vision in models.dev. A caller overriding it to [] is stating that this
  // deployment accepts text only, which is exactly the case the old `length > 0` test destroyed.
  const resolved = await resolveModelConfig({
    model: "gpt-4o",
    modelInfo: { id: "gpt-4o", name: "gpt-4o", style: "openai", apiModel: "gpt-4o", capabilities: [] },
  });
  assert.deepEqual(
    resolved.modelInfo?.capabilities,
    [],
    "the caller declared no capabilities; the merge must not substitute the catalog's list"
  );
});

await checkMerge("a caller-provided non-empty list still wins", async () => {
  const resolved = await resolveModelConfig({
    model: "gpt-4o",
    modelInfo: {
      id: "gpt-4o",
      name: "gpt-4o",
      style: "openai",
      apiModel: "gpt-4o",
      capabilities: ["reasoning"],
    },
  });
  assert.deepEqual(resolved.modelInfo?.capabilities, ["reasoning"]);
});

await checkMerge("omitting capabilities does not manufacture an empty declaration", async () => {
  // The mirror-image failure: turning "said nothing" into "declares nothing" would make every
  // bare MODEL_* config strip images it has no basis to strip.
  const resolved = await resolveModelConfig({ model: "gpt-4o" });
  const caps = resolved.modelInfo?.capabilities;
  assert.notDeepEqual(caps, [], "absence of a declaration must not become a declaration of none");
  assert.ok(Array.isArray(caps) && caps.includes("vision"), "models.dev metadata should still supply the list");
});

// ============================================================================
// 2. The probe must treat the two states differently
// ============================================================================

await check("unknown (undefined) is permissive; empty declaration is strict", () => {
  const unknown = new UsageTracker();
  unknown.setCapabilities(undefined);
  for (const cap of ["vision", "audio", "video", "document", "reasoning", "tool_calling"]) {
    assert.equal(unknown.hasCapability(cap), true, `unknown must allow "${cap}"`);
  }
  assert.equal(unknown.getCapabilities(), null, "unknown reads back as null, not an empty set");

  const declaredNone = new UsageTracker();
  declaredNone.setCapabilities([]);
  for (const cap of ["vision", "audio", "video", "document", "reasoning", "tool_calling"]) {
    assert.equal(declaredNone.hasCapability(cap), false, `an empty declaration must deny "${cap}"`);
  }
  assert.deepEqual([...(declaredNone.getCapabilities() ?? [])], [], "empty declaration reads back as an empty set");
});

await check("a text-only model is actually stripped (the behaviour this change fixes)", () => {
  // Before the split, `[]` was permissive, which meant pre-send stripping never engaged for the
  // 330 catalog entries that resolve to no capabilities — images went to endpoints that reject
  // them. This is the end-to-end consequence, asserted through the probe the strip gates on.
  const textOnly = new UsageTracker();
  textOnly.setCapabilities([]);
  assert.equal(
    textOnly.hasCapability("vision"),
    false,
    "a model that declared no capabilities must not be treated as vision-capable"
  );

  const unknownModel = new UsageTracker();
  unknownModel.setCapabilities(undefined);
  assert.equal(
    unknownModel.hasCapability("vision"),
    true,
    "a model with no metadata keeps the permissive behaviour (unchanged)"
  );
});

// ============================================================================
// 3. The same distinction must survive into the side-query decision
// ============================================================================
//
// `createTextAdapter` collapses the three-state capability into the two-state
// `structuredOutput` decision the port gates on, and it has to collapse it the
// same way: a **declared absence** is the only thing that may route a call to text
// mode. Getting this backwards is silent — every undeclared model (offline
// launches, catalog gaps) would quietly take the weaker mechanism, and no
// assertion elsewhere would notice because the request still succeeds.

const { createTextAdapter } = await import("../dist/dev.mjs");

const fakeModelInfo = (capabilities) => ({
  id: "probe/model",
  name: "Probe",
  style: "openai",
  apiModel: "probe-model",
  ...(capabilities === undefined ? {} : { capabilities }),
});

await check("a declared absence resolves to `unsupported` (text mode)", () => {
  const config = createTextAdapter({
    style: "openai",
    model: "probe-model",
    baseURL: "http://localhost",
    modelInfo: fakeModelInfo(["tool_calling", "reasoning"]),
  });
  assert.equal(
    config.structuredOutput,
    "unsupported",
    "capabilities were resolved and exclude json_output — that is a decision, not a hint"
  );
});

await check("a declared presence resolves to `supported`", () => {
  const config = createTextAdapter({
    style: "openai",
    model: "probe-model",
    baseURL: "http://localhost",
    modelInfo: fakeModelInfo(["json_output", "tool_calling"]),
  });
  assert.equal(config.structuredOutput, "supported");
});

await check("an unknown capability resolves to `supported` — never silently downgraded", () => {
  // `undefined` is "nothing was declared". Collapsing it to `unsupported` would be the damaging
  // direction: it would route every undescribable model through the weaker mechanism.
  for (const [label, modelInfo] of [
    ["no metadata at all", null],
    ["metadata without a capabilities field", fakeModelInfo(undefined)],
  ]) {
    const config = createTextAdapter({
      style: "openai",
      model: "probe-model",
      baseURL: "http://localhost",
      modelInfo,
    });
    assert.equal(config.structuredOutput, "supported", `${label} must still attempt structured output`);
  }
});

await check("a resolved-but-empty declaration is strict, not unknown", () => {
  // The mirror of the `[]` case above, one hop further along: an empty declaration
  // must deny structured output rather than falling back to the permissive default.
  const config = createTextAdapter({
    style: "openai",
    model: "probe-model",
    baseURL: "http://localhost",
    modelInfo: fakeModelInfo([]),
  });
  assert.equal(config.structuredOutput, "unsupported", "`[]` means resolved-and-none, so json_output is absent");
});

await check("the anthropic style resolves the decision identically", () => {
  // The style must not change the decision: both adapters are gated by the same field, and only
  // one of them even has a structured stream, which is exactly why the gate is capability-based.
  const unsupported = createTextAdapter({
    style: "anthropic",
    model: "probe-model",
    baseURL: "http://localhost",
    apiKey: "test-key",
    modelInfo: fakeModelInfo(["tool_calling"]),
  });
  const supported = createTextAdapter({
    style: "anthropic",
    model: "probe-model",
    baseURL: "http://localhost",
    apiKey: "test-key",
    modelInfo: fakeModelInfo(["json_output"]),
  });
  assert.equal(unsupported.structuredOutput, "unsupported");
  assert.equal(supported.structuredOutput, "supported");
});

// ============================================================================

console.log("");
if (failures.length > 0) {
  console.error(`capability-unknown-vs-none validation FAILED (${failures.length} check(s))`);
  for (const f of failures) console.error(`  - ${f.name}: ${f.err?.message ?? f.err}`);
  clearCoreEnv();
  fs.rmSync(fixtureRoot, TEMP_RM_OPTIONS);
  process.exit(1);
}
clearCoreEnv();
fs.rmSync(fixtureRoot, TEMP_RM_OPTIONS);
console.log("capability-unknown-vs-none validation passed");
