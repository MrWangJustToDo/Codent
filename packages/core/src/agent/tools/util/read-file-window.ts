/**
 * Streaming line-window scan for `read_file`.
 *
 * The old text path read the WHOLE file into one string and sliced a window out of it, which is
 * why it needed a "file too large to read" gate: without one, a multi-GB file was materialised
 * before any output cap applied. This scans decoded pieces instead and keeps only the requested
 * window, so memory is bounded by the OUTPUT caps rather than by the file — and a large file no
 * longer has to be refused at all. It still scans to an exact total line count (paging and the
 * offset-out-of-range error both need it) without retaining the lines it passes over.
 *
 * Pieces must never split a multi-byte character: a mangled character is unrecoverable once
 * decoded, and the caller reads byte windows whose edges can land inside one (see `read_text`'s
 * chunker, which only consumes through the last newline it decoded). A piece may still end
 * mid-line; its tail is carried into the next piece.
 *
 * `content.split("\n")` is the contract this replaces, so an empty file is one empty line and a
 * trailing newline starts one more.
 */

/** Appended to a line cut at `maxLineChars`. */
export const LINE_TRUNCATION_SUFFIX = "... (line truncated)";

export interface TextWindowRequest {
  /** 1-based first line to return. */
  offset: number;
  /** Maximum lines to return. */
  limit: number;
  /** Characters past which one line is cut (with {@link LINE_TRUNCATION_SUFFIX}). */
  maxLineChars: number;
  /** Characters past which the whole window stops growing. */
  maxWindowChars: number;
}

export interface TextWindowResult {
  /** The numbered window, already cut at `maxWindowChars` (no trailing notice — the tool adds it). */
  content: string;
  /** Exact line count, by the `split("\n")` rule. */
  totalLines: number;
  /** The window hit `maxWindowChars`. */
  truncatedByChars: boolean;
  /** A line INSIDE the window exceeded `maxLineChars`. */
  truncatedByLength: boolean;
}

/**
 * Build the line window from decoded pieces.
 *
 * Bounded by construction: one character past the per-line limit is enough to know the line is
 * over it (more would be the growth this exists to avoid), and the window stops at
 * `maxWindowChars`. Lines outside the window are counted but not retained.
 */
export async function scanTextWindow(
  pieces: AsyncIterable<string>,
  request: TextWindowRequest
): Promise<TextWindowResult> {
  const rendered: string[] = [];
  let windowChars = 0;
  let truncatedByChars = false;
  let truncatedByLength = false;
  let totalLines = 0;
  let pending = "";
  let pendingTruncated = false;

  const lineCap = request.maxLineChars + 1;

  const append = (text: string): void => {
    if (text.length === 0 || pendingTruncated) return;
    const room = lineCap - pending.length;
    if (text.length <= room) {
      pending += text;
      return;
    }
    pending += text.slice(0, room);
    pendingTruncated = true;
  };

  const finishLine = (): void => {
    totalLines += 1;
    const inWindow = totalLines >= request.offset && totalLines < request.offset + request.limit;
    if (inWindow && !truncatedByChars) {
      const over = pendingTruncated || pending.length > request.maxLineChars;
      if (over) truncatedByLength = true;
      const text = over ? `${pending.slice(0, request.maxLineChars)}${LINE_TRUNCATION_SUFFIX}` : pending;
      const line = `${rendered.length === 0 ? "" : "\n"}${totalLines}: ${text}`;
      const room = request.maxWindowChars - windowChars;
      if (line.length <= room) {
        rendered.push(line);
        windowChars += line.length;
      } else {
        // The cut lands inside this line exactly as `fullJoin.slice(0, maxWindowChars)` would.
        if (room > 0) rendered.push(line.slice(0, room));
        truncatedByChars = true;
      }
    }
    pending = "";
    pendingTruncated = false;
  };

  for await (const piece of pieces) {
    let start = 0;
    for (;;) {
      const newline = piece.indexOf("\n", start);
      if (newline === -1) break;
      append(piece.slice(start, newline));
      finishLine();
      start = newline + 1;
    }
    if (start < piece.length) append(piece.slice(start));
  }

  // The final segment is always a line, even when empty — the `split("\n")` rule.
  finishLine();

  return { content: rendered.join(""), totalLines, truncatedByChars, truncatedByLength };
}
