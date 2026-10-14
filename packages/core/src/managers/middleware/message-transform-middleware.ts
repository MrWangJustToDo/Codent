/**
 * Extension message-transform middleware — the wire seam for
 * `ExtensionContext.registerMessageTransformer`.
 *
 * Placement contract: this middleware MUST run immediately after `compaction`
 * (same `context-transform` phase, adjacent in `CANONICAL_MIDDLEWARE_ORDER`), and
 * **only** consumes the messages it receives via `config.messages`.
 *
 * Why placement is the whole design here: `compaction` is channel-anchored — it
 * rebuilds the wire from `channel.getMessages()` and ignores whatever the incoming
 * `config.messages` held. Anything that wants to transform the model-facing chain
 * therefore has to sit AFTER that projection, otherwise its output is discarded by
 * the very next projection and it silently applies to the first call only (the exact
 * failure mode already present for the `max_tokens` continuation prompt, which is
 * appended to the wire in `run-stream-recovery` and then overwritten).
 *
 * This middleware deliberately does not reach into `compaction`: it reads the
 * messages it is handed and returns replacements, so the compaction cache contract
 * and keep-policy logic stay untouched. Keeping transformers out of `compaction`
 * also means an extension-free workspace never touches that middleware's internals.
 *
 * Zero-overhead contract: when no extension holds a transformer this returns `{}`
 * (no config change), so the pipeline behaves exactly as before.
 */

import { buildModelCapabilityFlags } from "../../agent/extension/types.js";
import { unsupportedMultimodalPartTypes } from "../../models/adapter/capability-message-utils.js";

import { defineMiddleware } from "./phase.js";

import type { ExtensionRunner } from "../../agent/extension/runner.js";
import type { MessageTransformPhase, ModelCapabilityFlags, MultimodalPartType } from "../../agent/extension/types.js";
import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { ModelCapability } from "../../models/types.js";
import type { UsageTracker } from "../../runtime-types";
import type { ChatMiddleware, ChatMiddlewarePhase, ModelMessage } from "@tanstack/ai";

export interface MessageTransformMiddlewareDeps {
  /** Agent whose run is building this wire call. Per-run authoritative id. */
  agentId: string;
  /**
   * Extension runner owning the transformers. Null / absent for subagents (which do
   * not load extensions) — the seam is then a no-op.
   */
  getExtensionRunner: () => ExtensionRunner | null;
  /** Capability probe, same source as the pre-send multimodal stripping. */
  getUsage: () => UsageTracker;
  /**
   * The run's effective drop set, when one is armed.
   *
   * The probe above describes what the model DECLARED; a multimodal API rejection widens this run's
   * strip to every part type. An extension deciding "can this model see the image?" has to know
   * that — otherwise it is told the model can see it, leaves the media in place, and the strip
   * (running later on the same wire) drops it anyway.
   */
  getWireDropPartTypes?: () => ReadonlySet<MultimodalPartType> | null;
  /** Abort signal of the owning run, forwarded to transformers. */
  getAbortSignal?: () => AbortSignal | undefined;
}

/** Map the engine's middleware phase onto the extension-visible transform phase. */
function resolveTransformPhase(phase: ChatMiddlewarePhase): MessageTransformPhase {
  return phase === "init" ? "init" : "iteration";
}

/**
 * Capability context for a transformer, from the same probe that gates pre-send
 * stripping, so an extension never re-derives model ability from host config.
 *
 * `unsupportedPartTypes` is the run's EFFECTIVE drop set: the probe's, unless a rejection
 * widened it (see {@link MessageTransformMiddlewareDeps.getWireDropPartTypes}). The declared
 * flags and `capabilities` stay the probe's, because they describe the model — a retry decision
 * made for one run does not change what the model declares.
 *
 * Safe to read per call: capabilities are written only at bootstrap and on model
 * switch (never mid-run), so this stays correct across a model change.
 *
 * The per-capability flags come from `buildModelCapabilityFlags`, which iterates the one
 * capability table (`MODEL_CAPABILITY_FLAGS`, exhaustively keyed by `ModelCapability`) — so
 * a capability added to `models/types.ts` fails compilation there until it is named, rather
 * than silently missing a flag here.
 */
function buildTransformCapabilities(
  deps: MessageTransformMiddlewareDeps,
  usage: UsageTracker
): {
  unsupportedPartTypes: ReadonlySet<MultimodalPartType>;
  capabilities: ReadonlySet<ModelCapability> | null;
} & ModelCapabilityFlags {
  const runDrop = deps.getWireDropPartTypes?.();
  return {
    unsupportedPartTypes: runDrop && runDrop.size > 0 ? runDrop : unsupportedMultimodalPartTypes(usage),
    capabilities: usage.getCapabilities(),
    ...buildModelCapabilityFlags((cap) => usage.hasCapability(cap)),
  };
}

/**
 * Apply every registered extension message transformer to the wire payload.
 *
 * Runs on every model call of the run (the engine invokes `onConfig` once per
 * iteration, and restart-style retries rebuild the engine), so a transform that must
 * hold for the whole run does not need per-retry special-casing.
 */
export function createMessageTransformMiddleware(deps: MessageTransformMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("context-transform", {
    name: "message-transform",
    onConfig: async (ctx, config) => {
      const runner = deps.getExtensionRunner();
      // Fast path: no transformer registered → no config change at all, exactly as
      // if this middleware did not exist.
      if (!runner?.hasMessageTransformers()) return {};

      const messages = await runner.applyMessageTransformers({
        // Placeholder — the runner overwrites this per transformer with the id of
        // the extension that registered it.
        extensionId: "",
        agentId: deps.agentId,
        phase: resolveTransformPhase(ctx.phase),
        messages: config.messages as ModelMessage[],
        ...buildTransformCapabilities(deps, deps.getUsage()),
        abortSignal: deps.getAbortSignal?.(),
      });

      return { messages };
    },
  });
}
