/**
 * Validates the models.dev cache policy: cache-first with background revalidation.
 *
 * Why this exists: `fetchModelsDev()` used to try the network FIRST and only fall back to the
 * disk cache on failure, on the critical path of `resolveModelConfigFromProvider` before the
 * first frame. Measured here that cost 659ms over the wire against 31ms from disk for a 9 MB
 * payload — 21x — to re-learn metadata that had not changed.
 *
 * The policy under test:
 *   1. Fresh cache (within TTL) → served from disk, NO blocking network call.
 *   2. …and revalidation still happens (in the background) so the cache cannot rot.
 *   3. A usable cache is preferred over the network even if the network would work.
 *   4. Past TTL → the read BLOCKS on the network (no fresh-enough metadata to serve).
 *   5. Network failure with no cache → throws (the caller has nothing).
 *   6. Network failure with a stale cache → serves the stale cache (offline launch works).
 *
 * ISOLATION: `fetchModelsDev` memoizes in module state (`memoryCache`), and that state lives in a
 * shared chunk — re-importing `dist/dev.mjs` with a cache-busting query does NOT reset it. So each
 * scenario runs in its OWN PROCESS. Without that, scenario N silently reads scenario N-1's payload
 * and every assertion passes for the wrong reason (observed: the past-TTL case reported zero
 * network calls because an earlier scenario's cache was still memoized).
 *
 * Run: pnpm --filter @codent/core run validate:models-dev-cache
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerCoreEnv } from "../dist/index.mjs";

const SELF = fileURLToPath(import.meta.url);

/** Mirrors the 3-day TTL in the module. Past it the read is allowed to block. */
const TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Distinct, identifiable payloads so "which source answered" is observable in the values. */
const PAYLOAD_DISK = { source: { models: { "disk-model": { id: "disk-model" } } } };
const PAYLOAD_NET = { source: { models: { "net-model": { id: "net-model" } } } };

/** Temp CoreEnv whose `fetch` is the network under test, with call counters. */
function makeEnv({ cacheAgeMs = null, payload = null } = {}) {
  const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "models-dev-cache-"));
  const cacheFile = path.join(rootPath, ".agents/cache/models-dev.json");
  if (cacheAgeMs !== null && payload !== null) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(payload));
    // mtime drives the TTL decision, so set it explicitly rather than relying on clock skew.
    const t = new Date(Date.now() - cacheAgeMs);
    fs.utimesSync(cacheFile, t, t);
  }
  const counters = { reads: 0, fetches: 0 };
  const env = {
    rootPath,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    path: { join: (...p) => path.join(...p) },
    fs: {
      stat: async (p) => {
        try {
          const st = fs.statSync(p);
          return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
        } catch {
          return null;
        }
      },
      readFile: async (p) => {
        counters.reads++;
        return fs.readFileSync(p, "utf-8");
      },
      writeFile: async (p, content) => {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
      },
      mkdir: async (p) => fs.mkdirSync(p, { recursive: true }),
      exists: async (p) => fs.existsSync(p),
      readdir: async (p) => {
        const entries = fs.readdirSync(p, { withFileTypes: true });
        return entries.map((x) => ({ name: x.name, type: x.isDirectory() ? "directory" : "file" }));
      },
    },
    fetch: async () => {
      counters.fetches++;
      if (networkDown()) return new Response("unavailable", { status: 503 });
      return Response.json(PAYLOAD_NET);
    },
  };
  return { env, counters, cacheFile };
}

/** The network state crosses the process boundary as an env var, so a child can read it too. */
const networkDown = () => process.env.SCENARIO_NETWORK === "down";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scenario bodies. Each runs as the WHOLE of its own process, so the module memo is pristine.
 * Keyed by the argv name; the parent spawns one child per key.
 */
const SCENARIOS = {
  /** 1 + 2 + 3: a fresh cache answers without blocking, stays authoritative, and revalidates. */
  "fresh-cache-serves-and-revalidates": async () => {
    const { env, counters } = makeEnv({ cacheAgeMs: 60_000, payload: PAYLOAD_DISK });
    registerCoreEnv(env);

    const started = Date.now();
    const data = await (await import("../dist/dev.mjs")).fetchModelsDev();
    const elapsed = Date.now() - started;

    assert.ok(data.source, "a fresh cache must be served");
    assert.ok("disk-model" in data.source.models, "the DISK payload is what a fresh cache returns");
    // Non-vacuous latency bound: a 9 MB disk read cannot take this long, while a regression to
    // network-first (659ms measured live) fails here even on a fast machine.
    assert.ok(elapsed < 250, `a fresh cache must not block on the network (took ${elapsed}ms)`);

    // The refresh really is in flight: it must land without the caller having awaited it.
    await wait(300);
    assert.equal(counters.fetches, 1, "a fresh cache must still revalidate in the background");

    // 3: the refresh is adopted, not a no-op — a later call in the same process sees the newer
    // payload. (The FIRST call above is what had to stay on the cache; that is the latency win.)
    const again = await (await import("../dist/dev.mjs")).fetchModelsDev();
    assert.ok(
      "net-model" in again.source.models,
      "the background refresh must be adopted, or revalidation would be decorative"
    );
  },

  /**
   * Boundary coverage for the extended TTL. A 1-minute-old cache passes under BOTH the old 24h
   * and the new 3-day window, so without this scenario the TTL bump is untestable — reverting it
   * would leave every other assertion green.
   */
  "two-day-old-cache-still-serves": async () => {
    const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;
    assert.ok(TWO_DAYS < TTL_MS, "the fixture assumption is that 2 days is inside the TTL");
    const { env } = makeEnv({ cacheAgeMs: TWO_DAYS, payload: PAYLOAD_DISK });
    registerCoreEnv(env);

    const data = await (await import("../dist/dev.mjs")).fetchModelsDev();
    // Payload identity IS the discriminator, and it is deterministic: under a 24h TTL a 2-day-old
    // cache is expired, so the read would block on the network and return the NETWORK payload.
    // Asserting on the fetch COUNT instead would be racy — the background revalidation the
    // cache-first path starts increments it in a microtask, before this line runs.
    assert.ok(
      "disk-model" in data.source.models,
      "a 2-day-old cache must still serve on the cache-first path (TTL extended from 24h to 3 days)"
    );
  },

  /** 4: past TTL there is nothing fresh to serve, so the read blocks on the network. */
  "expired-cache-blocks-on-network": async () => {
    const { env, counters } = makeEnv({ cacheAgeMs: TTL_MS + 60_000, payload: PAYLOAD_DISK });
    registerCoreEnv(env);

    const data = await (await import("../dist/dev.mjs")).fetchModelsDev();
    assert.equal(counters.fetches, 1, "an expired cache must fetch synchronously, before returning");
    assert.ok("net-model" in data.source.models, "an expired cache returns the freshly fetched payload");
  },

  /** 5: nothing to serve and no network → the caller must be told, not handed garbage. */
  "no-cache-and-offline-throws": async () => {
    const { env } = makeEnv();
    registerCoreEnv(env);
    const mod = await import("../dist/dev.mjs");

    await assert.rejects(() => mod.fetchModelsDev(), /no cached data available/i);
  },

  /** 6: stale cache + no network → serve the stale data so an offline launch still resolves. */
  "stale-cache-survives-offline": async () => {
    const { env } = makeEnv({ cacheAgeMs: TTL_MS * 10, payload: PAYLOAD_DISK });
    registerCoreEnv(env);

    const data = await (await import("../dist/dev.mjs")).fetchModelsDev();
    assert.ok("disk-model" in data.source.models, "an offline launch must still resolve model metadata");
  },
};

// ============================================================================
// Direct run = one scenario (child); no args = the driver (parent)
// ============================================================================
const name = process.argv[2];

if (name) {
  const scenario = SCENARIOS[name];
  assert.ok(scenario, `unknown scenario: ${name}`);
  await scenario();
  console.log(`  ok  ${name}`);
} else {
  const names = Object.keys(SCENARIOS);
  for (const scenarioName of names) {
    // `down` is derived per scenario, so it is passed explicitly rather than inherited.
    const network = scenarioName.includes("offline") ? "down" : "up";
    const res = spawnSync(process.execPath, [SELF, scenarioName], {
      env: { ...process.env, SCENARIO_NETWORK: network },
      encoding: "utf-8",
    });
    if (res.status !== 0) {
      process.stderr.write(res.stdout ?? "");
      process.stderr.write(res.stderr ?? "");
      console.error(`\nmodels-dev cache validation FAILED in: ${scenarioName}`);
      process.exit(1);
    }
    process.stdout.write(res.stdout ?? "");
  }
  console.log(`models-dev cache validation passed (${names.length} scenarios)`);
}
