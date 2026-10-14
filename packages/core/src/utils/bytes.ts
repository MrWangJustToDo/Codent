/**
 * UTF-8 byte length and byte-bounded truncation — the one definition of each.
 *
 * The byte size of a value is needed on three planes that cannot share a call stack: the runtime's
 * `byteLength` capability (`env`), the log sink's rotation budget and payload caps (`agent/log`),
 * and the tools' truncation and envelope maths. Each had spelled
 * `new TextEncoder().encode(x).length` for itself, so the rule had five homes and none to change.
 *
 * `TextEncoder` is a global in every runtime core targets (Node, browsers, workers), so this needs
 * no capability and stays importable from anywhere — including `env`, which is why it lives here
 * rather than beside any one consumer.
 */

/** Byte-bounded truncation options. */
export interface TruncateToUtf8BytesOptions {
  /**
   * Byte-length function. Defaults to {@link utf8ByteLength}; a caller whose bytes come from a
   * remote `CoreEnv` passes `(text) => env.byteLength(text, "utf-8")` so the count stays the
   * authoritative one for that runtime.
   */
  byteLength?: (text: string) => number;
  /**
   * Cut on the last newline that fits rather than mid-line. Defaults to `false` (exact byte cut).
   */
  lineBoundary?: boolean;
}

/** UTF-8 byte length of a string. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, never splitting a multi-byte character.
 *
 * The fitting prefix is found by binary search rather than by slicing `maxBytes` characters:
 * byte length is >= character length, so a character slice at `maxBytes` overshoots the budget by
 * up to ~4x for non-ASCII text (a Chinese character is 3 bytes, an emoji 4). Slicing on character
 * boundaries is what guarantees the result is always valid text.
 */
export function truncateToUtf8Bytes(
  text: string,
  maxBytes: number,
  options: TruncateToUtf8BytesOptions = {}
): { text: string; truncated: boolean } {
  const byteLength = options.byteLength ?? utf8ByteLength;
  if (byteLength(text) <= maxBytes) {
    return { text, truncated: false };
  }

  // Byte length is >= character length, so `maxBytes` characters is an upper bound.
  let low = 0;
  let high = Math.min(maxBytes, text.length);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  if (options.lineBoundary) {
    const lineBreak = text.lastIndexOf("\n", low);
    if (lineBreak > 0) return { text: text.slice(0, lineBreak), truncated: true };
  }
  return { text: text.slice(0, low), truncated: true };
}
