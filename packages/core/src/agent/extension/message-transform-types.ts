/**
 * Message-transform contract: the per-wire-call rewrite of the model-facing message chain.
 *
 * Split out of `types.ts` (which is at the lint file-size ceiling). The capability-flag table is
 * the only runtime value here; everything else is type-only, so this module adds no dependency
 * from the extension lifecycle surface beyond the context type it is handed.
 */

import type { ExtensionContext } from "./types.js";
import type { ModelCapability } from "../../models/types.js";
import type { MultimodalPartType } from "../../utils/multimodal-part-types.js";
import type { ModelMessage } from "@tanstack/ai";

/**
 * Where in a run the wire is being built.
 *
 * - `init` — the first model call of the run.
 * - `iteration` — any later call (after tool results / mid-loop appends).
 *
 * Deliberately not a numeric iteration index: a transformer must not need to
 * track run history, and the value stays meaningful across restart-style retries.
 */
export type MessageTransformPhase = "init" | "iteration";

/**
 * Capability → the transformer-context flag name that exposes it.
 *
 * `satisfies Record<ModelCapability, ...>` is the guard that matters: adding a member to
 * `MODEL_CAPABILITIES` breaks compilation HERE until this map names it. That is what keeps
 * the capability list and the transformer's flag surface from drifting apart — the failure
 * is a type error at the definition site, not a silently missing flag at runtime.
 *
 * Flag names are flat (`modelHasToolCalling`, not `modelHas.toolCalling`) so extension code
 * reads as prose and existing consumers keep working.
 */
export const MODEL_CAPABILITY_FLAGS = {
  reasoning: "modelHasReasoning",
  vision: "modelHasVision",
  audio: "modelHasAudio",
  video: "modelHasVideo",
  document: "modelHasDocument",
  tool_calling: "modelHasToolCalling",
  prompt_caching: "modelHasPromptCaching",
  json_output: "modelHasJsonOutput",
} as const satisfies Record<ModelCapability, string>;

/** The per-capability boolean flags carried by {@link MessageTransformContext}. */
export type ModelCapabilityFlags = {
  [K in keyof typeof MODEL_CAPABILITY_FLAGS as (typeof MODEL_CAPABILITY_FLAGS)[K]]: boolean;
};

/**
 * Build the flag record for a capability probe.
 *
 * Iterates {@link MODEL_CAPABILITY_FLAGS} rather than listing capabilities, so the values
 * and the type come from the same table. A capability absent from the probe's declared set
 * falls back to the probe's own permissive `hasCapability` semantics.
 */
export function buildModelCapabilityFlags(has: (cap: ModelCapability) => boolean): ModelCapabilityFlags {
  const flags: Record<string, boolean> = {};
  for (const [capability, flag] of Object.entries(MODEL_CAPABILITY_FLAGS)) {
    flags[flag] = has(capability as ModelCapability);
  }
  return flags as ModelCapabilityFlags;
}

export interface MessageTransformContext extends ModelCapabilityFlags {
  /** Id of the extension that registered this transformer. */
  extensionId: string;
  /**
   * Id of the agent whose run is building this wire call.
   *
   * Per-run authoritative value (same source as the tool execution context's `agentId`),
   * not the registration-time agent id.
   */
  agentId: string;
  /** Which model call of the run this is. */
  phase: MessageTransformPhase;
  /**
   * Model messages produced by the channel-anchored wire projection, exclusively
   * owned by the transformer for the duration of this call.
   *
   * Tool results have already been projected through their tool's `toModelOutput`
   * (`tool-compact` runs BEFORE this seam), so rewriting a tool message here is
   * final for this call instead of being re-projected over.
   *
   * Returning a new array replaces them for this call only; mutating in place also
   * works but is not required (see {@link MessageTransformer}). Mutation can never
   * reach a shared cache while a transformer is registered.
   */
  messages: ModelMessage[];
  /**
   * Multimodal part types the current model does not accept, derived from the same
   * capability probe that gates pre-send stripping. Empty when capabilities are
   * unknown (permissive — never assume a model lacks a capability it did not deny).
   */
  unsupportedPartTypes: ReadonlySet<MultimodalPartType>;
  /**
   * Every model capability as a set, or `null` when the model's capabilities are **unknown**.
   *
   * `null` and an empty set are different on purpose. `null` means nothing was declared, and
   * the `modelHas*` booleans below are then all `true` (permissive — never assume a model lacks
   * a capability it did not deny). An empty set means capabilities were resolved and the model
   * declares none of them, so every boolean is `false`. Read this property when you need to tell
   * "the model declared this capability" apart from "the model declared nothing" — the booleans
   * cannot express that difference on purpose.
   */
  capabilities: ReadonlySet<ModelCapability> | null;
  /**
   * Per-capability convenience flags. All permissive: `true` when capabilities are unknown
   * (`capabilities === null`); all `false` when the model declared an empty set.
   */
  modelHasVision: boolean;
  modelHasAudio: boolean;
  modelHasVideo: boolean;
  modelHasDocument: boolean;
  modelHasReasoning: boolean;
  modelHasToolCalling: boolean;
  modelHasPromptCaching: boolean;
  modelHasJsonOutput: boolean;
  /** Aborts when the owning run is cancelled. */
  abortSignal?: AbortSignal;
}

/**
 * Rewrites the messages the model will see. Registered via
 * {@link ExtensionContext.registerMessageTransformer}.
 *
 * Contract:
 * - Runs on **every** model call of the run, not once per turn — including after
 *   tool results land. Anything that must hold for the whole run belongs here.
 * - Wire-only: the returned messages affect this call only. They are never written
 *   back to the UI channel, the session store, or the conversation chain.
 * - Return `void` to leave the messages unchanged, or a message array to replace them.
 * - Not guaranteed to preserve message count; do not rely on it. Pruning and
 *   compaction remain the core `context-transform` phase's job.
 * - An extension may hold at most one active transformer; registering again replaces it.
 */
export type MessageTransformer = (
  ctx: MessageTransformContext,
  /** The extension's live context for this call. */
  extensionCtx?: ExtensionContext
) => ModelMessage[] | void | Promise<ModelMessage[] | void>;
