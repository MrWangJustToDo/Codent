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
 * So ownership is granted structurally: a fresh outer array, fresh message objects, and fresh
 * content containers, recursing a few levels through arrays and plain objects (enough for every
 * shape the wire uses: `part → nested container → array element → its own containers`). A
 * transformer that mutates `part.text`, pushes a part, rewrites `part.source.data`, or edits an
 * element of `part.output[]` therefore edits its own copy; without this the edits wrote through to
 * the objects the channel and the persistence path share (the durability rule every wire transform
 * is required to follow).
 *
 * Primitive values (including base64 strings) are shared, not re-allocated: they are immutable,
 * and copying them would duplicate every image on every model call. Exotic objects (a `Date`, a
 * `Map`, a class instance) are kept by reference rather than flattened into a plain object.
 */

import { compareDispatchRank } from "../dispatch-order.js";

import type { DispatchRank } from "../dispatch-order.js";
import type { ExtensionContext, MessageTransformContext, MessageTransformer } from "./types.js";
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

/**
 * How many containers below a part are copied.
 *
 * Four levels covers every shape the wire carries — part → `content`/`source` → array element →
 * that element's own object — without turning into a deep clone of arbitrary tool output. Going
 * deeper would start copying payload strings, which are immutable and can be large.
 */
const OWNERSHIP_CLONE_DEPTH = 4;

/**
 * Copy one value's own containers down to {@link OWNERSHIP_CLONE_DEPTH}.
 *
 * Plain objects and arrays are re-created (elements included, which the old shallow array copy
 * missed: `part.output[0].text = …` reached the channel). Primitives are returned as-is — sharing
 * a string is safe because it is immutable — and exotic objects are kept by reference rather than
 * silently flattened into `{}`.
 */
function cloneOwnedValue(value: unknown, depth: number): unknown {
  if (depth <= 0) return value;
  if (Array.isArray(value)) return value.map((entry) => cloneOwnedValue(entry, depth - 1));
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = cloneOwnedValue(entry, depth - 1);
    return copy;
  }
  return value;
}

/** Ownership copy for one content part — see the note at the top of this file. */
function cloneContentPart(part: unknown): unknown {
  return cloneOwnedValue(part, OWNERSHIP_CLONE_DEPTH);
}

/** Ownership copy for one model message — see the note at the top of this file. */
function cloneModelMessage(message: ModelMessage): ModelMessage {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return { ...message };
  return { ...message, content: content.map(cloneContentPart) } as ModelMessage;
}

export interface MessageTransformerRegistryHost {
  /** Write a warning and emit `agent:extension-error` — supplied by the runner. */
  reportTransformerFailure(extensionId: string, err: unknown): void;
  /** The extension's live context, for the transformer's second argument. */
  getContext?: (extensionId: string) => ExtensionContext | undefined;
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
    // Fresh outer array + fresh message objects + fresh content containers (see ownership note).
    let current: ModelMessage[] = ctx.messages.map(cloneModelMessage);

    // Declared dispatch order, load sequence as the tie-break — not insertion order.
    const ordered = Array.from(this.transformers, ([extensionId, entry]) => ({ extensionId, ...entry })).sort((a, b) =>
      compareDispatchRank(a.rank, b.rank)
    );

    for (const { extensionId, transformer } of ordered) {
      try {
        const result = await transformer(
          { ...ctx, extensionId, messages: current },
          this.host.getContext?.(extensionId)
        );
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
