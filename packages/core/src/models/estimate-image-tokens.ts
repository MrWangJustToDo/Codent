/**
 * Estimate model input tokens for an image under Chat Completions vision pricing.
 *
 * Do NOT use base64 character length / 4 — that matches the broken "stringify tool
 * content" path and massively over-counts once images are sent as `image_url`.
 *
 * When width/height are known, use an OpenAI-like high-detail tile heuristic
 * (512px tiles). Otherwise fall back to compressed-byte size brackets.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

const TILE_SIZE = 512;
const BASE_TOKENS = 85;
const TOKENS_PER_TILE = 170;

/** OpenAI-style high-detail estimate from pixel dimensions. */
export function estimateImageTokensFromDimensions(width: number, height: number): number {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const tilesX = Math.ceil(w / TILE_SIZE);
  const tilesY = Math.ceil(h / TILE_SIZE);
  return BASE_TOKENS + tilesX * tilesY * TOKENS_PER_TILE;
}

/** Size-bracket fallback when dimensions are unavailable. */
export function estimateImageTokensFromByteLength(byteLength: number): number {
  if (byteLength <= 0) return BASE_TOKENS;
  if (byteLength < 50_000) return 800;
  if (byteLength < 200_000) return 1_600;
  if (byteLength < 500_000) return 3_200;
  if (byteLength < 1_500_000) return 6_400;
  return 10_000;
}

export function estimateImageInputTokens(byteLength: number, dimensions?: ImageDimensions | null): number {
  if (dimensions && dimensions.width > 0 && dimensions.height > 0) {
    return estimateImageTokensFromDimensions(dimensions.width, dimensions.height);
  }
  return estimateImageTokensFromByteLength(byteLength);
}

/** Parse PNG IHDR, JPEG SOF or GIF screen descriptor for width/height; returns null when unknown. */
export function tryReadImageDimensions(buffer: Uint8Array): ImageDimensions | null {
  if (buffer.length < 24) return null;

  // GIF: "GIF87a"/"GIF89a", then the logical-screen width/height as little-endian uint16.
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    const width = buffer[6]! | (buffer[7]! << 8);
    const height = buffer[8]! | (buffer[9]! << 8);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }

  // PNG: 8-byte signature + IHDR length(4) + type(4) + width(4) + height(4)
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    const width = readUint32BE(buffer, 16);
    const height = readUint32BE(buffer, 20);
    if (width > 0 && height > 0) return { width, height };
    return null;
  }

  // JPEG: scan for SOF0/SOF2 markers
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = (buffer[offset + 2]! << 8) | buffer[offset + 3]!;
      if (length < 2) break;
      // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 8 < buffer.length) {
        const height = (buffer[offset + 5]! << 8) | buffer[offset + 6]!;
        const width = (buffer[offset + 7]! << 8) | buffer[offset + 8]!;
        if (width > 0 && height > 0) return { width, height };
        return null;
      }
      offset += 2 + length;
    }
  }

  return null;
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
  return (
    ((buffer[offset]! << 24) | (buffer[offset + 1]! << 16) | (buffer[offset + 2]! << 8) | buffer[offset + 3]!) >>> 0
  );
}
