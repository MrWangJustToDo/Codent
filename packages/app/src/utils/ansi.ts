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
