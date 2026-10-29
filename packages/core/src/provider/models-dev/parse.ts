/**
 * models.dev payload → {@link ModelInfo} — capabilities, pricing, reasoning depth and echo field.
 *
 * Pure functions only: no env, no cache, no I/O. `namedEffortValues` is shared with the ranking
 * module on purpose (see its doc).
 */

import {
  REASONING_EFFORT_VALUES,
  type ModelCapability,
  type ModelInfo,
  type ModelStyle,
  type ReasoningEchoField,
  type ReasoningEffort,
} from "../../models/types.js";

import type { ModelsDevModel } from "./types.js";

/**
 * Effort values we recognize from models.dev `reasoning_options` — derived from the one runtime
 * list, so adding a level in `models/types.ts` cannot leave the catalog silently dropping it.
 */
const REASONING_EFFORTS = new Set<ReasoningEffort>(REASONING_EFFORT_VALUES);

/**
 * The named effort levels a models.dev entry advertises (`reasoning_options[type=effort].values`).
 *
 * One definition, two consumers that MUST agree: `parseModelsDevModel` turns it into
 * `ModelInfo.reasoningConfig.effortValues` (what `/models` offers), and `compareModelEntries` uses
 * it to break ties between provider entries (see `lookup.ts`). If those two read the payload
 * differently, the lookup could rank an entry by a list it then declines to surface.
 *
 * Values models.dev emits that are not ours are dropped, never coerced: `null` (2 entries) and
 * `default` (2 entries) name no level of ours, and forwarding one would put a value on the wire that
 * `ReasoningEffort` does not contain. An entry advertising ONLY such values therefore has no named
 * levels — which is the honest answer, not "unparsed".
 */
export function namedEffortValues(data: ModelsDevModel): ReasoningEffort[] {
  if (!Array.isArray(data.reasoning_options)) return [];
  const effortOption = data.reasoning_options.find(
    (o) => typeof o === "object" && o !== null && (o as { type?: string }).type === "effort"
  ) as { values?: unknown[] } | undefined;
  return (effortOption?.values ?? []).filter(
    (v): v is ReasoningEffort => typeof v === "string" && REASONING_EFFORTS.has(v as ReasoningEffort)
  );
}

function resolveStyleFromModelsDevVendor(vendorId: string): ModelStyle {
  return vendorId === "anthropic" ? "anthropic" : "openai";
}

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
