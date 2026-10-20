/**
 * Byte-window text chunking shared by `read_file` and the session-log reader.
 *
 * `CoreEnvFs.readFileRange` decodes each byte range independently, so a boundary landing inside a
 * multi-byte character is unrecoverable (U+FFFD). A newline is one byte, so consuming only through
 * the last newline decoded in a window keeps every consumed prefix on a character boundary; the
 * next window starts at the byte length of that prefix. A full window with no newline is a single
 * line longer than the window: it is yielded as-is and the caller carries it as an incomplete line.
 *
 * Keeping this here (rather than one copy per tool) is what stops the session reader and
 * `read_file` from disagreeing about boundaries, EOF, or BOM/multi-byte handling.
 */

import { utf8ByteLength } from "./bytes.js";

/** The minimum filesystem surface this chunker needs (kept structural so `utils` stays a leaf). */
export interface ReadTextPiecesFs {
  readFileRange?: (path: string, start: number, end: number) => Promise<string>;
  stat?: (path: string) => Promise<{ size: number }>;
}

/** Window size in bytes. Only controls read frequency; callers bound retained output separately. */
export const READ_TEXT_CHUNK_BYTES = 64 * 1024;

/**
 * Yield decoded, line-aligned pieces. The final piece is whatever remains at EOF and may end
 * mid-line; callers must carry that tail into their own line splitter.
 */
export async function* readTextPieces(
  fs: ReadTextPiecesFs,
  filePath: string,
  chunkBytes = READ_TEXT_CHUNK_BYTES
): AsyncGenerator<string> {
  if (!fs.readFileRange) {
    throw new Error("readTextPieces requires CoreEnvFs.readFileRange");
  }
  const size = (await fs.stat?.(filePath))?.size ?? 0;
  if (size <= 0) return;

  let from = 0;
  while (from < size) {
    const chunk = await fs.readFileRange(filePath, from, Math.min(from + chunkBytes, size));
    if (!chunk) return;
    const lastNewline = chunk.lastIndexOf("\n");
    // The remaining file is shorter than a full window (or is exactly one unterminated window):
    // yield it whole. At EOF there is no next window whose boundary could split a character.
    if (from + chunkBytes > size || (from + chunkBytes === size && lastNewline === -1)) {
      yield chunk;
      return;
    }
    if (lastNewline >= 0) {
      const consumed = chunk.slice(0, lastNewline + 1);
      yield consumed;
      const bytes = utf8ByteLength(consumed);
      if (bytes <= 0) return;
      from += bytes;
      continue;
    }

    // No newline in this window: it is a prefix of a long line. A decoded prefix can end in U+FFFD
    // when the byte boundary split a multi-byte code point. Trim that replacement and advance by
    // the exact byte length of the valid prefix, so the next window starts on a real character
    // boundary and no bytes (and therefore no JSONL record) are skipped.
    let piece = chunk;
    while (piece.endsWith("\uFFFD")) piece = piece.slice(0, -1);
    if (!piece) {
      // A pathological window that decoded to nothing but replacement; advance one byte to make
      // progress rather than spinning. (Real UTF-8 cannot produce this for a 64 KiB window.)
      from += 1;
      continue;
    }
    yield piece;
    from += utf8ByteLength(piece);
  }
}
