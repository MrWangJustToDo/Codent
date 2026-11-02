/**
 * Unicode normalization for the "typographic equivalents" match level.
 *
 * **Every mapping here is 1:1** (one code point → one character of the same UTF-16 length). That is
 * a hard requirement of the matcher: it works on an LF-normalized view and splices by offset, and a
 * length-changing normalization would make a normalized index point at a different place in the
 * original text. The previous map removed zero-width characters (`\u200B` and friends), so a match
 * after one of them spliced one character early and silently corrupted the file. Those entries are
 * gone; a file containing zero-width characters simply falls back to the exact/whitespace levels.
 *
 * Only the Unicode comparison levels use this; it is never applied to the text that is written.
 */

// ============================================================================
// Normalization map (1:1 only)
// ============================================================================

/** Map of smart/curly quotes to ASCII equivalents */
const SMART_QUOTES: Record<string, string> = {
  "\u201C": '"', // left double quote
  "\u201D": '"', // right double quote
  "\u2018": "'", // left single quote
  "\u2019": "'", // right single quote
  "\u2039": "'", // single left angle quote
  "\u203A": "'", // single right angle quote
  "\u00AB": '"', // double left angle quote
  "\u00BB": '"', // double right angle quote
  "\u201E": '"', // low double comma quote
  "\u201F": '"', // high double comma quote
  "\uFF02": '"', // fullwidth quotation mark
  "\uFF07": "'", // fullwidth apostrophe
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
  "\u202F": " ", // narrow no-break space
  "\u205F": " ", // medium mathematical space
  "\u3000": " ", // ideographic space
};

/** Combined normalization map. */
const NORMALIZATION_MAP: Record<string, string> = {
  ...SMART_QUOTES,
  ...UNICODE_DASHES,
  ...SPECIAL_SPACES,
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Normalize Unicode punctuation to its ASCII equivalent, preserving length.
 *
 * @param text - The text to normalize
 * @returns The normalized text with ASCII equivalents (same length as the input)
 */
export function normalizeForFuzzyMatch(text: string): string {
  // Fast path: if no normalizable character is present, return as-is.
  if (!needsNormalization(text)) return text;
  let result = "";
  for (const char of text) {
    result += NORMALIZATION_MAP[char] ?? char;
  }
  return result;
}

/** Quick check whether a string contains any character that normalization would change. */
function needsNormalization(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80 && NORMALIZATION_MAP[text[i]!] !== undefined) return true;
  }
  return false;
}
