/**
 * An error object for an event payload that carries a message but no throw site.
 *
 * Fault events (`agent:stream-error`, `agent:extension-error`, `compaction:*error`, …) publish a
 * message string, not an exception. Wrapping that text in `new Error(text)` invents a stack that
 * points at the log module, so every persisted fault row claimed the failure was thrown by the
 * logger — worse than carrying no stack, because it sends a reader to the wrong file. The message
 * is the record (`data.error` keeps the raw text); a stack is attached only when the producer
 * actually threw one.
 */
export function eventError(message: string): Error {
  const error = new Error(message);
  error.stack = undefined;
  return error;
}
