/**
 * Display line splitting — the one definition.
 *
 * Three callers split text into lines with slightly different rules: the presentation layer folds
 * CRLF, the output accumulator counts lines without folding, and the search capture drops a
 * trailing empty segment. They were three near-identical copies plus thirty raw `split("\n")`
 * calls, which is how "the same" line count came to differ depending on which caller produced it.
 * The shared splitter makes both choices explicit at the call site.
 */

/** Fold CRLF and lone CR onto `\n`. */
export function normalizeOutputNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export interface SplitDisplayLinesOptions {
  /** Fold CRLF / CR to `\n` before splitting. Defaults to `true`. */
  normalizeCrlf?: boolean;
  /** Drop a trailing empty segment produced by a final newline. Defaults to `true`. */
  dropTrailingEmpty?: boolean;
}

/** Split text into display lines with explicit normalization and trailing-segment rules. */
export function splitDisplayLines(text: string, options: SplitDisplayLinesOptions = {}): string[] {
  if (text.length === 0) return [];
  const normalizeCrlf = options.normalizeCrlf ?? true;
  const dropTrailingEmpty = options.dropTrailingEmpty ?? true;
  const source = normalizeCrlf ? normalizeOutputNewlines(text) : text;
  const lines = source.split("\n");
  if (dropTrailingEmpty && lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Keep the first `maxLines` display lines and say how many were dropped.
 *
 * Result renderers (`present.text`) print a body under the row header, and several tools return
 * whole-file-shaped text (a directory tree, a diagnostics list, a session page). Unbounded, the
 * `tree` tool alone can own the transcript for a hundred rows. The TAIL is what is dropped: the
 * head carries the answer (the structure's top levels, the first hits), and the same
 * `... (N more lines)` marker is already what `formatTaskOutput` prints.
 *
 * The model is unaffected — it reads `toModelOutput`, not this.
 */
export function headDisplayLines(text: string, maxLines: number): string {
  const lines = splitDisplayLines(text);
  if (lines.length <= maxLines) return lines.join("\n");
  const hidden = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `... (${hidden} more line${hidden === 1 ? "" : "s"})`].join("\n");
}
