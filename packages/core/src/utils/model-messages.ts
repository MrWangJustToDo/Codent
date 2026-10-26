/**
 * Copy a model-visible message list for a consumer that must not be able to write back.
 *
 * `getMessagesForLLM` returns a projection whose array is owned by `WireProjectionCache` and whose
 * content-part objects are shared with the UI channel, and the session is persisted from that channel
 * — so a shallow copy is not isolation: `part.source.value = …` would reach disk. This copies the
 * array, every message, and every part object one level (the level the wire and the channel share);
 * part payloads are plain data, so this is the depth at which a mutation could matter.
 */
export function copyModelMessages<T extends { content?: unknown }>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    const content = message.content;
    if (Array.isArray(content)) {
      return {
        ...message,
        content: content.map((part) => (part && typeof part === "object" ? structuredClone(part) : part)),
      };
    }
    return { ...message };
  });
}
