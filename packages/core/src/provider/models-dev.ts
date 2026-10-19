/**
 * models.dev API integration — fetches up-to-date model metadata from
 * https://models.dev/api.json instead of hardcoding it in provider files.
 *
 * The API returns a flat map of providers, each with a nested map of models.
 * We transform the relevant fields into our {@link ModelInfo} shape.
 *
 * Caching:
 * - In-memory cache for the process lifetime.
 * - Disk cache at `<rootPath>/.agents/cache/models-dev.json` with a 3-day TTL.
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
 * runtime-injected env — an intentional exception to the run-path rule, allowlisted in
 * `validate-runtime-env-guard`. The metadata is identical across workspaces (so the in-memory memo
 * is process-global too) and there is no runtime in scope here. Caveat: the disk path is
 * workspace-scoped, so with MORE THAN ONE runtime in a process the ambient env is the last
 * `registerCoreEnv`, and the disk cache binds to that runtime's root. Single-runtime hosts
 * (CLI / ACP) are unaffected.
 */

import { getEnv } from "../env";
import { errorMessage } from "../utils/errors.js";

import type { ModelCapability, ModelInfo, ModelStyle, ReasoningEchoField, ReasoningEffort } from "../models/types.js";

// ============================================================================
// Constants
// ============================================================================

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** Effort values we recognize from models.dev `reasoning_options`. */
const REASONING_EFFORTS = new Set<ReasoningEffort>(["none", "low", "medium", "high", "xhigh", "max", "minimal"]);

/**
 * The named effort levels a models.dev entry advertises (`reasoning_options[type=effort].values`).
 *
 * One definition, two consumers that MUST agree: `parseModelsDevModel` turns it into
 * `ModelInfo.reasoningConfig.effortValues` (what `/models` offers), and `scoreModelEntry` uses it to
 * break ties between provider entries (below). If those two read the payload differently, the lookup
 * could rank an entry by a list it then declines to surface.
 *
 * Values models.dev emits that are not ours are dropped, never coerced: `null` (2 entries) and
 * `default` (2 entries) name no level of ours, and forwarding one would put a value on the wire that
 * `ReasoningEffort` does not contain. An entry advertising ONLY such values therefore has no named
 * levels — which is the honest answer, not "unparsed".
 */
function namedEffortValues(data: ModelsDevModel): ReasoningEffort[] {
  if (!Array.isArray(data.reasoning_options)) return [];
  const effortOption = data.reasoning_options.find(
    (o) => typeof o === "object" && o !== null && (o as { type?: string }).type === "effort"
  ) as { values?: unknown[] } | undefined;
  return (effortOption?.values ?? []).filter(
    (v): v is ReasoningEffort => typeof v === "string" && REASONING_EFFORTS.has(v as ReasoningEffort)
  );
}

/**
 * How long the disk cache counts as usable for a BLOCKING read (3 days).
 *
 * Within the window a launch answers from disk and revalidates in the background; past it the
 * read blocks on the network, because there is no fresh-enough metadata to serve. Extended from
 * 24h because the cost of a stale-but-present catalog is a missing brand-new model, while the
 * cost of a blocking fetch is on every launch.
 */
const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

function resolveStyleFromModelsDevVendor(vendorId: string): ModelStyle {
  return vendorId === "anthropic" ? "anthropic" : "openai";
}

// ============================================================================
// Types (minimal — only the fields we consume)
// ============================================================================

interface ModelsDevCost {
  // --- read by parseModelsDevModel / deriveCapabilities ---
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  // --- carried in the payload, not read today (see MODELS_DEV_MODEL_FIELDS) ---
  context_over_200k?: ModelsDevCost;
  input_audio?: number;
  output_audio?: number;
  reasoning?: number;
  tiers?: unknown[];
}

interface ModelsDevLimit {
  context?: number;
  input?: number;
  output?: number;
}

/**
 * models.dev `interleaved`: whether reasoning streams interleaved with tool calls, and on
 * which wire field.
 *
 * Carried in the payload but **not yet consumed** — `reasoning-echo.ts` hardcodes
 * `reasoning_content` while `field: "reasoning_details"` entries (and the OpenRouter default)
 * use the other name. Declared here so the shape is honest and the echo fix has a home.
 *
 * @see https://github.com/sst/models.dev — `packages/core/src/schema.ts`
 */
type ModelsDevInterleaved = true | { field?: "reasoning_content" | "reasoning_details" };

/**
 * The models.dev model record.
 *
 * Every field the schema can emit is listed, **including the ones we never read**, because an
 * omitted optional field is not a compile error. That is the failure this shape has actually
 * produced: `interleaved` was present in all 7842 cached entries and absent from this type, so
 * nothing pointed at the unread metadata. `MODELS_DEV_MODEL_FIELDS` closes that from the other
 * side — see its doc for the two-step argument that makes it airtight.
 */
interface ModelsDevModel {
  // --- read by parseModelsDevModel / deriveCapabilities ---
  id?: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: unknown[];
  tool_call?: boolean;
  structured_output?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: ModelsDevLimit;
  cost?: ModelsDevCost;
  // --- carried in the payload, not read today ---
  description?: string;
  family?: string;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  interleaved?: ModelsDevInterleaved;
  experimental?: Record<string, unknown>;
  provider?: Record<string, unknown>;
  status?: string;
  /** Upstream-added alias linking variant models to their canonical record; unread. */
  canonical_model_id?: string;
  /**
   * Model kind, when upstream marks one — observed values are `embedding` and `reranking`. Its
   * presence means "not a chat model"; absence means "chat". Unread today, so an embedding entry
   * in the corpus is still offered as a chat model. Declared rather than ignored so the guard can
   * see it, and so a future filter has a shape to read.
   */
  type?: string;
}

/**
 * The keys of {@link ModelsDevModel}, as a value.
 *
 * Two halves make the coverage airtight, and neither alone is enough:
 *
 * 1. `satisfies readonly (keyof ModelsDevModel)[]` — a name here that is not a declared field is
 *    a compile error, so this list can never over-claim.
 * 2. `validate:model-capabilities` asserts every key the REAL payload uses is in this list —
 *    TypeScript cannot enumerate an interface's keys, so completeness needs runtime evidence.
 *    Together: list ⊆ type (compile) and payload ⊆ list (guard) ⇒ payload ⊆ type.
 *
 * Exported only so that guard can read it; not part of the public package surface.
 */
export const MODELS_DEV_MODEL_FIELDS = [
  "id",
  "name",
  "attachment",
  "reasoning",
  "reasoning_options",
  "tool_call",
  "structured_output",
  "modalities",
  "limit",
  "cost",
  "description",
  "family",
  "temperature",
  "knowledge",
  "release_date",
  "last_updated",
  "open_weights",
  "interleaved",
  "experimental",
  "provider",
  "status",
  "canonical_model_id",
  "type",
] as const satisfies readonly (keyof ModelsDevModel)[];
/** Keys of {@link ModelsDevCost}, checked by the same guard (same drift trap, nested). */
export const MODELS_DEV_COST_FIELDS = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "context_over_200k",
  "input_audio",
  "output_audio",
  "reasoning",
  "tiers",
] as const satisfies readonly (keyof ModelsDevCost)[];

interface ModelsDevProvider {
  id: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevData = Record<string, ModelsDevProvider>;

// ============================================================================
// Cache
// ============================================================================

let memoryCache: ModelsDevData | null = null;

/** De-dupes background revalidation: concurrent callers share one in-flight network refresh. */
let refreshInFlight: Promise<void> | null = null;

/** Cause of the most recent network failure, so the "no data at all" throw can name it. */
let lastNetworkError: string | null = null;

function getCachePath(): string {
  const env = getEnv();
  return env.path.join(env.rootPath, ".agents", "cache", "models-dev.json");
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

// ============================================================================
// Fetch
// ============================================================================

/** Timeout for the models.dev fetch — metadata is best-effort, never stall startup. */
const MODELS_DEV_FETCH_TIMEOUT_MS = 5_000;

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

// ============================================================================
// Transform
// ============================================================================

/**
 * Convert a models.dev model entry into our {@link ModelInfo}.
 */
/**
 * Multimodal capability for each metadata input modality.
 *
 * models.dev's `modalities.input` (observed value set: `text` | `image` | `audio` | `video` |
 * `pdf`) is the authoritative, per-modality signal, so it is the primary source for the four
 * multimedia capabilities. `attachment` is a single boolean that means "accepts some
 * non-text input" — it cannot say WHICH — so it is only a fallback for entries with no
 * `modalities` array, and even then it grants `vision` only.
 */
const MODALITY_CAPABILITY: Record<string, ModelCapability> = {
  image: "vision",
  audio: "audio",
  video: "video",
  pdf: "document",
  // Aliases seen in the wild; kept because the cost of missing one is a wrong capability.
  document: "document",
  file: "document",
};

/**
 * Derive the capability list for a models.dev entry.
 *
 * Returns exactly what the metadata evidences, which for a plain text model is `[]`. That is
 * the intended answer, not a missing value: an empty array means "resolved, and none apply",
 * and it makes the send-gates strict for a model we can describe. `undefined` (unknown, gates
 * permissive) is reserved for the case where no metadata was resolved at all — it is the
 * absence of a {@link ModelInfo.capabilities} field, not an empty one.
 *
 * This used to seed a runtime-true capability (`streaming`) purely to keep the result non-empty,
 * because empty was indistinguishable from unknown. Now that the two states are separate, the
 * seed is gone and 330 plain-text or TTS entries correctly resolve to `[]` instead of being
 * treated as fully capable — previously they were exempt from pre-send stripping and would have
 * sent images to endpoints that reject them.
 *
 * `attachment` is deliberately NOT expanded into `vision` + `document`: it is one boolean and
 * cannot distinguish the two. Expanding it marked 2624 entries (34% of the catalog) as
 * document-capable when only 1837 accept `pdf`, and sent those entries down the
 * document-accepting branch of pre-send stripping. `modalities.input`, when present, is exact
 * in both directions.
 */
export function deriveCapabilities(data: ModelsDevModel): ModelCapability[] {
  const capabilities: ModelCapability[] = [];

  if (data.reasoning) capabilities.push("reasoning");
  if (data.tool_call) capabilities.push("tool_calling");
  if (data.structured_output) capabilities.push("json_output");
  if (data.cost?.cache_read !== undefined || data.cost?.cache_write !== undefined) {
    capabilities.push("prompt_caching");
  }

  const inputModalities = data.modalities?.input;
  if (Array.isArray(inputModalities)) {
    for (const modality of inputModalities) {
      const capability = MODALITY_CAPABILITY[modality];
      if (capability && !capabilities.includes(capability)) capabilities.push(capability);
    }
  } else if (data.attachment) {
    // No modality detail available — `attachment` only evidences image input.
    capabilities.push("vision");
  }

  return capabilities;
}

/** Wire field a model echoes its reasoning back on. See {@link ModelInfo.reasoningEchoField}. */
export type { ReasoningEchoField };

/**
 * Resolve the reasoning echo field from models.dev `interleaved`.
 *
 * Returns `undefined` when the metadata does not name one, which means "use the default"
 * (`reasoning_content`) — not "this model does not echo", which is decided by
 * {@link shouldEchoReasoning} instead.
 *
 * The flag is a union: `true` names no field, so all 86 bare-`true` entries resolve to
 * `undefined` and fall back to the default. Only the 15 entries that actually say
 * `reasoning_details` need the override, and the 982 that say `reasoning_content` agree with
 * the default — so the whole range is "default unless explicitly told otherwise".
 */
export function resolveReasoningEchoField(data: ModelsDevModel): ReasoningEchoField | undefined {
  const interleaved = data.interleaved;
  if (!interleaved || interleaved === true) return undefined;
  return interleaved.field === "reasoning_details" ? "reasoning_details" : undefined;
}

/**
 * Whether this entry should take the reasoning-echo adapter.
 *
 * Broader than the `reasoning` capability flag: 1083 entries carry `interleaved`, and 2 of them
 * (`siliconflow-cn/…/MiniMax-M2.5`, `novita-ai/minimax/minimax-m2.1`) declare
 * `reasoning: false` while still advertising a reasoning echo field. Taking the capability flag
 * alone left those two with no echo adapter at all, so a model that interleaves reasoning with
 * tool calls would never have its reasoning handed back.
 *
 * `interleaved` is the more precise signal for this specific question ("does reasoning come
 * back interleaved, and on which field") — it is the one field models.dev provides for it.
 */
export function shouldEchoReasoning(data: ModelsDevModel): boolean {
  return data.reasoning === true || data.interleaved !== undefined;
}

/**
 * Translate one models.dev record into our {@link ModelInfo}.
 *
 * Exported only so `validate:model-capabilities` can drive the REAL parse (including the
 * `interleaved` → echo-field/echo-adapter decisions) against the cached catalog instead of
 * restating it; it is not part of the public package surface.
 */
export function parseModelsDevModel(vendorId: string, modelId: string, data: ModelsDevModel): ModelInfo {
  const style = resolveStyleFromModelsDevVendor(vendorId);
  const capabilities = deriveCapabilities(data);

  const pricing = data.cost
    ? {
        inputPerM: data.cost.input ?? 0,
        outputPerM: data.cost.output ?? 0,
        ...(data.cost.cache_read !== undefined ? { cacheReadPerM: data.cost.cache_read } : {}),
        ...(data.cost.cache_write !== undefined ? { cacheWritePerM: data.cost.cache_write } : {}),
      }
    : undefined;

  // Derive reasoningConfig from reasoning_options if present. A `reasoning` model with no named
  // levels still gets a config object: `{}` says "thinking exists, but not in named levels" — the
  // distinction `offerableReasoningEfforts` reads, and the one `parseModelsDevModel` must not blur
  // by omitting the field entirely.
  let reasoningConfig: ModelInfo["reasoningConfig"];
  if (data.reasoning) {
    const effortValues = namedEffortValues(data);
    const hasMedium = effortValues.includes("medium");
    reasoningConfig = {
      ...(effortValues.length > 0 ? { effortValues } : {}),
      ...(hasMedium ? { defaultEffort: "medium" } : effortValues.length > 0 ? { defaultEffort: effortValues[0] } : {}),
    };
  }

  const reasoningEchoField = resolveReasoningEchoField(data);
  const reasoningInterleaved = shouldEchoReasoning(data);

  return {
    id: modelId,
    // models.dev descriptions carry the model's own variant names (e.g. "MiniMax‑M2.5" where the
    // record id is provider-prefixed). Prefer the description and fall back to the id — the record
    // id is sometimes not a name at all (`standardcompute/standardcompute`).
    name: data.name ?? data.description ?? modelId,
    style,
    apiModel: data.id ?? modelId,
    contextWindow: data.limit?.context ?? 0,
    defaultMaxTokens: data.limit?.output ?? 0,
    ...(pricing ? { pricing } : {}),
    capabilities,
    ...(reasoningConfig ? { reasoningConfig } : {}),
    ...(reasoningInterleaved ? { reasoningInterleaved: true } : {}),
    ...(reasoningEchoField ? { reasoningEchoField } : {}),
  };
}

// ============================================================================
// Lookup
// ============================================================================

/**
 * Look up a single model by ID from the models.dev dataset.
 *
 * Lookup strategies (first match wins):
 * 1. Prefixed: `"anthropic/claude-opus-4-8"` → search provider `anthropic`
 *    for model `claude-opus-4-8`.
 * 2. Hint-based: if `styleHint` is `"anthropic"`, search the anthropic vendor only.
 * 3. Bare: search all vendors by the bare model id (prefix stripped).
 *
 * @param modelId The model identifier to look up (may be prefixed).
 * @param styleHint Optional {@link ModelStyle} to narrow the search.
 * @returns The resolved {@link ModelInfo}, or `undefined` if not found.
 */
export async function lookupModelFromModelsDev(
  modelId: string,
  styleHint?: ModelStyle
): Promise<ModelInfo | undefined> {
  const data = await fetchModelsDev();

  // Split "provider/model" once so all strategies can reuse the bare id.
  // e.g. "zhipu/glm-5.2" → provPart="zhipu", bareId="glm-5.2"
  const slashIdx = modelId.indexOf("/");
  const provPart = slashIdx >= 0 ? modelId.slice(0, slashIdx) : undefined;
  const bareId = slashIdx >= 0 ? modelId.slice(slashIdx + 1) : modelId;

  // 1. Prefixed lookup: "provider/model" — exact provider match.
  if (provPart) {
    const provData = data[provPart];
    const modelData = provData?.models?.[bareId] ?? provData?.models?.[modelId];
    if (modelData) {
      return parseModelsDevModel(provPart, bareId, modelData);
    }
  }

  // 2. Hint-based lookup — anthropic style maps to the anthropic vendor on models.dev.
  if (styleHint === "anthropic") {
    const provData = data.anthropic;
    const modelData = provData?.models?.[bareId] ?? provData?.models?.[modelId];
    if (modelData) {
      return parseModelsDevModel("anthropic", bareId, modelData);
    }
  }

  // 3. Bare lookup — search all providers by the bare model id.
  //    This catches cases where the user's provider prefix differs from
  //    models.dev (e.g. "zhipu/glm-5.2" → models.dev has it under "zai").
  //    Multiple providers may carry the same model id; pick the one with the
  //    richest metadata so contextWindow / pricing / capabilities are accurate.
  //    Ties go to the entry that can actually describe the model's thinking depths
  //    (`compareModelEntries`) instead of to whichever key came first.
  const bareMatches: Array<{ provId: string; modelData: ModelsDevModel; score: number }> = [];
  for (const [provId, provData] of Object.entries(data)) {
    const modelData = provData.models?.[bareId] ?? provData.models?.[modelId];
    if (!modelData) continue;
    bareMatches.push({ provId, modelData, score: scoreModelEntry(modelData) });
  }
  if (bareMatches.length > 0) {
    bareMatches.sort(compareModelEntries);
    const best = bareMatches[0]!;
    return parseModelsDevModel(best.provId, bareId, best.modelData);
  }

  return undefined;
}

/**
 * Score a models.dev model entry by metadata richness. Higher is better.
 *
 * Used to pick the best match when the same model id appears under multiple
 * providers (e.g. `glm-5.2` is listed under `zai`, `zhipuai`, `siliconflow`,
 * …). We prefer entries that have:
 *   - non-zero pricing (real paid providers tend to have complete metadata)
 *   - a context window
 *   - an output limit
 *   - capability flags (reasoning, tool_call, …)
 *
 * Entries with zero pricing (free / coding-plan tiers) rank below paid ones
 * because their metadata is sometimes incomplete.
 *
 * Deliberately does NOT score advertised effort levels — see {@link compareModelEntries} for why that
 * belongs in the tie-break instead.
 */
function scoreModelEntry(data: ModelsDevModel): number {
  let score = 0;
  // Pricing — non-zero pricing signals a real paid listing with full metadata.
  if (data.cost) {
    const hasInput = data.cost.input !== undefined && data.cost.input > 0;
    const hasOutput = data.cost.output !== undefined && data.cost.output > 0;
    if (hasInput && hasOutput) score += 100;
    else if (hasInput || hasOutput)
      score += 50; // zero-price but present
    else score += 10; // cost object exists but all zero/missing
  }
  if (data.limit?.context) score += 20;
  if (data.limit?.output) score += 10;
  if (data.reasoning !== undefined) score += 5;
  if (data.tool_call !== undefined) score += 5;
  if (data.attachment !== undefined) score += 5;
  if (data.structured_output !== undefined) score += 5;
  if (data.modalities) score += 5;
  if (data.knowledge) score += 2;
  if (data.release_date) score += 2;
  return score;
}

/**
 * Rank two provider entries for the SAME model id: metadata richness first, then whether the entry can
 * describe thinking depths at all.
 *
 * Ties used to fall through to `Object.entries` order, which is payload key order — so which entry a
 * bare model id resolved to was effectively arbitrary. That was invisible while every reasoning model
 * got a depth menu, and became visible once `/models` started offering depths strictly (positive
 * evidence: `reasoning` AND a non-empty `effortValues`, see `offerableReasoningEfforts`): a
 * toggle-only entry now means NO depth submenu, while its equally-scored sibling advertises
 * `["low","high","max"]` for the same model. Measured over the cached catalog: **230** model ids
 * resolved to a level-less winner while an equally-scored sibling had levels, and this tie-break
 * recovers **206** of them.
 *
 * The tie-break is a BOOLEAN (has named levels / has none), never a comparison of how many or which —
 * that distinction is load-bearing and was caught by measurement. Ranking by level COUNT also moved
 * models that already had a menu, e.g. `deepseek/deepseek-v4.1-flash` went from `["low","high"]`
 * (aimlapi) to the full seven (llmgateway): both tied on metadata, so "more levels wins" rewrote a
 * working menu into one claiming `medium`/`xhigh`/`max` that the model may reject upstream. Two
 * catalogs disagreeing about a level set is not evidence that the larger set is right, and the only
 * defect worth fixing here is a model losing its menu entirely — so entries that both advertise levels
 * stay tied, and the existing order decides. That keeps the change strictly additive: no model's
 * available depths become a different SET than before, only empty ones (206) gain the set their sibling
 * already documented.
 *
 * Not a weight, either: `scoreModelEntry` must keep ranking metadata richness on its own, or a bare
 * entry that merely advertises levels would outrank a fully-described paid listing.
 */
function compareModelEntries(
  a: { modelData: ModelsDevModel; score: number },
  b: { modelData: ModelsDevModel; score: number }
): number {
  if (a.score !== b.score) return b.score - a.score;
  const aHasLevels = namedEffortValues(a.modelData).length > 0;
  const bHasLevels = namedEffortValues(b.modelData).length > 0;
  if (aHasLevels === bHasLevels) return 0;
  return bHasLevels ? 1 : -1;
}

/**
 * Get all models for a models.dev vendor id (e.g. "anthropic", "openai", "deepseek").
 */
export async function getModelsByProviderFromModelsDev(vendorId: string): Promise<ModelInfo[]> {
  const data = await fetchModelsDev();
  const provData = data[vendorId];
  if (!provData?.models) return [];

  return Object.entries(provData.models).map(([modelId, modelData]) =>
    parseModelsDevModel(vendorId, modelId, modelData)
  );
}
