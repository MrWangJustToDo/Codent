/**
 * Resolve LLM-provided edit strings against file content.
 *
 * Match order (first win for locating the old text):
 * 1. Exact substring
 * 2. Common over-escape variants (`\\n`→newline, `\\``→backtick, etc.)
 * 3. Unicode fuzzy (smart quotes / dashes / spaces)
 *
 * Safety: replacements still require a unique match unless `replaceAll` is set.
 * `startLine` disambiguates multiple matches and must land within
 * {@link START_LINE_TOLERANCE} of the chosen hit.
 */

import { truncateText } from "../../../../../utils/text-truncation.js";

import {
  fuzzyCount,
  fuzzyIncludes,
  fuzzyIndexOf,
  fuzzyReplace,
  fuzzyReplaceAll,
  normalizeForFuzzyMatch,
} from "./fuzzy-match.js";

// ============================================================================
// Types
// ============================================================================

export type EditMatchMode = "exact" | "unescape" | "fuzzy";

/** Max |actualLine - startLine| when startLine is provided. */
export const START_LINE_TOLERANCE = 20;

export interface ResolvedEditMatch {
  mode: EditMatchMode;
  /** Exact substring present in `content` (what replace uses for exact/unescape). */
  matchedOld: string;
  /** Replacement text to write. */
  resolvedNew: string;
  /** How many replacements this apply will perform. */
  occurrences: number;
  /** Index of the occurrence to replace when not replaceAll. */
  index: number;
}

export type ResolveEditMatchResult = ResolvedEditMatch | { error: string };

export interface ResolveEditMatchOptions {
  replaceAll?: boolean;
  /** 1-indexed preferred line; used to pick among multiple matches. */
  startLine?: number;
  /** Override {@link START_LINE_TOLERANCE} for tests. */
  startLineTolerance?: number;
  /** Optional pre-normalized content for fuzzy path. */
  normalizedContent?: string;
}

// ============================================================================
// Unescape variants
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

/** Unique variants of `text` that may appear in on-disk content. */
export function expandMatchVariants(text: string): string[] {
  const variants = new Set<string>([text]);

  // Iterative full unescape (LLM sometimes double/triple-escapes).
  let current = text;
  for (let i = 0; i < 3; i++) {
    const next = unescapeCommonEscapes(current);
    if (next === current) break;
    variants.add(next);
    current = next;
  }

  const onlyNewlines = text.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  variants.add(onlyNewlines);

  const onlyQuotes = text.replace(/\\`/g, "`").replace(/\\'/g, "'").replace(/\\"/g, '"');
  variants.add(onlyQuotes);

  const onlyBackslash = text.replace(/\\\\/g, "\\");
  variants.add(onlyBackslash);

  return [...variants];
}

// ============================================================================
// Line / count helpers
// ============================================================================

function lineNumberAtIndex(content: string, index: number): number {
  let line = 1;
  let from = 0;
  while (true) {
    const nl = content.indexOf("\n", from);
    if (nl === -1 || nl >= index) break;
    line++;
    from = nl + 1;
  }
  return line;
}

function countExact(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

function findAllIndices(content: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const indices: number[] = [];
  let pos = 0;
  while ((pos = content.indexOf(needle, pos)) !== -1) {
    indices.push(pos);
    pos += needle.length;
  }
  return indices;
}

function pickIndexNearLine(content: string, needle: string, startLine: number): number {
  const indices = findAllIndices(content, needle);
  if (indices.length === 0) return -1;
  if (indices.length === 1) return indices[0]!;

  let best = indices[0]!;
  let bestDist = Math.abs(lineNumberAtIndex(content, best) - startLine);
  for (let i = 1; i < indices.length; i++) {
    const idx = indices[i]!;
    const dist = Math.abs(lineNumberAtIndex(content, idx) - startLine);
    if (dist < bestDist) {
      best = idx;
      bestDist = dist;
    }
  }
  return best;
}

function checkStartLineProximity(
  content: string,
  index: number,
  startLine: number | undefined,
  tolerance: number
): string | null {
  if (startLine === undefined || index < 0) return null;
  const actual = lineNumberAtIndex(content, index);
  const dist = Math.abs(actual - startLine);
  if (dist <= tolerance) return null;
  return (
    `match at line ${actual} is ${dist} lines from startLine ${startLine} (max ±${tolerance}). ` +
    `Re-read the file and correct startLine, or omit startLine when the match is unique.`
  );
}

/**
 * Build an actionable hint when oldString is not found: nearest similar file line.
 */
export function formatNotFoundHint(content: string, oldString: string): string {
  const lines = content.split("\n");
  const needleLine =
    oldString
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length >= 6) ?? oldString.trim().slice(0, 48);

  if (!needleLine) {
    return " Re-read the file and copy oldString exactly from the numbered read_file output.";
  }

  const tryChunks = [
    needleLine.slice(0, Math.min(32, needleLine.length)),
    needleLine.slice(0, Math.min(16, needleLine.length)),
    needleLine.slice(0, Math.min(8, needleLine.length)),
  ].filter((c, i, arr) => c.length >= 4 && arr.indexOf(c) === i);

  let bestIdx = -1;
  for (const chunk of tryChunks) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(chunk)) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx >= 0) break;
  }

  if (bestIdx < 0) {
    return " Re-read the file and copy oldString exactly from the numbered read_file output (widen the snippet for uniqueness).";
  }

  const preview = truncateText(lines[bestIdx]!, 120);
  return ` Nearest similar line ${bestIdx + 1}: "${preview}". Re-read around that line and widen oldString so it is unique.`;
}

function notFoundError(content: string, oldString: string): ResolveEditMatchResult {
  return { error: `not found in file content.${formatNotFoundHint(content, oldString)}` };
}

function isErrorResult(result: ResolveEditMatchResult): result is { error: string } {
  return "error" in result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve how to apply one edit against `content`.
 * Returns the on-disk match pair, or a structured error.
 */
export function resolveEditMatch(
  content: string,
  oldString: string,
  newString: string,
  options: ResolveEditMatchOptions = {}
): ResolveEditMatchResult {
  if (oldString.length === 0) {
    return { error: "oldString must not be empty" };
  }

  if (oldString === newString) {
    return {
      error:
        "oldString and newString are identical (no-op). Provide a different newString, or skip the edit if the file is already correct.",
    };
  }

  const { replaceAll = false, startLine, startLineTolerance = START_LINE_TOLERANCE, normalizedContent } = options;

  // ── 1–2: Exact + unescape variants ──
  for (const variant of expandMatchVariants(oldString)) {
    if (!content.includes(variant)) continue;

    const hitCount = countExact(content, variant);
    if (!replaceAll && hitCount > 1 && startLine === undefined) {
      return {
        error: `found ${hitCount} matches; set replaceAll to replace all, or provide startLine / more context to make it unique`,
      };
    }

    const index =
      !replaceAll && hitCount > 1 && startLine !== undefined
        ? pickIndexNearLine(content, variant, startLine)
        : content.indexOf(variant);

    if (index === -1) {
      return notFoundError(content, oldString);
    }

    const proximityError = checkStartLineProximity(content, index, startLine, startLineTolerance);
    if (proximityError) {
      return { error: proximityError };
    }

    const mode: EditMatchMode = variant === oldString ? "exact" : "unescape";
    return {
      mode,
      matchedOld: variant,
      resolvedNew: mode === "unescape" ? unescapeCommonEscapes(newString) : newString,
      occurrences: replaceAll ? hitCount : 1,
      index,
    };
  }

  // ── 3: Unicode fuzzy ──
  const normalized = normalizedContent ?? normalizeForFuzzyMatch(content);
  if (!fuzzyIncludes(content, oldString, normalized)) {
    return notFoundError(content, oldString);
  }

  const fuzzyHits = fuzzyCount(content, oldString, normalized);
  if (!replaceAll && fuzzyHits > 1 && startLine === undefined) {
    return {
      error: `found ${fuzzyHits} fuzzy matches; set replaceAll to replace all, or provide startLine / more context to make it unique`,
    };
  }

  const index = fuzzyIndexOf(content, oldString);
  if (index === -1) {
    return notFoundError(content, oldString);
  }

  const proximityError = checkStartLineProximity(content, index, startLine, startLineTolerance);
  if (proximityError) {
    return { error: proximityError };
  }

  return {
    mode: "fuzzy",
    matchedOld: oldString,
    resolvedNew: newString,
    occurrences: replaceAll ? fuzzyHits : 1,
    index,
  };
}

/**
 * Apply a resolved match to `content`.
 *
 * The replacement is passed as a FUNCTION, never as the string. `String.replace`/`replaceAll` expand
 * `$$`, `$&`, `` $` ``, `$'` and `$<name>` inside a string replacement, so a `newString` containing any
 * of them was silently rewritten — `$$` arrived in the file as a single `$`. A tool must write exactly
 * what it was asked to write. (The fuzzy path never had this: it splices with `substring`.)
 */
export function applyResolvedEdit(
  content: string,
  match: ResolvedEditMatch,
  replaceAll: boolean,
  normalizedContent?: string
): string {
  if (match.mode === "fuzzy") {
    return replaceAll
      ? fuzzyReplaceAll(content, match.matchedOld, match.resolvedNew, normalizedContent)
      : fuzzyReplace(content, match.matchedOld, match.resolvedNew, normalizedContent);
  }

  if (replaceAll) {
    return content.replaceAll(match.matchedOld, () => match.resolvedNew);
  }

  const { matchedOld, resolvedNew, index } = match;
  if (content.slice(index, index + matchedOld.length) !== matchedOld) {
    return content.replace(matchedOld, () => resolvedNew);
  }
  return content.slice(0, index) + resolvedNew + content.slice(index + matchedOld.length);
}

export { isErrorResult };
