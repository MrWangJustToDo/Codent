/** Default limits for tool output truncation and file materialisation. */
export const OUTPUT_LIMITS = {
  /**
   * Ceiling on content ACCUMULATED across one result's items — grep matches, a tree, a
   * session-read page. Several items share this budget, so it is the smaller content ceiling.
   */
  MAX_CONTENT_CHARS: 50000,
  /**
   * Ceiling on the rendered content of ONE result — a `read_file` page, a `webfetch` extract.
   * These turn over a single body rather than sharing a budget, so they carry more.
   */
  MAX_RESULT_CONTENT_CHARS: 100000,
  /** Maximum items in arrays (files, entries, matches, etc.) */
  MAX_ARRAY_ITEMS: 500,
  /** Maximum characters per line */
  MAX_LINE_CHARS: 2000,
  /**
   * Ceiling on the bytes a file-read tool will materialise, whatever the file kind (text, PDF,
   * image). A whole-file read is inherent to line accounting, so this is a MEMORY bound, not an
   * output-length one — kept here so the read tools share one "too large to read" boundary.
   */
  MAX_FILE_READ_BYTES: 10 * 1024 * 1024,
  /**
   * Ceiling on the pixels an image may DECLARE before anything decodes it.
   *
   * A file's byte size says nothing about what decoding it costs: a 1 KB PNG can declare
   * 50000x50000, i.e. 2.5 gigapixels and ~10 GB once expanded. `MAX_FILE_READ_BYTES` therefore
   * cannot bound an image, so the declared dimensions are checked first. Above any photograph that
   * fits the byte ceiling (a 50 MP camera JPEG is ~8192x6144), far below a bomb.
   */
  MAX_IMAGE_PIXELS: 50_000_000,
  /** Ceiling on one image SIDE, which also catches a degenerate 1xN declaration. */
  MAX_IMAGE_DIMENSION: 16_384,
} as const;

/** Truncate a string from the end (or the start) with an indicator of what was dropped. */
export function truncateString(str: string, maxLength: number, fromEnd = false): { text: string; truncated: boolean } {
  if (str.length <= maxLength) {
    return { text: str, truncated: false };
  }

  if (fromEnd) {
    return {
      text: `[...truncated ${str.length - maxLength} chars from start...]\n${str.slice(-maxLength)}`,
      truncated: true,
    };
  } else {
    return {
      text: `${str.slice(0, maxLength)}\n[...truncated ${str.length - maxLength} chars...]`,
      truncated: true,
    };
  }
}
