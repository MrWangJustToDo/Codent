/**
 * Fuzzy matching utilities for edit operations.
 *
 * Handles common Unicode normalization issues like smart quotes,
 * dashes, and special spaces that LLMs sometimes produce.
 */

// ============================================================================
// Normalization Maps
// ============================================================================

/** Map of smart/curly quotes to ASCII equivalents */
const SMART_QUOTES: Record<string, string> = {
  // Left double quotes
  "\u201C": '"', // "
  "\u201D": '"', // "
  // Right double quotes
  "\u2018": "'", // '
  "\u2019": "'", // '
  // Single angle quotes
  "\u2039": "'",
  "\u203A": "'",
  // Double angle quotes
  "\u00AB": '"',
  "\u00BB": '"',
  // Low double comma quotes
  "\u201E": '"',
  "\u201F": '"',
  // Fullwidth quotation marks
  "\uFF02": '"',
  "\uFF07": "'",
};

/** Map of Unicode dashes to ASCII hyphen */
const UNICODE_DASHES: Record<string, string> = {
  "\u2010": "-", // hyphen
  "\u2011": "-", // non-breaking hyphen
  "\u2012": "-", // figure dash
  "\u2013": "-", // en dash
  "\u2014": "-", // em dash
  "\u2015": "-", // horizontal bar
  "\u2212": "-", // minus sign
  "\uFE58": "-", // small em dash
  "\uFE63": "-", // small hyphen-minus
  "\uFF0D": "-", // fullwidth hyphen-minus
};

/** Map of special spaces to regular space */
const SPECIAL_SPACES: Record<string, string> = {
  "\u00A0": " ", // non-breaking space
  "\u2000": " ", // en quad
  "\u2001": " ", // em quad
  "\u2002": " ", // en space
  "\u2003": " ", // em space
  "\u2004": " ", // three-per-em space
  "\u2005": " ", // four-per-em space
  "\u2006": " ", // six-per-em space
  "\u2007": " ", // figure space
  "\u2008": " ", // punctuation space
  "\u2009": " ", // thin space
  "\u200A": " ", // hair space
  "\u200B": "", // zero-width space (remove)
  "\u200C": "", // zero-width non-joiner (remove)
  "\u200D": "", // zero-width joiner (remove)
  "\u2060": "", // word joiner (remove)
  "\u2061": "", // function application (remove)
  "\uFEFF": "", // BOM / zero-width no-break space (remove)
};

/** Combined normalization map */
const NORMALIZATION_MAP: Record<string, string> = {
  ...SMART_QUOTES,
  ...UNICODE_DASHES,
  ...SPECIAL_SPACES,
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Normalize Unicode characters to their ASCII equivalents.
 *
 * Handles smart quotes, Unicode dashes, and special spaces that
 * LLMs sometimes produce when editing code.
 *
 * @param text - The text to normalize
 * @returns The normalized text with ASCII equivalents
 */
export function normalizeForFuzzyMatch(text: string): string {
  // Fast path: if no normalizable character is present, return as-is.
  // This avoids allocating a new string for the common case (pure ASCII code).
  if (!needsNormalization(text)) {
    return text;
  }
  let result = "";
  for (const char of text) {
    const normalized = NORMALIZATION_MAP[char];
    if (normalized !== undefined) {
      result += normalized;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Quick check whether a string contains any character that would be changed
 * by normalization. Used to skip the per-character loop for pure-ASCII text.
 */
function needsNormalization(text: string): boolean {
  // All normalizable chars are outside the ASCII range (>= 0x80).
  // Scan with charCodeAt (faster than for...of for ASCII-heavy text).
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) {
      return true;
    }
  }
  return false;
}

/**
 * Check if two strings are approximately equal using fuzzy matching.
 *
 * @param a - First string
 * @param b - Second string
 * @returns true if the strings are approximately equal
 */
export function fuzzyEquals(a: string, b: string): boolean {
  return normalizeForFuzzyMatch(a) === normalizeForFuzzyMatch(b);
}

/**
 * Find the index of a fuzzy match in a string.
 *
 * @param haystack - The string to search in
 * @param needle - The string to search for
 * @returns The index of the first fuzzy match, or -1 if not found
 */
export function fuzzyIndexOf(haystack: string, needle: string): number {
  const normalizedHaystack = normalizeForFuzzyMatch(haystack);
  const normalizedNeedle = normalizeForFuzzyMatch(needle);
  return normalizedHaystack.indexOf(normalizedNeedle);
}

/**
 * Check if a string contains a fuzzy match.
 *
 * Accepts an optional pre-normalized haystack to avoid re-normalizing the
 * (potentially large) file content on every call.
 *
 * @param haystack - The string to search in
 * @param needle - The string to search for
 * @param normalizedHaystack - Optional pre-normalized haystack for reuse
 * @returns true if the haystack contains the needle (fuzzy)
 */
export function fuzzyIncludes(haystack: string, needle: string, normalizedHaystack?: string): boolean {
  const nh = normalizedHaystack ?? normalizeForFuzzyMatch(haystack);
  const nn = normalizeForFuzzyMatch(needle);
  return nh.indexOf(nn) !== -1;
}

/**
 * Replace the first fuzzy match in a string.
 *
 * Accepts an optional pre-normalized haystack to avoid re-normalizing the
 * (potentially large) file content on every call.
 *
 * @param haystack - The string to search in
 * @param needle - The string to replace
 * @param replacement - The replacement string
 * @param normalizedHaystack - Optional pre-normalized haystack for reuse
 * @returns The string with the first fuzzy match replaced
 */
export function fuzzyReplace(
  haystack: string,
  needle: string,
  replacement: string,
  normalizedHaystack?: string
): string {
  const nh = normalizedHaystack ?? normalizeForFuzzyMatch(haystack);
  const normalizedNeedle = normalizeForFuzzyMatch(needle);
  const index = nh.indexOf(normalizedNeedle);
  if (index === -1) {
    return haystack;
  }

  const needleLength = normalizedNeedle.length;

  // Find the actual end position in the original string
  let endPos = index;
  let normalizedCount = 0;
  while (endPos < haystack.length && normalizedCount < needleLength) {
    const char = haystack[endPos];
    const normalized = NORMALIZATION_MAP[char];
    if (normalized !== undefined) {
      normalizedCount += normalized.length;
    } else {
      normalizedCount += 1;
    }
    endPos++;
  }

  return haystack.substring(0, index) + replacement + haystack.substring(endPos);
}

/**
 * Replace all fuzzy matches in a string.
 *
 * Single-pass scan: collect all match spans in the normalized haystack, then
 * build the result by slicing the original haystack around the spans. This is
 * O(M) instead of the previous O(k×M) which re-normalized the whole result
 * after every single replacement.
 *
 * @param haystack - The string to search in
 * @param needle - The string to replace
 * @param replacement - The replacement string
 * @param normalizedHaystack - Optional pre-normalized haystack for reuse
 * @returns The string with all fuzzy matches replaced
 */
export function fuzzyReplaceAll(
  haystack: string,
  needle: string,
  replacement: string,
  normalizedHaystack?: string
): string {
  const nh = normalizedHaystack ?? normalizeForFuzzyMatch(haystack);
  const normalizedNeedle = normalizeForFuzzyMatch(needle);

  if (normalizedNeedle.length === 0) {
    return haystack;
  }

  // Collect [start, end) spans (in original-string coordinates) for every
  // match in the normalized haystack.
  const spans: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while ((pos = nh.indexOf(normalizedNeedle, pos)) !== -1) {
    // Map the normalized match back to the original string's char range.
    let endPos = pos;
    let normalizedCount = 0;
    while (endPos < haystack.length && normalizedCount < normalizedNeedle.length) {
      const char = haystack[endPos];
      const normalized = NORMALIZATION_MAP[char];
      if (normalized !== undefined) {
        normalizedCount += normalized.length;
      } else {
        normalizedCount += 1;
      }
      endPos++;
    }
    spans.push({ start: pos, end: endPos });
    pos = endPos;
  }

  if (spans.length === 0) {
    return haystack;
  }

  // Build the result by interleaving untouched segments with replacements.
  let result = "";
  let cursor = 0;
  for (const span of spans) {
    result += haystack.substring(cursor, span.start);
    result += replacement;
    cursor = span.end;
  }
  result += haystack.substring(cursor);
  return result;
}

/**
 * Count fuzzy matches in a string.
 *
 * Accepts an optional pre-normalized haystack to avoid re-normalizing the
 * (potentially large) file content on every call.
 *
 * @param haystack - The string to search in
 * @param needle - The string to count
 * @param normalizedHaystack - Optional pre-normalized haystack for reuse
 * @returns The number of fuzzy matches
 */
export function fuzzyCount(haystack: string, needle: string, normalizedHaystack?: string): number {
  const nh = normalizedHaystack ?? normalizeForFuzzyMatch(haystack);
  const normalizedNeedle = normalizeForFuzzyMatch(needle);

  if (normalizedNeedle.length === 0) {
    return 0;
  }

  let count = 0;
  let pos = 0;
  while ((pos = nh.indexOf(normalizedNeedle, pos)) !== -1) {
    count++;
    pos += normalizedNeedle.length;
  }
  return count;
}
