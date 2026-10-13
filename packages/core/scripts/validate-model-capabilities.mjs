/**
 * Capability-mapping guard for models.dev metadata.
 * (change: add-extension-message-transform)
 *
 * `parseModelsDevModel` translates provider metadata into our `ModelCapability[]`, and every
 * downstream gate reads that list through `hasCapability`. The two empty-ish states are
 * deliberately different (see `ModelInfo.capabilities`): `undefined` means **unknown** and is
 * permissive, while `[]` means **declared, none apply** and is strict. So both failure
 * directions matter:
 *
 *   - a capability granted without metadata evidence is a silent authorization (the caller
 *     believes the model supports something nobody checked);
 *   - a capability list that comes back EMPTY (`[]`) after a successful parse makes every gate
 *     strict, so a vision-capable model silently loses its images; the mirror-image bug is
 *     returning `undefined` for a plain text model, which flips the gates back to permissive and
 *     sends modalities to an endpoint that rejects them.
 *
 * This drives the real `deriveCapabilities` against the real cached models.dev payload, so it
 * tests the mapping rather than a restatement of it. When the cache is absent (fresh clone,
 * offline) the corpus checks are skipped with a notice — the invariant checks still run.
 *
 * Run: pnpm --filter @codent/core run validate:model-capabilities
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_CAPABILITIES,
  MODELS_DEV_COST_FIELDS,
  MODELS_DEV_MODEL_FIELDS,
  deriveCapabilities,
  parseModelsDevModel,
  resolveReasoningEchoField,
  shouldEchoReasoningContent,
} from "../dist/dev.mjs";

const errors = [];

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    errors.push({ name, err });
    console.log(`  FAIL ${name}: ${err?.message ?? err}`);
  }
}

// ============================================================================
// 1. Invariants on the declared capability surface
// ============================================================================

check("every declared capability is producible from metadata (no dead members)", () => {
  // A capability nobody can derive is dead weight at best: `streaming` and `computer_use` were
  // exactly that, yet both were exported as the authoritative vocabulary and one of them was
  // load-bearing. Drive each member through a real metadata input instead of restating the list.
  const witnesses = {
    reasoning: { reasoning: true },
    tool_calling: { tool_call: true },
    json_output: { structured_output: true },
    prompt_caching: { cost: { cache_read: 0.1 } },
    vision: { modalities: { input: ["image"] } },
    audio: { modalities: { input: ["audio"] } },
    video: { modalities: { input: ["video"] } },
    document: { modalities: { input: ["pdf"] } },
  };
  const unproducible = MODEL_CAPABILITIES.filter((cap) => {
    const witness = witnesses[cap];
    return !witness || !deriveCapabilities(witness).includes(cap);
  });
  assert.deepEqual(
    unproducible,
    [],
    `capability(ies) no metadata input can produce: ${unproducible.join(", ")}. Either map them to a ` +
      `field deriveCapabilities reads, or drop them — an unproducible member is a constant pretending ` +
      `to be model metadata`
  );
});

check("no capability is a runtime-constant that describes every model", () => {
  // `streaming` was granted to all 7842 entries and `computer_use` had no source at all. Both
  // said nothing about any particular model while looking like model metadata, and `streaming`
  // was load-bearing only as a "metadata was parsed" marker. Every remaining member must be
  // evidenced by a metadata field this mapping reads.
  const evidenceable = new Set([
    "reasoning",
    "tool_calling",
    "json_output",
    "prompt_caching",
    "vision",
    "audio",
    "video",
    "document",
  ]);
  const unexplained = MODEL_CAPABILITIES.filter((cap) => !evidenceable.has(cap));
  assert.deepEqual(
    unexplained,
    [],
    `capability without metadata evidence: ${unexplained.join(", ")}. Every member must map to a ` +
      `field deriveCapabilities reads, otherwise it is a constant masquerading as model metadata`
  );
});

check("a parse with no metadata signal yields [] (declared none), never undefined", () => {
  // [] and undefined are different for the whole pipeline: the probe is permissive only for
  // `undefined` (unknown), so a resolved-but-plain model must come back [] and be treated
  // strictly. `deriveCapabilities` returning anything falsy here would put the model on the
  // permissive path and let images go to an endpoint that rejects them.
  const caps = deriveCapabilities({});
  assert.ok(Array.isArray(caps), "the mapping must always return an array");
  assert.deepEqual(caps, [], "a plain text model declares no capabilities — that is an answer, not a gap");
});

// ============================================================================
// 2. Mapping rules — exact, both directions
// ============================================================================

check("modalities.input is authoritative for each multimedia capability", () => {
  const expect = { image: "vision", audio: "audio", video: "video", pdf: "document" };
  for (const [modality, capability] of Object.entries(expect)) {
    const caps = deriveCapabilities({ modalities: { input: ["text", modality] } });
    assert.ok(caps.includes(capability), `modality "${modality}" must grant "${capability}"`);
  }
});

check("a text-only modalities list grants no multimedia capability", () => {
  const caps = deriveCapabilities({ modalities: { input: ["text"] } });
  for (const cap of ["vision", "audio", "video", "document"]) {
    assert.ok(!caps.includes(cap), `"${cap}" must not be granted for text-only input`);
  }
});

check("attachment alone does not grant document (it cannot distinguish)", () => {
  // Regression guard: expanding `attachment` into vision+document marked 34% of the catalog
  // document-capable when only 23% accept pdf.
  const caps = deriveCapabilities({ attachment: true });
  assert.ok(caps.includes("vision"), "attachment evidences image input");
  assert.ok(!caps.includes("document"), "attachment alone must NOT grant document");
});

check("attachment is not consulted when modalities.input is present", () => {
  const caps = deriveCapabilities({ attachment: true, modalities: { input: ["text"] } });
  assert.ok(!caps.includes("vision"), "modalities.input is authoritative and says text-only");
});

check("boolean metadata fields map one-to-one", () => {
  const expected = {
    reasoning: "reasoning",
    tool_call: "tool_calling",
    structured_output: "json_output",
  };
  for (const [field, capability] of Object.entries(expected)) {
    const caps = deriveCapabilities({ [field]: true });
    assert.ok(caps.includes(capability), `"${field}: true" must grant "${capability}"`);
    assert.ok(!deriveCapabilities({ [field]: false }).includes(capability), `"${field}: false" must not grant it`);
  }
});

check("prompt_caching follows cache pricing, not its absence", () => {
  assert.ok(deriveCapabilities({ cost: { cache_read: 0.1 } }).includes("prompt_caching"));
  assert.ok(deriveCapabilities({ cost: { cache_write: 0.1 } }).includes("prompt_caching"));
  assert.ok(!deriveCapabilities({ cost: { input: 1, output: 2 } }).includes("prompt_caching"));
});

check("no capability is granted twice", () => {
  const caps = deriveCapabilities({
    reasoning: true,
    attachment: true,
    tool_call: true,
    structured_output: true,
    cost: { cache_read: 1 },
    modalities: { input: ["text", "image", "pdf"] },
  });
  assert.equal(new Set(caps).size, caps.length, `duplicates in ${caps.join(",")}`);
});

// ============================================================================
// 3. Corpus checks against the real cached metadata (skipped when absent)
// ============================================================================

// Resolved from THIS file, not `process.cwd()`: the previous `../../.agents/...` was only correct
// when cwd happened to be `packages/core`. Under `pnpm --filter @codent/core run …` (cwd =
// packages/core) it resolved to `/home/.agents/...` — a path that never exists — so the corpus
// checks silently reported "skipped" while the file was right there in the workspace. A validator
// that skips itself is worse than one that fails: the only failure mode it had left was the
// hardcoded count, which is why that count was the only thing anyone ever saw break.
const cachePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.agents/cache/models-dev.json");
console.log(`  corpus source: ${cachePath} (exists=${fs.existsSync(cachePath)})`);

if (!fs.existsSync(cachePath)) {
  console.log("  skip corpus checks (no .agents/cache/models-dev.json — run the CLI once to populate)");
} else {
  const payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const entries = [];
  for (const provider of Object.values(payload)) {
    for (const model of Object.values(provider.models ?? {})) entries.push(model);
  }

  check(`corpus: [] is reserved for entries with no capability evidence (${entries.length} models)`, () => {
    // [] now means "resolved, and none apply" and makes the send-gates strict. That is correct
    // for a plain text model, but it would be WRONG for an entry that carries evidence -- the
    // model would have its supported modalities stripped. So [] must correlate exactly with
    // "nothing in the metadata says this model can do anything".
    const offenders = [];
    let plain = 0;
    for (const model of entries) {
      const caps = deriveCapabilities(model);
      if (caps.length > 0) continue;
      plain++;
      const hasEvidence =
        model.reasoning === true ||
        model.tool_call === true ||
        model.structured_output === true ||
        model.cost?.cache_read !== undefined ||
        model.cost?.cache_write !== undefined ||
        (Array.isArray(model.modalities?.input)
          ? model.modalities.input.some((m) => m !== "text")
          : // `attachment` is the coarse fallback and is ONLY consulted when modalities is absent
            // (modalities.input is authoritative and overrides it). Counting it unconditionally
            // flagged poe/cerebras/llama-3.3-70b-cs, which is `attachment: true` with
            // `modalities.input: ["text"]` — correctly resolved to [] and correctly stripped.
            model.attachment === true);
      if (hasEvidence) offenders.push(model.id ?? model.name ?? "?");
    }
    assert.deepEqual(
      offenders.slice(0, 5),
      [],
      `${offenders.length} entr(ies) resolved to [] despite carrying capability evidence, e.g. ` +
        `${offenders.slice(0, 5).join(", ")} — those models would have their modalities stripped`
    );
    console.log(`       (${plain} of ${entries.length} entries are plain text / no evidence)`);
  });

  check("corpus: no multimedia capability is granted without its metadata evidence", () => {
    const evidence = { vision: "image", audio: "audio", video: "video", document: "pdf" };
    const offenders = [];
    for (const model of entries) {
      const caps = new Set(deriveCapabilities(model));
      const modalities = model.modalities?.input;
      for (const [capability, modality] of Object.entries(evidence)) {
        if (!caps.has(capability)) continue;
        if (!Array.isArray(modalities)) continue; // no detail available; fallback path applied
        if (!modalities.includes(modality)) offenders.push(`${model.id}:${capability}`);
      }
    }
    assert.equal(
      offenders.length,
      0,
      `${offenders.length} capability grants contradict modalities.input, e.g. ${offenders.slice(0, 5).join(", ")}`
    );
  });

  check("corpus: every modality in the payload is mapped", () => {
    const mapped = new Set(["image", "audio", "video", "pdf", "document", "file"]);
    const seen = new Set();
    for (const model of entries) {
      for (const modality of model.modalities?.input ?? []) seen.add(modality);
    }
    const unmapped = [...seen].filter((m) => !mapped.has(m) && m !== "text");
    assert.deepEqual(unmapped, [], `unmapped input modalities would silently grant nothing`);
  });

  //
  // Schema coverage. `ModelsDevModel` is a hand-written shape, so an optional field we forgot
  // is NOT a compile error -- nothing points at metadata we never read. The real payload is the
  // only authority on what the upstream schema emits, so it decides: any key present in the
  // cache but missing from the declared shape (or from the exported key list) fails here.
  //
  // This is what would have caught `interleaved` (present in 7842 entries, absent from the type).
  //
  check("corpus: every payload model field is declared in ModelsDevModel", () => {
    const declared = new Set(MODELS_DEV_MODEL_FIELDS);
    const undeclared = new Set();
    for (const model of entries) {
      for (const key of Object.keys(model)) {
        if (!declared.has(key)) undeclared.add(key);
      }
    }
    assert.deepEqual(
      [...undeclared].sort(),
      [],
      `models.dev emits field(s) ModelsDevModel does not declare — add them (plus the key list) ` +
        `so the shape stays honest about metadata we are ignoring`
    );
  });

  check("corpus: every payload cost field is declared in ModelsDevCost", () => {
    const declared = new Set(MODELS_DEV_COST_FIELDS);
    const undeclared = new Set();
    for (const model of entries) {
      for (const key of Object.keys(model.cost ?? {})) {
        if (!declared.has(key)) undeclared.add(key);
      }
    }
    assert.deepEqual([...undeclared].sort(), [], `models.dev emits cost field(s) not declared in ModelsDevCost`);
  });

  check("corpus: an interleaved entry never falls through to the plain adapter", () => {
    // `interleaved` is the only models.dev field that says reasoning comes back interleaved with
    // tool calls. 2 of the 1083 entries carrying it declare `reasoning: false` while naming a
    // reasoning echo field for the `reasoning_content` default — routing on the capability flag
    // alone gave those two no echo adapter at all, so their reasoning was never handed back.
    const offenders = [];
    let interleaved = 0;
    for (const model of entries) {
      if (!model.interleaved) continue;
      interleaved++;
      const info = parseModelsDevModel("test-vendor", model.id ?? "test-model", model);
      if (!shouldEchoReasoningContent(info)) {
        offenders.push(`${model.id}: reasoning=${model.reasoning}`);
      }
    }
    assert.deepEqual(
      offenders.slice(0, 5),
      [],
      `${offenders.length} interleaved entr(ies) would skip the reasoning adapter, e.g. ${offenders.slice(0, 3).join(", ")}`
    );
    console.log(`       (${interleaved} entries carry interleaved)`);
  });

  check("corpus: reasoning_details is resolved only for entries that name it", () => {
    // `reasoning_content` is the default the adapter already sends, so resolving it explicitly
    // would be redundant; a bare `true` names no field at all. Only `reasoning_details` is an
    // actual override, and getting this wrong would silently switch the wire field.
    const wrong = [];
    let details = 0;
    for (const model of entries) {
      const resolved = resolveReasoningEchoField(model);
      const named = model.interleaved && model.interleaved !== true ? model.interleaved.field : undefined;
      const expected = named === "reasoning_details" ? "reasoning_details" : undefined;
      if (expected === "reasoning_details") details++;
      if (resolved !== expected) wrong.push(`${model.id}: got ${resolved}, expected ${expected}`);
    }
    assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} entr(ies) resolved the wrong echo field`);
    // Non-vacuity WITHOUT pinning the count: entries naming `reasoning_details` are upstream data
    // that grows over time (this file's copy has gone 15 → 57), so an exact total rots the
    // validator on a data refresh rather than on a code change. The invariant is the mapping
    // (`wrong` above); all this needs to prove is that the branch was actually exercised.
    assert.ok(
      details > 0,
      "the corpus must contain at least one entry naming reasoning_details, or this check is vacuous"
    );
  });
}

// ============================================================================

console.log("");
if (errors.length > 0) {
  console.error(`model-capabilities validation FAILED (${errors.length} check(s))`);
  for (const e of errors) console.error(`  - ${e.name}: ${e.err?.message ?? e.err}`);
  process.exit(1);
}
console.log("model-capabilities validation passed");
