/**
 * Extension message-transformer registry.
 *
 * `ExtensionContext.registerMessageTransformer` is the one extension surface that
 * rewrites the message chain the model sees. The registration/apply mechanics live here
 * rather than in `runner.ts` because they are a self-contained concern: a per-extension
 * map, a fast-path guard for the wire seam, and an ordered chain with failure isolation.
 * The runner only owns the lifecycle wiring (create, disable, destroy).
 *
 * Ownership contract (why {@link MessageTransformerRegistry.apply} copies its input):
 *
 * The compact path hands out the only non-owned array in the pipeline —
 * `WireProjectionCache.getOrCompute` returns the SAME array reference it retains, and the
 * engine's `applyMiddlewareConfig` assigns that reference straight to its live message
 * state. Handing it out as-is would make two documented promises false at once:
 *
 *   1. "in-place edits stay out of the cache" — `m.content = ...` would write through to
 *      the array the cache keeps;
 *   2. "the transformer runs again on the next call" — a cache hit would hand back the
 *      already-mutated array, so a transformer that mutates and returns `void` would
 *      silently become a no-op on the second call.
 *
 * So ownership is granted structurally: a fresh outer array AND fresh message objects.
 * The boundary is deliberate and documented — the `content` parts *inside* a message are
 * still shared, because cloning them would mean walking every part of every model call.
 * A transformer that wants to change a part returns a new message rather than mutating.
 */

import { compareDispatchRank } from "./dispatch-order.js";

import type { DispatchRank } from "./dispatch-order.js";
import type { MessageTransformContext, MessageTransformer } from "./types.js";
import type { ModelMessage } from "@tanstack/ai";

/**
 * Structural check for a transformer's return value.
 *
 * A transformer is third-party code returning untrusted data into the model wire, so its
 * result is validated before it can replace the message set. Only the contract that
 * matters is enforced: an array whose entries each carry a string `role`.
 */
function isModelMessageArray(value: unknown): value is ModelMessage[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) => entry != null && typeof entry === "object" && typeof (entry as { role?: unknown }).role === "string"
  );
}

/** Short, log-safe description of an unexpected transformer return value. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array with invalid entries";
  return typeof value;
}

export interface MessageTransformerRegistryHost {
  /** Write a warning and emit `agent:extension-error` — supplied by the runner. */
  reportTransformerFailure(extensionId: string, err: unknown): void;
}

export class MessageTransformerRegistry {
  /**
   * Per-extension transformer (extension id → transformer + its dispatch rank). A Map, not an
   * array, because the contract is "at most one per extension"; the chaining order is the
   * declared dispatch order (rank), not insertion order.
   */
  private transformers = new Map<string, { transformer: MessageTransformer; rank: DispatchRank }>();

  constructor(private readonly host: MessageTransformerRegistryHost) {}

  /**
   * Fast-path guard for the wire seam: when false the caller must take the unchanged
   * (cached) path, so an extension-free workspace pays nothing.
   */
  has(): boolean {
    return this.transformers.size > 0;
  }

  /** Register (or replace) the transformer owned by an extension, with its dispatch rank. */
  register(extensionId: string, transformer: MessageTransformer, rank: DispatchRank): void {
    this.transformers.set(extensionId, { transformer, rank });
  }

  /**
   * Drop an extension's transformer, but only when `transformer` is still the registered
   * one — a stale disposer must not clear a later re-registration.
   */
  dispose(extensionId: string, transformer: MessageTransformer): void {
    if (this.transformers.get(extensionId)?.transformer === transformer) {
      this.transformers.delete(extensionId);
    }
  }

  /** Remove every transformer registered by an extension (disable / destroy). */
  clearExtension(extensionId: string): void {
    this.transformers.delete(extensionId);
  }

  clearAll(): void {
    this.transformers.clear();
  }

  /**
   * Apply every registered transformer in extension load order, chaining each result
   * into the next. Returns the messages to send for this call.
   *
   * Failure isolation: a transformer that throws, or returns something that is not a
   * message array, only costs its own contribution — the last valid message set is kept
   * and the remaining transformers still run. A broken extension must never abort a run,
   * so this method does not throw.
   */
  async apply(ctx: MessageTransformContext): Promise<ModelMessage[]> {
    // Fresh outer array + fresh message objects: see the ownership note at the top.
    let current: ModelMessage[] = ctx.messages.map((message) => ({ ...message }));

    // Declared dispatch order, load sequence as the tie-break — not insertion order.
    const ordered = Array.from(this.transformers, ([extensionId, entry]) => ({ extensionId, ...entry })).sort((a, b) =>
      compareDispatchRank(a.rank, b.rank)
    );

    for (const { extensionId, transformer } of ordered) {
      try {
        const result = await transformer({ ...ctx, extensionId, messages: current });
        if (result === undefined) continue;
        if (!isModelMessageArray(result)) {
          this.host.reportTransformerFailure(
            extensionId,
            new Error(`transformer returned ${describeValue(result)} instead of a message array`)
          );
          continue;
        }
        current = result;
      } catch (err) {
        this.host.reportTransformerFailure(extensionId, err);
      }
    }

    return current;
  }
}
