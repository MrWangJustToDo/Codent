/**
 * Old/new equivalence helper for the control-plane migration.
 *
 * Every convergence step runs the new path beside the old one and compares the observable outcome
 * before the old path is deleted. "Observable" means the value the caller would see plus the error
 * shape — not timing, internal counters or method calls. Comparison is order-insensitive for object
 * keys and normalized for `Error`, `Map`, `Set`, `undefined` and `bigint`, so an incidental shape
 * difference does not hide a real divergence.
 *
 * The helper deliberately runs the two paths SEQUENTIALLY by default: the old and new writers may
 * touch the same session/agent object, and running them concurrently would make the comparison
 * depend on interleaving. A caller whose paths are independent can pass `concurrent: true`.
 *
 * Run this file directly for a self-test:
 *   node scripts/helpers/equivalence.mjs
 */

import assert from "node:assert/strict";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Run one path, capturing a thrown value as data so both outcomes can be compared. */
export async function captureOutcome(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function normalizeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, code: /** @type {any} */ (error).code };
  }
  return { thrown: String(error) };
}

/**
 * Stable, JSON-like normalization. Object keys are sorted, `undefined` becomes an explicit marker
 * (so `{a: undefined}` and `{}` differ), and cycles are named by a back-reference marker.
 */
export function stableNormalize(value, seen = new WeakSet()) {
  if (value === undefined) return { __undefined__: true };
  if (typeof value === "bigint") return { __bigint__: value.toString() };
  if (typeof value === "function") return { __function__: value.name || "anonymous" };
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return { __circular__: true };
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => stableNormalize(entry, seen));
    if (value instanceof Map) {
      return {
        __map__: [...value.entries()]
          .map(([key, entry]) => [stableNormalize(key, seen), stableNormalize(entry, seen)])
          .sort((a, b) => JSON.stringify(a[0]).localeCompare(JSON.stringify(b[0]))),
      };
    }
    if (value instanceof Set) {
      return {
        __set__: [...value]
          .map((entry) => stableNormalize(entry, seen))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      };
    }
    if (value instanceof Error) return normalizeError(value);
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableNormalize(value[key], seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Run both paths and assert the same observable outcome.
 *
 * @param {string} name  What is being compared (used in the assertion message).
 * @param {{ oldRun: () => unknown | Promise<unknown>, newRun: () => unknown | Promise<unknown>, normalize?: (value: unknown) => unknown, concurrent?: boolean, message?: string }} options
 * @returns the OLD outcome (`{ok, value}` / `{ok, error}`), so a caller can reuse it.
 */
export async function assertEquivalent(name, options) {
  const { oldRun, newRun, normalize = stableNormalize, concurrent = false, message } = options;
  let oldOutcome;
  let newOutcome;
  if (concurrent) {
    [oldOutcome, newOutcome] = await Promise.all([captureOutcome(oldRun), captureOutcome(newRun)]);
  } else {
    oldOutcome = await captureOutcome(oldRun);
    newOutcome = await captureOutcome(newRun);
  }
  assert.deepEqual(
    normalize(newOutcome),
    normalize(oldOutcome),
    message ?? `${name}: the old and new control-plane paths disagree`
  );
  return oldOutcome;
}

async function selfTest() {
  await assertEquivalent("key order", {
    oldRun: () => ({ b: 1, a: [2, 1] }),
    newRun: () => ({ a: [2, 1], b: 1 }),
  });
  await assertEquivalent("error shape", {
    oldRun: () => {
      throw new Error("boom");
    },
    newRun: () => {
      throw new Error("boom");
    },
  });
  await assertEquivalent("map order", {
    oldRun: () =>
      new Map([
        ["b", 2],
        ["a", 1],
      ]),
    newRun: () =>
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
  });
  await assert.rejects(
    () => assertEquivalent("real divergence", { oldRun: () => 1, newRun: () => 2 }),
    /old and new control-plane paths disagree/
  );
  await assert.rejects(
    () => assertEquivalent("undefined vs absent", { oldRun: () => ({ a: undefined }), newRun: () => ({}) }),
    /disagree/
  );
  console.log("equivalence helper self-test: ok");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await selfTest();
}
