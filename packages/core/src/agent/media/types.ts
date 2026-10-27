/**
 * Media types — content-addressed asset references for session persistence.
 *
 * Binary assets (images, audio, PDFs) are extracted from inline base64 in
 * {@link UIMessage} parts and stored as content-addressed **binary** files under
 * `.agents/media/<hash>.<ext>`. The session JSON stores only the
 * {@link MediaRef} metadata and a `media://<hash>` reference.
 *
 * Runtime (hydrated) state always keeps data URLs in `source.value` so the
 * UI and LLM conversion see the full multimodal content. Dehydrate happens
 * only during persist, and hydrate happens only during restore.
 */

import { AGENT_DATA_DIR } from "../../utils/workspace-paths.js";

/** Directory relative to workspace root where media files are stored. */
export const MEDIA_DIR = `${AGENT_DATA_DIR}/media`;

/**
 * UIMessage part types that carry inline binary media.
 *
 * The single membership set for the media module: the dehydrate/hydrate walk and the nested
 * tool-result rewrite both test against this, so the four types cannot be listed twice and drift.
 */
export const BINARY_MEDIA_PART_TYPES = ["image", "audio", "video", "document"] as const;

/** One of the binary media part types. */
export type BinaryMediaPartType = (typeof BINARY_MEDIA_PART_TYPES)[number];

/** Whether a part type carries inline binary media. */
export function isBinaryMediaPartType(type: string | undefined): type is BinaryMediaPartType {
  return typeof type === "string" && (BINARY_MEDIA_PART_TYPES as readonly string[]).includes(type);
}

/** Protocol prefix used in dehydrated source.value to reference a media file. */
export const MEDIA_PROTOCOL = "media://";

/**
 * Whether a value is a dehydrated `media://` reference rather than fetchable content.
 *
 * The one definition of "this is a media ref": hydrate (`media-utils`) and the wire seam that
 * substitutes a placeholder for an unreadable ref (`wire-recovery`) must agree, because a value
 * hydrate declines to load is exactly a value no provider can fetch.
 */
export function isMediaRefValue(value: string): boolean {
  return value.startsWith(MEDIA_PROTOCOL);
}

/**
 * Content-addressed media reference stored in part metadata after dehydrate.
 * On hydrate, the file is read back and `source.value` is reconstructed
 * as a data URL (or raw base64, matching the original source type).
 */
export interface MediaRef {
  /**
   * SHA-256 hex digest of the base64 string (not the decoded binary).
   * On-disk files are binary bytes; the hash stays base64-based for stable
   * content addressing.
   */
  hash: string;
  /** MIME type (e.g. "image/png", "application/pdf"). */
  mimeType: string;
  /** Original filename (may be empty if unknown). */
  filename?: string;
  /** File size in bytes. */
  size: number;
  /**
   * Original source type before dehydrate.
   * - `"url"` → `source.value` was `data:{mimeType};base64,{raw}` (data URL)
   * - `"data"` → `source.value` was raw base64 (no prefix)
   *
   * Hydrate uses this to reconstruct the original shape.
   */
  sourceType: "url" | "data";
}

/** Standard MIME → file extension mapping for content-addressed filenames. */
const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "audio/flac": "flac",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
};

/**
 * Get the file extension for a MIME type.
 * Falls back to `"bin"` for unknown types.
 */
export function mimeToExtension(mimeType: string): string {
  return MIME_TO_EXT[mimeType] ?? "bin";
}

/**
 * Reverse of {@link MIME_TO_EXT}: the MIME type a stored extension implies.
 *
 * `jpeg` is an accepted alias for the canonical `jpg` extension so a legacy
 * `media://<hash>.jpeg` reference still resolves its MIME type.
 */
const EXT_TO_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime])),
  jpeg: "image/jpeg",
};

/** Get the MIME type for a stored file extension, or `undefined` when unknown. */
export function extensionToMime(ext: string): string | undefined {
  return EXT_TO_MIME[ext];
}

/**
 * Build a `media://<hash>.<ext>` reference string for a MediaRef.
 */
export function buildMediaRefPath(ref: MediaRef): string {
  return `${MEDIA_PROTOCOL}${ref.hash}.${mimeToExtension(ref.mimeType)}`;
}

/**
 * A media filename hash is the lowercase SHA-256 hex of the base64 payload
 * ({@link sha256Stable}). Validated before it becomes a path: a restored/shared session can carry
 * any string in `mediaRef.hash`, and concatenating it into `${MEDIA_DIR}/${hash}.${ext}` let
 * `../../.env` read a workspace file and hydrate it into a data URL for the model.
 */
const MEDIA_HASH_RE = /^[0-9a-f]{64}$/;

/** Whether `hash` is a valid media content hash (and therefore safe as a path segment). */
export function isMediaHash(hash: string): boolean {
  return MEDIA_HASH_RE.test(hash);
}

/**
 * Parse a `media://<hash>.<ext>` reference string.
 * Returns `{ hash, ext }` or `null` if the string is not a valid media reference.
 *
 * Deliberately does not require a full hash: the shape is also used by hosts/fixtures with short
 * ids. The path boundary ({@link isMediaHash} in `MediaStore.load` and hydration) is where a hash
 * must be real, because that is where it becomes a filename.
 */
export function parseMediaRefPath(ref: string): { hash: string; ext: string } | null {
  if (!isMediaRefValue(ref)) return null;
  const rest = ref.slice(MEDIA_PROTOCOL.length);
  const dot = rest.lastIndexOf(".");
  if (dot === -1) return null;
  return { hash: rest.slice(0, dot), ext: rest.slice(dot + 1) };
}
