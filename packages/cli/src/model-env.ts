// ============================================================================
// Model Metadata from Environment Variables
// ============================================================================

import { MODEL_CAPABILITIES } from "@codent/core";
import { z } from "zod";

import type {
  ModelCapability,
  ModelInfo,
  ModelPricing,
  ModelStyle,
  ReasoningConfig,
  ReasoningEffort,
} from "@codent/core";

/**
 * Zod schema for a single capability string.
 *
 * Validates against `MODEL_CAPABILITIES` — the single source of truth for the capability list
 * (its members are derived from that array, so this cannot go stale the way a copied list
 * does). An unknown value FAILS rather than falling through: a typo'd capability silently
 * becomes a no-op `capabilities` entry, which the permissive empty-list semantics would then
 * mask as "unknown model".
 */
const capabilitySchema = z.string().transform((val, ctx): ModelCapability => {
  if (!(MODEL_CAPABILITIES as readonly string[]).includes(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown capability "${val}". Known: ${MODEL_CAPABILITIES.join(", ")}`,
    });
    return z.NEVER;
  }
  return val as ModelCapability;
});

/**
 * Zod schema for pricing configuration (USD per 1M tokens).
 */
const pricingSchema = z.object({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  cacheWritePerM: z.number().nonnegative().optional(),
  cacheReadPerM: z.number().nonnegative().optional(),
});

/**
 * Zod schema for the full env-driven ModelInfo override.
 * All fields are optional except where the registry cannot supply a default.
 */
export const ModelEnvConfigSchema = z.object({
  /** Display name shown in the UI. Falls back to the model id. */
  name: z.string().min(1).optional(),
  /**
   * API style override for metadata. Falls back to connection style when unset.
   *
   * Trimmed + lowercased before the enum, like the shared connection parser: `MODEL_STYLE=Anthropic`
   * used to throw here while the ACP entry silently resolved it to `openai`.
   */
  style: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["openai", "anthropic"]))
    .optional(),
  /** Model string sent to the API (defaults to MODEL env value). */
  apiModel: z.string().optional(),
  /** Max input context window in tokens. */
  contextWindow: z.number().int().positive().optional(),
  /** Default max output tokens. */
  defaultMaxTokens: z.number().int().positive().optional(),
  /** Whether the model supports vision / multimodal input. Convenience flag. */
  multimodal: z.boolean().optional(),
  /** Pricing in USD per 1M tokens. */
  pricing: pricingSchema.optional(),
  /** Additional capability flags (multimodal adds "vision" automatically). */
  capabilities: z.array(capabilitySchema).optional(),
  /** Tag name used to extract reasoning (e.g. "think"). */
  reasoningTagName: z.string().optional(),
  /** Default reasoning effort. */
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max", "minimal"]).optional(),
  /** Comma-separated effort values the model accepts (from models.dev). */
  reasoningEffortValues: z.array(z.enum(["none", "low", "medium", "high", "xhigh", "max", "minimal"])).optional(),
  /** Max thinking budget in tokens. */
  reasoningMaxBudget: z.number().int().positive().optional(),
  /** Whether this should be the default model for its provider. */
  isDefault: z.boolean().optional(),
});
export type ModelEnvConfig = z.infer<typeof ModelEnvConfigSchema>;

/**
 * Set of MODEL_* environment variable names consumed by {@link parseModelInfoFromEnv}.
 * Centralized so hosts (CLI, server, extension) can document or validate them.
 */
export const MODEL_ENV_KEYS = [
  "MODEL_NAME",
  "MODEL_STYLE",
  "MODEL_API_NAME",
  "MODEL_CONTEXT_WINDOW",
  "MODEL_MAX_OUTPUT",
  "MODEL_MULTIMODAL",
  "MODEL_PRICE_INPUT",
  "MODEL_PRICE_OUTPUT",
  "MODEL_PRICE_CACHE_WRITE",
  "MODEL_PRICE_CACHE_READ",
  "MODEL_CAPABILITIES",
  "MODEL_REASONING_TAG",
  "MODEL_REASONING_EFFORT",
  "MODEL_REASONING_EFFORT_VALUES",
  "MODEL_REASONING_BUDGET",
  "MODEL_IS_DEFAULT",
] as const;

/**
 * Parse a comma-separated capability list like "reasoning,tool_calling,vision".
 */
function parseCapabilitiesList(raw: string): ModelCapability[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ModelCapability[];
}

/**
 * Parse a comma-separated reasoning-effort list like "low,medium,high".
 */
function parseEffortList(raw: string): ReasoningEffort[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as ReasoningEffort[];
}

/**
 * Parse a single env value into a number, returning undefined on failure.
 * Accepts both "1048576" and "1_048_576" (underscores stripped).
 */
function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const cleaned = raw.replace(/_/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : undefined;
}

function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return undefined;
}

/**
 * Build a {@link ModelEnvConfig} from a raw env record.
 *
 * Reads the {@link MODEL_ENV_KEYS} set. Unknown keys are ignored, so hosts
 * can pass the full `process.env` (or a remote env map) directly.
 *
 * @example
 * ```typescript
 * const cfg = parseModelEnvConfig(process.env);
 * if (cfg) console.log(cfg.contextWindow);
 * ```
 */
export function parseModelEnvConfig(env: Record<string, string | undefined>): ModelEnvConfig | undefined {
  const hasAny = MODEL_ENV_KEYS.some((k) => env[k] !== undefined && env[k] !== "");
  if (!hasAny) return undefined;

  const capabilitiesRaw = env.MODEL_CAPABILITIES;
  const capabilities = capabilitiesRaw ? parseCapabilitiesList(capabilitiesRaw) : undefined;

  // Build pricing only if any price field is present
  const inputPerM = parseNumber(env.MODEL_PRICE_INPUT);
  const outputPerM = parseNumber(env.MODEL_PRICE_OUTPUT);
  let pricing: z.infer<typeof pricingSchema> | undefined;
  if (inputPerM !== undefined || outputPerM !== undefined) {
    pricing = {
      inputPerM: inputPerM ?? 0,
      outputPerM: outputPerM ?? 0,
      ...(parseNumber(env.MODEL_PRICE_CACHE_WRITE) !== undefined
        ? { cacheWritePerM: parseNumber(env.MODEL_PRICE_CACHE_WRITE) }
        : {}),
      ...(parseNumber(env.MODEL_PRICE_CACHE_READ) !== undefined
        ? { cacheReadPerM: parseNumber(env.MODEL_PRICE_CACHE_READ) }
        : {}),
    };
  }

  const raw = {
    ...(env.MODEL_NAME ? { name: env.MODEL_NAME } : {}),
    ...(env.MODEL_STYLE ? { style: env.MODEL_STYLE as ModelStyle } : {}),
    ...(env.MODEL_API_NAME ? { apiModel: env.MODEL_API_NAME } : {}),
    ...(parseNumber(env.MODEL_CONTEXT_WINDOW) !== undefined
      ? { contextWindow: parseNumber(env.MODEL_CONTEXT_WINDOW) }
      : {}),
    ...(parseNumber(env.MODEL_MAX_OUTPUT) !== undefined ? { defaultMaxTokens: parseNumber(env.MODEL_MAX_OUTPUT) } : {}),
    ...(parseBoolean(env.MODEL_MULTIMODAL) !== undefined ? { multimodal: parseBoolean(env.MODEL_MULTIMODAL) } : {}),
    ...(pricing ? { pricing } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(env.MODEL_REASONING_TAG ? { reasoningTagName: env.MODEL_REASONING_TAG } : {}),
    ...(env.MODEL_REASONING_EFFORT ? { reasoningEffort: env.MODEL_REASONING_EFFORT as ReasoningEffort } : {}),
    ...(env.MODEL_REASONING_EFFORT_VALUES
      ? { reasoningEffortValues: parseEffortList(env.MODEL_REASONING_EFFORT_VALUES) }
      : {}),
    ...(parseNumber(env.MODEL_REASONING_BUDGET) !== undefined
      ? { reasoningMaxBudget: parseNumber(env.MODEL_REASONING_BUDGET) }
      : {}),
    ...(parseBoolean(env.MODEL_IS_DEFAULT) !== undefined ? { isDefault: parseBoolean(env.MODEL_IS_DEFAULT) } : {}),
  };

  const parsed = ModelEnvConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // Aggregate issues into a single readable message and throw.
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid MODEL_* env config: ${msg}`);
  }
  return parsed.data;
}

/**
 * Resolve a complete {@link ModelInfo} from env config + the active model id.
 *
 * - If `envConfig` is undefined, returns undefined (no override).
 * - `modelId` is the active MODEL value (used as id / apiModel / name fallbacks).
 * - `fallbackStyle` is used when neither env nor models.dev can supply a style.
 *
 * The `multimodal: true` flag automatically adds the "vision" and "document"
 * capabilities unless `capabilities` is explicitly provided.
 *
 * @example
 * ```typescript
 * const envCfg = parseModelEnvConfig(process.env);
 * const info = resolveModelInfoFromEnv(envCfg, process.env.MODEL);
 * if (info) registerModel(info);
 * ```
 */
export function resolveModelInfoFromEnv(
  envConfig: ModelEnvConfig | undefined,
  modelId: string,
  fallbackStyle?: ModelStyle
): ModelInfo | undefined {
  if (!envConfig) return undefined;

  const style = envConfig.style ?? fallbackStyle ?? "openai";

  // Merge capabilities: explicit list > [multimodal ? vision+document] > unknown.
  //
  // The final branch is `undefined`, NOT `[]`. A bare env config declares nothing about the
  // model, so its capabilities are unknown and the permissive probe applies — emitting `[]`
  // here would assert "this model supports no modalities", which for a user who simply set
  // MODEL without metadata would strip every image before send.
  let capabilities: ModelCapability[] | undefined;
  if (envConfig.capabilities) {
    capabilities = [...envConfig.capabilities];
    if (envConfig.multimodal) {
      if (!capabilities.includes("vision")) capabilities.push("vision");
      if (!capabilities.includes("document")) capabilities.push("document");
    }
  } else if (envConfig.multimodal) {
    capabilities = ["vision", "document"];
  } else {
    capabilities = undefined;
  }

  let reasoningConfig: ReasoningConfig | undefined;
  if (
    envConfig.reasoningTagName ||
    envConfig.reasoningEffort ||
    envConfig.reasoningEffortValues ||
    envConfig.reasoningMaxBudget !== undefined
  ) {
    reasoningConfig = {
      ...(envConfig.reasoningTagName ? { tagName: envConfig.reasoningTagName } : {}),
      ...(envConfig.reasoningEffort ? { defaultEffort: envConfig.reasoningEffort } : {}),
      ...(envConfig.reasoningEffortValues ? { effortValues: envConfig.reasoningEffortValues } : {}),
      ...(envConfig.reasoningMaxBudget !== undefined ? { maxBudget: envConfig.reasoningMaxBudget } : {}),
    };
  }

  let pricing: ModelPricing | undefined;
  if (envConfig.pricing) {
    pricing = {
      inputPerM: envConfig.pricing.inputPerM,
      outputPerM: envConfig.pricing.outputPerM,
      ...(envConfig.pricing.cacheWritePerM !== undefined ? { cacheWritePerM: envConfig.pricing.cacheWritePerM } : {}),
      ...(envConfig.pricing.cacheReadPerM !== undefined ? { cacheReadPerM: envConfig.pricing.cacheReadPerM } : {}),
    };
  }

  return {
    id: modelId,
    name: envConfig.name ?? modelId,
    style,
    apiModel: envConfig.apiModel ?? modelId,
    // No default fallbacks — if env doesn't provide these, the caller should
    // fetch from models.dev or fail with a clear error. Assuming wrong values
    // (e.g. 128k context for a 1M model) causes silent compaction bugs.
    ...(envConfig.contextWindow !== undefined ? { contextWindow: envConfig.contextWindow } : {}),
    ...(envConfig.defaultMaxTokens !== undefined ? { defaultMaxTokens: envConfig.defaultMaxTokens } : {}),
    ...(pricing ? { pricing } : {}),
    // Omitted entirely when unknown, matching the spread-guarded fields around it: an explicit
    // `capabilities: undefined` and an absent key mean the same thing here, and the spread keeps
    // the object shape honest about what env actually declared.
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(reasoningConfig ? { reasoningConfig } : {}),
    ...(envConfig.isDefault !== undefined ? { isDefault: envConfig.isDefault } : {}),
  };
}

/**
 * Convenience: read env → config → ModelInfo in one call.
 *
 * @example
 * ```typescript
 * const info = parseModelInfoFromEnv(process.env, "qwen2.5-coder:7b");
 * ```
 */
export function parseModelInfoFromEnv(
  env: Record<string, string | undefined>,
  modelId: string,
  fallbackStyle?: ModelStyle
): ModelInfo | undefined {
  const cfg = parseModelEnvConfig(env);
  return resolveModelInfoFromEnv(cfg, modelId, fallbackStyle);
}
