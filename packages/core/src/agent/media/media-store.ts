/**
 * MediaStore — content-addressed binary asset persistence.
 *
 * Stores extracted base64 data (images, audio, PDFs) as decoded binary under
 * {@link MEDIA_DIR}, using the SHA-256 hash of the base64 string as the
 * filename. Duplicate content is only stored once.
 *
 * @example
 * ```ts
 * const store = new MediaStore(env); // the owning runtime's CoreEnv
 * const ref = await store.save("iVBORw0KGgo...", "image/png", "screenshot.png");
 * // File written to .agents/media/abc123...png (binary PNG bytes)
 * const dataUrl = await store.load(ref);
 * // "data:image/png;base64,iVBORw0KGgo..."
 * ```
 */

import { MEDIA_DIR, mimeToExtension } from "./types.js";

import type { MediaRef } from "./types.js";
import type { ResolvedCoreEnv } from "../../env";

// ============================================================================
// SHA-256 Hash
// ============================================================================

/**
 * Compute SHA-256 hex digest of a string's UTF-8 bytes.
 * Uses the Web Crypto API (available in Node.js 19+, browsers, Deno, Bun).
 * Exported for fingerprinting in media-utils.
 */
export async function sha256Stable(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Base64 Extraction
// ============================================================================

/**
 * Extract the raw base64 content from a source value.
 *
 * Handles two formats:
 * - Data URL: `data:{mimeType};base64,{raw}` → `{raw}`
 * - Raw base64 (no prefix) → returned as-is
 */
export function extractBase64Content(value: string): string {
  const base64Match = value.match(/^data:[^;]+;base64,(.+)$/s);
  if (base64Match) {
    return base64Match[1];
  }
  // Already raw base64 — return as-is
  return value;
}

/**
 * Build a data URL from a MIME type and raw base64 content.
 */
export function buildDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

// ============================================================================
// MediaStore
// ============================================================================

export class MediaStore {
  /** Workspace env for media reads/writes — always the owning runtime's env. */
  constructor(private readonly env: ResolvedCoreEnv) {}

  /**
   * Save a binary asset from a base64-encoded value.
   *
   * Accepts both data URLs (`data:image/png;base64,...`) and raw base64.
   * Content is stored as decoded binary under {@link MEDIA_DIR} with the
   * SHA-256 hash of the base64 string as filename. Same content is only written once.
   */
  async save(
    value: string,
    mimeType: string,
    filename: string | undefined,
    sourceType: "url" | "data"
  ): Promise<MediaRef> {
    const base64 = extractBase64Content(value);
    const hash = await sha256Stable(base64);
    const env = this.env;
    const bytes = env.base64Decode(base64);
    const size = bytes.byteLength;
    const ext = mimeToExtension(mimeType);
    const filePath = `${MEDIA_DIR}/${hash}.${ext}`;

    const exists = await env.fs.exists(filePath).catch(() => false);
    if (!exists) {
      await env.fs.mkdir(MEDIA_DIR).catch(() => {});
      await env.fs.writeFile(filePath, bytes);
    }

    return { hash, mimeType, filename, size, sourceType };
  }

  /**
   * Load a media asset and return its original value.
   *
   * For `sourceType: "url"`, returns a data URL (`data:{mimeType};base64,...`).
   * For `sourceType: "data"`, returns raw base64.
   */
  async load(ref: MediaRef): Promise<string> {
    const ext = mimeToExtension(ref.mimeType);
    const filePath = `${MEDIA_DIR}/${ref.hash}.${ext}`;
    const env = this.env;
    const bytes = await env.fs.readFile(filePath, "buffer");
    const base64 = env.base64Encode(bytes);

    if (ref.sourceType === "url") {
      return buildDataUrl(ref.mimeType, base64);
    }
    return base64;
  }

  /**
   * Try to load a media asset, returning `null` on failure.
   */
  async tryLoad(ref: MediaRef): Promise<string | null> {
    try {
      return await this.load(ref);
    } catch {
      return null;
    }
  }
}

// (No module singleton: a MediaStore is always constructed with its runtime's env, so two
// runtimes never share media storage. Callers that need one build `new MediaStore(env)`.)
