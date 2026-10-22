/**
 * Charset-aware byte→text decoding, shared by every byte-level text boundary
 * (webfetch HTTP bodies, file reads).
 *
 * Text bytes carry no inherent encoding, and `new TextDecoder()` assumes UTF-8 — so a
 * GBK / ISO-8859-1 / Shift-JIS payload decodes as mojibake. This module centralizes the
 * browser-style resolution order so all callers share one implementation:
 *
 * 1. an explicit charset (a `Content-Type` header / caller override)
 * 2. a Unicode byte-order mark (UTF-8 / UTF-16 LE / UTF-16 BE)
 * 3. a `<meta charset>` in the document head (web payloads; harmless for files, which
 *    rarely carry such markup in the first {@link CHARSET_SNIFF_BYTES} bytes)
 * 4. UTF-8
 *
 * An unsupported label falls back to UTF-8 rather than throwing.
 */

/** Bytes of the head scanned for a `<meta charset>` when no BOM / header charset is present. */
export const CHARSET_SNIFF_BYTES = 1024;

export interface DecodeOptions {
  /** Charset from a `Content-Type` header (or an explicit caller override). */
  contentType?: string;
}

/** Encoding implied by a leading byte-order mark, or `null` when none is present. */
export function detectBomEncoding(bytes: Uint8Array): "utf-8" | "utf-16le" | "utf-16be" | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

/** Resolve the charset label to decode `bytes` with (see the module-level order). */
export function resolveCharset(bytes: Uint8Array, contentType?: string): string {
  const headerCharset = contentType ? /charset=["']?\s*([\w-]+)/i.exec(contentType)?.[1] : undefined;
  if (headerCharset) return headerCharset;

  // A BOM is authoritative — no need to sniff the markup.
  const bom = detectBomEncoding(bytes);
  if (bom) return bom;

  // Scan the head as latin1 so byte offsets and ASCII tags line up.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, CHARSET_SNIFF_BYTES));
  const metaCharset =
    /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)?.[1];
  return metaCharset ?? "utf-8";
}

/**
 * Decode bytes to text, honoring an explicit charset, a BOM, or a `<meta charset>`.
 *
 * `TextDecoder` strips the matching BOM from the output, so the decoded text never
 * begins with a stray `\uFEFF`.
 */
export function decodeBytes(bytes: Uint8Array, options: DecodeOptions = {}): string {
  const charset = resolveCharset(bytes, options.contentType);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
