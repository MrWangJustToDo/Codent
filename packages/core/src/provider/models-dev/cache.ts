/**
 * models.dev dataset cache — memory, workspace disk, network, and revalidation.
 *
 * The disk cache is read FIRST and the network is a background revalidation. Metadata is
 * best-effort and identity-stable (a new model appearing does not invalidate what we already
 * know about the old ones), so making every launch pay a network round-trip for a 9 MB payload
 * bought nothing but latency: measured 659ms over the wire vs 31ms from disk (21x), on the
 * critical path of `resolveModelConfigFromProvider` before the first frame.
 *
 * Refreshes do not block, EXCEPT when the disk cache is missing or past TTL — then a launch has
 * no usable metadata at all and waiting is the only correct option.
 *
 * Environment: this module reads the AMBIENT `getEnv()` (the process-global registry), not a
 * runtime-injected env — the one intentional exception to the run-path rule, allowlisted in
 * `validate-runtime-env-guard`. Keeping it here (rather than in the parse/rank modules) is what
 * makes the exception narrow: the metadata itself is identical across workspaces (so the
 * in-memory memo is process-global too) and there is no runtime in scope. Caveat: the disk path
 * is workspace-scoped, so with MORE THAN ONE runtime in a process the ambient env is the last
 * `registerCoreEnv`, and the disk cache binds to that runtime's root. Single-runtime hosts
 * (CLI / ACP) are unaffected.
 */

import { getEnv } from "../../env";
import { errorMessage } from "../../utils/errors.js";
import { AGENT_CACHE_DIR } from "../../utils/workspace-paths.js";

import type { ModelsDevData } from "./types.js";

/** Endpoint for the metadata dataset. Internal: the module exposes `fetchModelsDev`, not the URL. */
const MODELS_DEV_URL = "https://models.dev/api.json";

/** Timeout for the models.dev fetch — metadata is best-effort, never stall startup. */
const MODELS_DEV_FETCH_TIMEOUT_MS = 5_000;

/**
 * How long the disk cache counts as usable for a BLOCKING read (3 days).
 *
 * Within the window a launch answers from disk and revalidates in the background; past it the
 * read blocks on the network, because there is no fresh-enough metadata to serve. Extended from
 * 24h because the cost of a stale-but-present catalog is a missing brand-new model, while the
 * cost of a blocking fetch is on every launch.
 */
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

let memoryCache: ModelsDevData | null = null;

/** De-dupes background revalidation: concurrent callers share one in-flight network refresh. */
let refreshInFlight: Promise<void> | null = null;

/** Cause of the most recent network failure, so the "no data at all" throw can name it. */
let lastNetworkError: string | null = null;

function getCachePath(): string {
  const env = getEnv();
  return env.path.join(env.rootPath, AGENT_CACHE_DIR, "models-dev.json");
}

/**
 * How long ago the disk cache was written, or null when it is absent/unusable.
 *
 * Separate from {@link readDiskCache} so the freshness decision costs only a `stat` — the
 * 9 MB read + parse is skipped on the path where we are about to fetch anyway.
 */
async function getDiskCacheAgeMs(): Promise<number | null> {
  try {
    const env = getEnv();
    const stat = await env.fs.stat(getCachePath());
    if (!stat) return null;
    if (stat.isDirectory) return null;
    const mtimeMs = stat.mtime instanceof Date ? stat.mtime.getTime() : Number(stat.mtime);
    if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) {
      // An unusable mtime means we cannot prove freshness, so treat it as expired (blocking
      // fetch) rather than fresh (serve possibly-years-old metadata forever).
      return Number.POSITIVE_INFINITY;
    }
    return Date.now() - mtimeMs;
  } catch {
    return null;
  }
}

/** Read the disk cache regardless of TTL — the caller decides whether it is stale. */
async function readDiskCache(): Promise<ModelsDevData | null> {
  try {
    const env = getEnv();
    const content = await env.fs.readFile(getCachePath());
    return JSON.parse(content as string) as ModelsDevData;
  } catch {
    return null;
  }
}

async function writeDiskCache(data: ModelsDevData): Promise<void> {
  try {
    const env = getEnv();
    const path = getCachePath();
    const dir = env.path.dirname(path);
    // Ensure directory exists (recursive mkdir)
    try {
      await env.fs.stat(dir);
    } catch {
      await env.fs.mkdir(dir);
    }
    await env.fs.writeFile(path, JSON.stringify(data, null, 2));
  } catch {
    // Disk cache is best-effort; ignore errors.
  }
}

/**
 * Fetch the dataset over the network and cache it (memory + disk).
 *
 * Never throws: this is the revalidation path, so a failure must leave the existing cache in
 * place rather than surface. Returns whether the fetch landed.
 */
async function fetchModelsDevFromNetwork(): Promise<boolean> {
  try {
    const env = getEnv();
    const response = await env.fetch(MODELS_DEV_URL, {
      // An unreachable models.dev must not hang model resolution (CLI startup,
      // `POST /api/agent`, ACP bootstrap) — fail over to the disk cache.
      signal: AbortSignal.timeout(MODELS_DEV_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = (await response.json()) as ModelsDevData;
    memoryCache = data;
    lastNetworkError = null;
    await writeDiskCache(data);
    return true;
  } catch (err) {
    lastNetworkError = errorMessage(err);
    return false;
  }
}

/**
 * Start a background revalidation, de-duplicated across concurrent callers.
 *
 * Fire-and-forget by design: the caller already has usable metadata and must not wait. Failures
 * are swallowed (the caller keeps serving what it has; the next launch retries).
 */
function revalidateModelsDevInBackground(): void {
  if (refreshInFlight) return;
  refreshInFlight = fetchModelsDevFromNetwork()
    .then(() => undefined)
    .finally(() => {
      refreshInFlight = null;
    });
}

/**
 * Fetch the full models.dev dataset, using in-memory and disk caches.
 *
 * Order of preference (all measured — see the module header):
 *   1. in-memory (free)
 *   2. fresh-enough disk cache → return it, revalidate in the background (31ms vs 659ms)
 *   3. blocking network fetch (no usable cache: nothing else to serve)
 *   4. the disk cache anyway, even past TTL, when the network failed (offline launch)
 *
 * @throws only when every source is unavailable.
 */
export async function fetchModelsDev(): Promise<ModelsDevData> {
  if (memoryCache) return memoryCache;

  const age = await getDiskCacheAgeMs();
  if (age !== null && age <= CACHE_TTL_MS) {
    const disk = await readDiskCache();
    if (disk) {
      memoryCache = disk;
      revalidateModelsDevInBackground();
      return disk;
    }
  }

  // No usable cache: waiting is the only way to get metadata. `continueSession`-style freshness
  // does not exist here — the caller needs the catalog to resolve a model at all.
  if (await fetchModelsDevFromNetwork()) {
    return memoryCache!;
  }

  // Network failed. Serve the stale cache rather than nothing: years-old metadata still resolves
  // a model's context window and capabilities, which is far better than a startup error.
  const stale = await readDiskCache();
  if (stale) {
    memoryCache = stale;
    return stale;
  }

  throw new Error(
    `Failed to fetch model metadata from ${MODELS_DEV_URL}` +
      `${lastNetworkError ? `: ${lastNetworkError}` : ""}. No cached data available. ` +
      `Check your network connection or configure model metadata via MODEL_* env vars.`
  );
}
