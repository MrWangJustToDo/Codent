/**
 * Resolve LLM-provided edit operations against file content.
 *
 * The contract, in one place:
 *
 * - **Every edit is matched against the ORIGINAL content**, never against the result of an earlier
 *   edit in the same call. Sequential matching made one edit's insertion shift the next edit's
 *   anchor (and `startLine` went stale the moment anything before it changed).
 * - Edits must be **non-overlapping**; overlapping ranges are refused with the two edit numbers.
 * - Matching is a ladder, conservative first, first level with a hit wins:
 *     1. exact substring (on the LF view)
 *     2. per line, ignoring trailing whitespace
 *     3. per line, ignoring leading and trailing whitespace
 *     4. substring match after 1:1 Unicode normalization (typographic quotes/dashes/spaces)
 *     5. per line, ignoring whitespace difference AND typographic Unicode variants
 *   A level never loosens the uniqueness rule: more than one hit is ambiguous unless `replaceAll`.
 *   Levels 2/3/5 compare whole lines (a partial-line snippet simply falls through); level 4 is a
 *   substring level, which is what makes a typographic match work mid-line.
 * - The replacement is spliced by offset on the LF view, so a match can never write at a shifted
 *   position. The old fuzzy path used a normalized index as an original index, which silently
 *   corrupted output whenever a length-changing character (a zero-width space) preceded the match.
 * - `oldString === newString` is a no-op, not an error: the file is already in the desired state.
 *   It is reported as `skipped` so the rest of a batch still applies.
 */

import { normalizeForFuzzyMatch } from "./fuzzy-match.js";

// ============================================================================
// Types
// ============================================================================

export type EditMatchMode = "exact" | "trimEnd" | "trim" | "unicode" | "unicodeTrim";

export interface EditOccurrence {
  /** Start offset in the LF-normalized content. */
  start: number;
  /** End offset (exclusive) in the LF-normalized content. */
  end: number;
  /** 1-indexed line of `start`. */
  line: number;
}

export interface EditMatch {
  mode: EditMatchMode;
  /** Non-overlapping occurrences, in file order. */
  occurrences: EditOccurrence[];
  /** The on-disk spelling that matched (an unescaped variant, when that is what hit). */
  matchedOld: string;
  /** Replacement text to write. */
  resolvedNew: string;
}

export type EditMatchResult =
  { ok: true; match: EditMatch } | { ok: false; code: "empty" | "not_found"; message: string };

export interface EditOperation {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface ResolvedEditOperation {
  /** Index in the caller's `edits` array. */
  index: number;
  mode: EditMatchMode;
  /** How many occurrences this operation replaces. */
  count: number;
  /** 1-indexed line of the first replacement in the original content. */
  firstLine: number;
  ranges: Array<{ start: number; end: number }>;
}

export type ApplyEditsResult =
  | {
      ok: true;
      /** LF-normalized content after every operation. */
      content: string;
      /** One entry per input edit; `null` marks an identical (skipped) edit. */
      operations: Array<ResolvedEditOperation | null>;
      /** Input indices whose oldString and newString were identical. */
      skipped: number[];
    }
  | { ok: false; index: number; message: string };

// ============================================================================
// Text encoding (BOM / line endings)
// ============================================================================

/** Split a leading BOM off the content, so matching never sees an invisible character. */
export function splitBom(text: string): { bom: string; text: string } {
  return text.charCodeAt(0) === 0xfeff ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

/** The file's dominant line ending (CRLF wins only when it is strictly more common). */
export function detectLineEnding(text: string): "\r\n" | "\n" {
  const crlf = text.split("\r\n").length - 1;
  const lf = text.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** The view matching and splicing operate on. */
export function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Restore the file's line ending after an edit. */
export function fromLF(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\n" ? text : text.replace(/\n/g, "\r\n");
}

// ============================================================================
// Over-escape variants
// ============================================================================

/**
 * Apply common JS/JSON-style unescape passes that LLMs over-apply when quoting code.
 * Protects literal backslashes, then unescapes sequences, then restores.
 */
export function unescapeCommonEscapes(text: string): string {
  let result = text.replace(/\\\\/g, "\0");
  result = result.replace(/\\n/g, "\n");
  result = result.replace(/\\r/g, "\r");
  result = result.replace(/\\t/g, "\t");
  result = result.replace(/\\`/g, "`");
  result = result.replace(/\\'/g, "'");
  result = result.replace(/\\"/g, '"');
  result = result.replace(/\0/g, "\\");
  return result;
}

interface MatchVariant {
  text: string;
  /** How many `unescapeCommonEscapes` passes produced this spelling. */
  passes: number;
}

/**
 * Every spelling of `text` that may appear on disk, with the pass count that produced it.
 *
 * The pass count matters for the REPLACEMENT: when an over-escaped oldString needed two passes, its
 * newString needs the same two. Unescaping the replacement a fixed one time left double-escaped
 * backslashes in the file.
 */
function variantCandidates(text: string): MatchVariant[] {
  const candidates: MatchVariant[] = [{ text, passes: 0 }];
  const seen = new Set<string>([text]);

  // Iterative full unescape (LLM sometimes double/triple-escapes).
  let current = text;
  for (let passes = 1; passes <= 3; passes++) {
    const next = unescapeCommonEscapes(current);
    if (next === current) break;
    if (!seen.has(next)) {
      candidates.push({ text: next, passes });
      seen.add(next);
    }
    current = next;
  }

  for (const extra of [
    text.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t"),
    text.replace(/\\`/g, "`").replace(/\\'/g, "'").replace(/\\"/g, '"'),
    text.replace(/\\\\/g, "\\"),
  ]) {
    if (seen.has(extra)) continue;
    candidates.push({ text: extra, passes: 1 });
    seen.add(extra);
  }

  return candidates;
}

/** Unique variants of `text` that may appear in on-disk content. */
export function expandMatchVariants(text: string): string[] {
  return variantCandidates(text).map((candidate) => candidate.text);
}

/** Apply `unescapeCommonEscapes` up to `passes` times, stopping when it is a fixed point. */
function unescapeTimes(text: string, passes: number): string {
  let out = text;
  for (let i = 0; i < passes; i++) {
    const next = unescapeCommonEscapes(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

// ============================================================================
// Line helpers
// ============================================================================

interface ContentLine {
  text: string;
  start: number;
  end: number;
  hasNewline: boolean;
}

function splitLines(content: string): ContentLine[] {
  const lines: ContentLine[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "\n") continue;
    lines.push({ text: content.slice(start, i), start, end: i, hasNewline: true });
    start = i + 1;
  }
  lines.push({ text: content.slice(start), start, end: content.length, hasNewline: false });
  return lines;
}

/** Leading spaces/tabs of the line that starts at (or contains) `index`. */
function leadingWhitespaceAt(content: string, index: number): string {
  let end = index;
  while (end < content.length && (content[end] === " " || content[end] === "\t")) end++;
  return content.slice(index, end);
}

/** Offsets of every line start, built once per operation (a per-hit scan is quadratic). */
function buildLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-indexed line of an offset. Pass precomputed `lineStarts` when resolving many hits. */
export function lineNumberAt(content: string, index: number, lineStarts?: readonly number[]): number {
  if (!lineStarts) return lineNumberAt(content, index, buildLineStarts(content));
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function exactOccurrences(content: string, needle: string, lineStarts: readonly number[]): EditOccurrence[] {
  return occurrencesInView(content, content, needle, lineStarts);
}

/**
 * Substring occurrences in a view that is **1:1 with `content`** (same length, same offsets).
 *
 * The Unicode level relies on this: `normalizeForFuzzyMatch` maps one character to one character,
 * so an index in the normalized view is a valid index in the original text. A length-changing map
 * here is what used to make fuzzy matches splice one character early.
 */
function occurrencesInView(
  content: string,
  view: string,
  needle: string,
  lineStarts: readonly number[]
): EditOccurrence[] {
  if (needle.length === 0) return [];
  const occurrences: EditOccurrence[] = [];
  let pos = 0;
  while ((pos = view.indexOf(needle, pos)) !== -1) {
    occurrences.push({ start: pos, end: pos + needle.length, line: lineNumberAt(content, pos, lineStarts) });
    pos += needle.length;
  }
  return occurrences;
}

/**
 * Find contiguous line windows whose lines compare equal under `compare`.
 *
 * Non-overlapping only: a needle like `"a\na"` in `"a\na\na"` has two placements that share a line,
 * and reporting both would make `replaceAll` splice the same bytes twice. The first placement wins,
 * which is also what `String.replaceAll` does for a non-overlapping search.
 */
function lineOccurrences(
  content: string,
  needle: string,
  compare: (a: string, b: string) => boolean,
  lines: readonly ContentLine[]
): EditOccurrence[] {
  const trailingNewline = needle.endsWith("\n");
  const parts = needle.split("\n");
  if (trailingNewline) parts.pop();
  if (parts.length === 0) return [];

  if (parts.length > lines.length) return [];

  const occurrences: EditOccurrence[] = [];
  let lastEnd = -1;
  for (let i = 0; i + parts.length <= lines.length; i++) {
    let matches = true;
    for (let j = 0; j < parts.length; j++) {
      if (!compare(lines[i + j]!.text, parts[j]!)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    const first = lines[i]!;
    const last = lines[i + parts.length - 1]!;
    // A needle that ends with a newline needs a REAL line ending. The final synthetic line (after
    // the file's last "\n") has none, so `"a\nb\n\n"` must not absorb it and report a match for a
    // blank line the file does not have.
    if (trailingNewline && !last.hasNewline) continue;

    const start = first.start;
    const end = trailingNewline ? last.end + 1 : last.end;
    if (end <= start) continue;
    if (start < lastEnd) continue;
    occurrences.push({ start, end, line: i + 1 });
    lastEnd = end;
  }
  return occurrences;
}

// ============================================================================
// Matching ladder
// ============================================================================

const trimEndEqual = (a: string, b: string): boolean => a.trimEnd() === b.trimEnd();
const trimEqual = (a: string, b: string): boolean => a.trim() === b.trim();
const unicodeTrimEqual = (a: string, b: string): boolean =>
  normalizeForFuzzyMatch(a).trim() === normalizeForFuzzyMatch(b).trim();

/** Lazily-built, per-call views: one scan of the file instead of one per level / per edit. */
export interface MatchContext {
  lineStarts: number[];
  lines?: ContentLine[];
  normalized?: string;
}

function createMatchContext(content: string, lineStarts?: readonly number[]): MatchContext {
  return { lineStarts: lineStarts ? [...lineStarts] : buildLineStarts(content) };
}

/** First level that finds anything wins; a more tolerant level never overrides an exact hit. */
function matchLadder(
  content: string,
  needle: string,
  context: MatchContext
): { mode: EditMatchMode; occurrences: EditOccurrence[] } | null {
  const exact = exactOccurrences(content, needle, context.lineStarts);
  if (exact.length > 0) return { mode: "exact", occurrences: exact };

  const lfNeedle = toLF(needle);
  const lines = (context.lines ??= splitLines(content));

  const trimmedEnd = lineOccurrences(content, lfNeedle, trimEndEqual, lines);
  if (trimmedEnd.length > 0) return { mode: "trimEnd", occurrences: trimmedEnd };

  const trimmed = lineOccurrences(content, lfNeedle, trimEqual, lines);
  if (trimmed.length > 0) return { mode: "trim", occurrences: trimmed };

  // Substring level: typographic characters can appear mid-line, where whole-line comparison
  // cannot reach them. 1:1 normalization keeps the offsets valid (see `occurrencesInView`).
  const normalized = (context.normalized ??= normalizeForFuzzyMatch(content));
  const unicode = occurrencesInView(content, normalized, normalizeForFuzzyMatch(lfNeedle), context.lineStarts);
  if (unicode.length > 0) return { mode: "unicode", occurrences: unicode };

  const unicodeLines = lineOccurrences(content, lfNeedle, unicodeTrimEqual, lines);
  if (unicodeLines.length > 0) return { mode: "unicodeTrim", occurrences: unicodeLines };

  return null;
}

/**
 * Resolve one edit against `content` (LF-normalized).
 *
 * Does not enforce uniqueness — the caller decides whether multiple hits are an ambiguity or a
 * `replaceAll`. Does not treat `oldString === newString` as an error — that is an explicit no-op.
 */
export function findEditMatch(
  content: string,
  oldString: string,
  newString: string,
  context?: MatchContext
): EditMatchResult {
  if (oldString.length === 0) {
    return { ok: false, code: "empty", message: "oldString must not be empty." };
  }

  const ctx = context ?? createMatchContext(content);

  // The whole pipeline works on LF text, so a CRLF oldString must be matched in that view too.
  // The replacement is normalized for the same reason: `applyEditsToText` restores the file's line
  // ending afterwards, and a `\r\n` already in newString would come back as `\r\r\n`.
  const oldLF = toLF(oldString);
  for (const variant of variantCandidates(oldLF)) {
    const hit = matchLadder(content, variant.text, ctx);
    if (!hit) continue;
    return {
      ok: true,
      match: {
        mode: hit.mode,
        occurrences: hit.occurrences,
        matchedOld: variant.text,
        // The replacement belongs to the variant that matched: an over-escaped oldString usually
        // comes with an over-escaped newString, at the SAME escape depth.
        resolvedNew: toLF(unescapeTimes(newString, variant.passes)),
      },
    };
  }

  return {
    ok: false,
    code: "not_found",
    message: `not found in file content.${formatNotFoundHint(content, oldString, newString)}`,
  };
}

// ============================================================================
// Applying a batch
// ============================================================================

/**
 * Apply every edit against the ORIGINAL content and return the new LF-normalized content.
 *
 * Atomic by contract: any edit that cannot be resolved refuses the whole set (nothing is written),
 * and the error names the edit index so the model can re-send only that one.
 */
export function applyEdits(content: string, edits: readonly EditOperation[]): ApplyEditsResult {
  const operations: Array<ResolvedEditOperation | null> = [];
  const skipped: number[] = [];
  const ranges: Array<{ start: number; end: number; replacement: string; index: number }> = [];
  // One scan per batch: line numbers are needed for every hit, and a per-hit scan made a
  // `replaceAll` on a common token quadratic (a 480 KB file took 45 s before this).
  const context = createMatchContext(content);

  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index]!;

    if (edit.oldString === edit.newString) {
      // A no-op is only honest when the text is actually there. Sending old == new for text that is
      // absent (a common model slip) must still report not-found, not a green "0 replacements".
      const probe = findEditMatch(content, edit.oldString, edit.newString, context);
      if (!probe.ok) return { ok: false, index, message: probe.message };
      operations.push(null);
      skipped.push(index);
      continue;
    }

    const found = findEditMatch(content, edit.oldString, edit.newString, context);
    if (!found.ok) {
      return { ok: false, index, message: found.message };
    }

    const { occurrences, resolvedNew, mode } = found.match;
    if (occurrences.length > 1 && edit.replaceAll !== true) {
      const lines = occurrences.map((occurrence) => occurrence.line).join(", ");
      return {
        ok: false,
        index,
        message:
          `found ${occurrences.length} matches at lines ${lines}; add more surrounding context to make ` +
          `oldString unique, or set replaceAll to true`,
      };
    }

    const used = edit.replaceAll === true ? occurrences : [occurrences[0]!];
    const needleIndent = /^[ \t]*/.exec(toLF(edit.oldString))?.[0] ?? "";
    for (const occurrence of used) {
      // A line-based level compared WHOLE lines, so a needle that omitted indentation matched an
      // indented line. Re-apply that indentation to the replacement's first line when the model
      // supplied none — otherwise `"  return 1;"` → `"return 2;"` silently un-indents code.
      const lineIndent = mode === "exact" || mode === "unicode" ? "" : leadingWhitespaceAt(content, occurrence.start);
      const prefix = lineIndent && !needleIndent && !/^[ \t]/.test(resolvedNew) ? lineIndent : "";
      ranges.push({ start: occurrence.start, end: occurrence.end, replacement: prefix + resolvedNew, index });
    }
    operations.push({
      index,
      mode,
      count: used.length,
      firstLine: occurrences[0]!.line,
      ranges: used.map(({ start, end }) => ({ start, end })),
    });
  }

  // Overlap is checked before splicing: two edits that touch the same bytes have no defined result,
  // and applying them anyway would depend on range order.
  const ordered = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    // Equal starts are ambiguous even when one range is empty; `<` alone let two insertions at the
    // same offset through and applied them in reverse order.
    if (current.start < previous.end || current.start === previous.start) {
      return {
        ok: false,
        index: current.index,
        message:
          `edit #${previous.index + 1} and edit #${current.index + 1} overlap in the file; ` +
          `merge them into one edit instead of sending both`,
      };
    }
  }

  // One pass, ascending: a per-range `slice + slice` rebuild is O(n · ranges), which made a
  // `replaceAll` of a common token in a 1 MB file take ~16 s (80k ranges, each copying the file).
  const ascending = [...ranges].sort((a, b) => a.start - b.start);
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of ascending) {
    chunks.push(content.slice(cursor, range.start), range.replacement);
    cursor = range.end;
  }
  chunks.push(content.slice(cursor));
  const next = chunks.join("");

  // The batch can resolve every edit and still change nothing (an unescaped oldString whose
  // replacement is the matched bytes). Report those as skipped rather than as replacements, so the
  // tool does not claim "Edited (1 replacement)" for a file it did not write.
  if (next === content) {
    for (let index = 0; index < operations.length; index++) {
      if (operations[index]) {
        operations[index] = null;
        skipped.push(index);
      }
    }
  }

  return { ok: true, content: next, operations, skipped };
}

/**
 * The full file-text pipeline: split BOM, match on the LF view, restore BOM + line endings.
 *
 * Shared by the tool and the approval preview so the diff a user approves is byte-identical to the
 * write.
 */
export type ApplyEditTextResult =
  | { ok: true; content: string; operations: Array<ResolvedEditOperation | null>; skipped: number[] }
  | { ok: false; index: number; message: string };

export function applyEditsToText(raw: string, edits: readonly EditOperation[]): ApplyEditTextResult {
  const { bom, text } = splitBom(raw);
  const ending = detectLineEnding(text);
  const applied = applyEdits(toLF(text), edits);
  if (!applied.ok) return applied;

  // Nothing replaced (an all-identical batch): return the ORIGINAL bytes untouched. Round-tripping
  // through `fromLF` would otherwise normalize a mixed-ending file's endings for an edit that
  // changed nothing — a whole-file diff with no semantic change.
  if (!applied.operations.some((operation) => operation !== null)) {
    return { ok: true, content: raw, operations: applied.operations, skipped: applied.skipped };
  }

  return {
    ok: true,
    content: bom + fromLF(applied.content, ending),
    operations: applied.operations,
    skipped: applied.skipped,
  };
}

// ============================================================================
// Failure hint
// ============================================================================

/**
 * Actionable hint when `oldString` is not found.
 *
 * Two facts beat one line: (a) the replacement is already present, which usually means the edit was
 * applied before; (b) the closest run of lines, numbered like `read_file`, which the model can copy
 * straight back into a retry. The old hint searched a single line by an 8-character prefix, which
 * regularly pointed at an unrelated line.
 */
export function formatNotFoundHint(content: string, oldString: string, newString?: string): string {
  const view = normalizeForFuzzyMatch(toLF(content));
  if (newString && newString.trim().length >= 20 && view.includes(normalizeForFuzzyMatch(toLF(newString)))) {
    return " newString is already in the file, so this edit may already be applied. Re-read to confirm before retrying.";
  }

  const key = (line: string) => normalizeForFuzzyMatch(line).replace(/\s+/g, " ").trim();
  const meaningful = (line: string) => /[\p{L}\p{N}]/u.test(line);
  const lines = toLF(content).split("\n");
  const search = toLF(oldString).split("\n");

  const positions = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const value = key(line);
    if (!meaningful(value)) return;
    const found = positions.get(value);
    if (found) found.push(index);
    else positions.set(value, [index]);
  });

  const votes = new Map<number, number>();
  let wanted = 0;
  search.forEach((line, offset) => {
    const value = key(line);
    if (!meaningful(value)) return;
    wanted++;
    for (const index of positions.get(value) ?? []) {
      const start = index - offset;
      votes.set(start, (votes.get(start) ?? 0) + 1);
    }
  });

  let bestStart = 0;
  let bestCount = 0;
  for (const [start, count] of votes) {
    if (count > bestCount) {
      bestStart = start;
      bestCount = count;
    }
  }

  const guidance =
    " Re-read the file and copy oldString exactly from read_file — without the `N: ` line-number prefix.";
  if (bestCount === 0 || bestCount * 2 < wanted) return guidance;

  const matched: number[] = [];
  search.forEach((line, offset) => {
    const value = key(line);
    const index = bestStart + offset;
    if (value !== "" && index >= 0 && index < lines.length && key(lines[index]!) === value) matched.push(index);
  });
  if (matched.length === 0) return guidance;

  const from = matched[0]!;
  const to = Math.min(matched[matched.length - 1]! + 1, from + 12);
  return [
    " Closest lines in the file:",
    ...lines.slice(from, to).map((line, offset) => {
      const rendered = line.length > 200 ? `${line.slice(0, 200)}…` : line;
      return ` ${from + offset + 1}: ${rendered}`;
    }),
  ].join("\n");
}
