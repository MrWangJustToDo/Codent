import { splitDisplayLines } from "../../../utils/display-lines.js";

export { normalizeOutputNewlines } from "../../../utils/display-lines.js";

/**
 * Split text into display lines, folding CRLF and dropping a trailing empty
 * segment from a final newline. The algorithm lives in `utils/display-lines.ts`;
 * this wrapper names the streaming default the presentation layer expects.
 */
export function splitStreamingLines(text: string): string[] {
  return splitDisplayLines(text, { normalizeCrlf: true, dropTrailingEmpty: true });
}
