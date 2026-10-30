/**
 * ANSI sandbox for text that crosses a boundary into the terminal.
 *
 * Two producers hand us pre-styled strings we did not compose: extension UI payloads (which may come
 * from an extension process) and image previews (which may come from a remote env). Both are "draw
 * this", and both could otherwise move the cursor or clear the screen out from under a renderer that
 * owns the layout. SGR is the one sequence family that only styles text, so it is the only one kept.
 *
 * Lives here rather than next to the extension renderer because the image preview needs the same
 * rule; two copies of this is how one of them drifts.
 */

/**
 * Keep SGR styling (`ESC [ … m`) — producers legitimately colorize their output — while
 * neutralizing destructive terminal control sequences (screen clear, cursor
 * movement/positioning, window title, OSC 8 hyperlinks) that could wreck the host layout.
 */
export function sanitizeAnsi(text: string): string {
  // OSC sequences (hyperlinks, window title): ESC ] … BEL | ESC \
  // Note: the terminator is optional, so a truncated OSC swallows the remainder
  // of that text rather than leaving half an escape sequence on screen.
  // eslint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition.
  let out = text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "");
  // CSI sequences: keep SGR (`m`), drop cursor/screen/erase codes.
  // eslint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition.
  out = out.replace(/\u001b\[([0-9;?]*)([A-Za-z])/g, (_match, params: string, final: string) =>
    final === "m" ? `\u001b[${params}m` : ""
  );
  // Any remaining two-character escape (ESC 7, ESC c, …) is destructive too — but `[` is excluded
  // here, because this pass runs over the SGR the line above just KEPT: `\u001b[33m` starts with
  // `ESC[`, so matching it would leave the literal `33m` on screen and strip the color the
  // sequence exists to apply. A real CSI always has its parameters, so it was consumed above.
  // eslint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition.
  out = out.replace(/\u001b(?!\[)[\s\S]/g, "");
  return out;
}

/** Reset every SGR attribute. */
export const ANSI_RESET = "\u001b[0m";

/**
 * Sanitize, bound, and style-terminate one piece of foreign text.
 *
 * The three steps belong together because each one on its own is not enough to keep a payload
 * inside the region that owns it:
 *
 * - `sanitizeAnsi` removes the sequences that move or erase (only SGR survives).
 * - The bound is applied to VISIBLE characters and never inside an escape sequence or a surrogate
 *   pair. Counting UTF-16 code units — what a plain `slice` does — could cut `😀` in half or leave a
 *   bare `ESC[33` on screen, which the terminal then renders as garbage or swallows along with the
 *   text after it.
 * - The reset is appended UNCONDITIONALLY, not only when truncating. A payload that forgets its
 *   trailing reset would otherwise bleed its colour into the next footer region and the shell
 *   prompt; the publisher owns its styling, so the host cannot rely on it to close its own SGR.
 */
export function boundAnsiText(text: string, max: number): string {
  const clean = sanitizeAnsi(text);
  if (clean === "") return clean;
  const bounded = truncateAnsi(clean, max);
  // Nothing visible survived the bound (or the bound is zero): emit no text at all rather than a
  // lone reset, which a `<Text>` would still lay out as a (blank) line.
  if (bounded === "") return "";
  return bounded.endsWith(ANSI_RESET) ? bounded : `${bounded}${ANSI_RESET}`;
}

/**
 * Keep at most `max` visible characters, copying SGR sequences through whole and dropping an
 * unterminated one. Returns the input unchanged when it already fits.
 */
function truncateAnsi(text: string, max: number): string {
  if (max <= 0) return "";
  let out = "";
  let visible = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\u001b") {
      const end = escapeEnd(text, index);
      // An escape without a final byte is incomplete: dropping it beats rendering half of it.
      if (end === -1) break;
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (visible >= max) break;
    const codePoint = text.codePointAt(index) ?? 0;
    const size = codePoint > 0xffff ? 2 : 1;
    out += text.slice(index, index + size);
    index += size;
    visible += 1;
  }
  return out;
}

/** End offset of the CSI sequence starting at `start`, or -1 when it never terminates. */
function escapeEnd(text: string, start: number): number {
  if (text[start + 1] !== "[") return -1;
  for (let index = start + 2; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // A final byte (@–~) closes the sequence; everything before it is parameters/intermediates.
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return -1;
}
