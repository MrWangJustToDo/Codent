/**
 * Ownership copies of model-visible messages.
 *
 * `getMessagesForLLM` returns a projection whose array is owned by `WireProjectionCache`, and the
 * session is persisted from the UI channel — so a shallow copy is not isolation: `part.source.value
 * = …` (or `metadata.x = …`, `toolCalls[0]…`) would reach disk. One clone rule serves every consumer
 * that hands the wire to third-party code (extension transformers, `ctx.getMessages()`), so the two
 * cannot drift into different notions of "a copy".
 */

/**
 * How many containers below a MESSAGE are copied.
 *
 * Six, because the message level costs one: at five the per-part depth was one less than the
 * part-rooted clone, so `part.output[0].content` (and its elements) were shared with the UI channel
 * and a transformer pushing into them reached the persisted transcript. Six keeps the part depth
 * the durability invariant was written for while also covering the message's own fields
 * (`toolCalls`, `metadata`, `structuredOutput`). Payload strings stay shared: they are immutable
 * (and can be large).
 */
export const MODEL_MESSAGE_OWNERSHIP_DEPTH = 6;

/**
 * Copy one value's own containers down to `depth`.
 *
 * Plain objects and arrays are re-created (elements included, which a shallow array copy misses:
 * `part.output[0].text = …` would reach the channel). Primitives are returned as-is — sharing a
 * string is safe because it is immutable — and exotic objects are kept by reference rather than
 * silently flattened into `{}`.
 */
export function cloneOwnedValue(value: unknown, depth: number): unknown {
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

/**
 * Copy a model-visible message list for a consumer that must not be able to write back.
 *
 * Whole-message deep copy (to {@link MODEL_MESSAGE_OWNERSHIP_DEPTH}), not just `content`: the wire
 * conversion shares `metadata`, `structuredOutput` and the `toolCalls` array with the UI channel,
 * so a message-level edit used to reach the persisted transcript just like a part edit did.
 */
export function copyModelMessages<T extends { content?: unknown }>(messages: readonly T[]): T[] {
  return messages.map((message) => cloneOwnedValue(message, MODEL_MESSAGE_OWNERSHIP_DEPTH) as T);
}
