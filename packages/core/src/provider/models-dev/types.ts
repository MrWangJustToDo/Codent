/**
 * models.dev payload shapes — the fields we consume, and the full key lists the guard checks.
 *
 * The API returns a flat map of providers, each with a nested map of models. These interfaces are
 * the minimal projection onto {@link ModelInfo}; `MODELS_DEV_MODEL_FIELDS` / `MODELS_DEV_COST_FIELDS`
 * close the "optional field omitted from the type is invisible" gap from the other side.
 */

export interface ModelsDevCost {
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

export interface ModelsDevLimit {
  context?: number;
  input?: number;
  output?: number;
}

/**
 * models.dev `interleaved`: whether reasoning streams interleaved with tool calls, and on
 * which wire field.
 *
 * Consumed by `parse.ts`: `shouldEchoReasoning` routes the echo adapter (including the two entries
 * that declare `reasoning: false` but still interleave) and `resolveReasoningEchoField` maps
 * `field: "reasoning_details"` to the non-default wire field. A bare `true` names no field and
 * therefore keeps the `reasoning_content` default.
 *
 * @see https://github.com/sst/models.dev — `packages/core/src/schema.ts`
 */
export type ModelsDevInterleaved = true | { field?: "reasoning_content" | "reasoning_details" };

/**
 * The models.dev model record.
 *
 * Every field the schema can emit is listed, **including the ones we never read**, because an
 * omitted optional field is not a compile error. That is the failure this shape has actually
 * produced: `interleaved` was present in all 7842 cached entries and absent from this type, so
 * nothing pointed at the unread metadata. `MODELS_DEV_MODEL_FIELDS` closes that from the other
 * side — see its doc for the two-step argument that makes it airtight.
 */
export interface ModelsDevModel {
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

export interface ModelsDevProvider {
  id: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevData = Record<string, ModelsDevProvider>;
