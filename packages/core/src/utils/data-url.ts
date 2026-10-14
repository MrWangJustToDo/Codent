/**
 * Data-URL / base64 parsing — the one definition.
 *
 * Five modules each carried their own `data:*;base64,` regular expression (media persistence, the
 * media dehydrate/hydrate walk, webfetch, and the chat-completions audio adapter) and they had
 * already drifted: one captured the MIME type, one captured the payload, one captured neither, and
 * the character classes disagreed about whether a comma is allowed inside the media type. Parsing
 * and prefix-stripping live here so the next consumer does not choose a sixth shape.
 */

/** The decoded parts of a `data:*;base64,` URL. */
export interface ParsedDataUrl {
  /** Media type between `data:` and `;base64`, for example `image/png`. */
  mimeType: string;
  /** Base64 payload after the comma. */
  base64: string;
}

/** Matches a base64 data URL and captures its media type and payload. */
const DATA_URL_PATTERN = /^data:([^;,]*);base64,(.*)$/s;

/** Whether a value is a base64 data URL. */
export function isDataUrl(value: string): boolean {
  return /^data:[^;]+;base64,/s.test(value);
}

/** Parse a base64 data URL into its media type and payload, or `null` when it is not one. */
export function parseDataUrl(value: string): ParsedDataUrl | null {
  const match = DATA_URL_PATTERN.exec(value);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

/** Build a base64 data URL from a media type and payload. */
export function buildDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Strip a `data:*;base64,` prefix from a value, returning the raw base64 payload.
 * A value that is not a data URL is returned unchanged.
 */
export function stripDataUrlPrefix(value: string): string {
  const parsed = parseDataUrl(value);
  return parsed ? parsed.base64 : value;
}

/**
 * Whether a source value carries base64 data — either a base64 data URL or a raw base64 string.
 *
 * The raw check requires at least 20 base64-alphabet characters, so a short metadata string is
 * not mistaken for content.
 */
export function isBase64Source(value: string): boolean {
  if (isDataUrl(value)) return true;
  if (value.length < 20) return false;
  return /^[A-Za-z0-9+/=]+$/.test(value);
}
