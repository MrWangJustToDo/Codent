/**
 * Bounded HTTP body reads — the one implementation of "materialise a `Response` body, but never
 * more than `maxBytes`".
 *
 * `Content-Length` is not a bound: it is the WIRE (compressed) length, so it says nothing about a
 * gzip/deflate bomb, a `Transfer-Encoding: chunked` body (no header at all), or a header that
 * simply lies. `response.arrayBuffer()` / `.text()` / `.json()` materialise the body first and
 * check never, so a hostile or broken URL — including one a prompt injection points at — can OOM
 * the process; under `--remote-env` / remote-session the fetch runs SERVER-side, so one bomb takes
 * every session down with it. These read chunk-by-chunk and stop the moment the running total
 * exceeds the limit.
 *
 * A host whose `Response` exposes no streaming body falls back to the buffered path; the bound
 * still applies there, just after the allocation.
 */

import { decodeBytes, type DecodeOptions } from "./text-decoding.js";

/**
 * A generous cap for a trusted-but-must-be-bounded HTTP endpoint (a search API, MCP-over-HTTP).
 *
 * Far above any payload those legitimately return — the point is that a ceiling exists at all, not
 * that it is tight. `webfetch` keeps its own limit because that number is part of its contract.
 */
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Read a `Response` body into one `Uint8Array`, refusing to buffer more than `maxBytes`. */
export async function readBodyBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`Response too large: ${arrayBuffer.byteLength} bytes (limit: ${maxBytes})`);
    }
    return new Uint8Array(arrayBuffer);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling and release the connection, best-effort: a cancel failure must not mask
        // the size verdict the caller needs.
        await reader.cancel().catch(() => {});
        throw new Error(`Response too large: ${total} bytes (limit: ${maxBytes})`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * {@link readBodyBounded}, decoded to text with the shared charset resolution.
 *
 * Use this instead of `response.text()` for any endpoint whose size is not already guaranteed: it
 * is the same convenience with a ceiling. `response.text()` honors the `Content-Type` charset, so
 * this passes the header's own `content-type` through when the caller names none — the decode stays
 * as faithful as the API it replaces (BOM and `<meta charset>` still win when the header is silent).
 */
export async function readBodyTextBounded(
  response: Response,
  maxBytes: number,
  options: DecodeOptions = {}
): Promise<string> {
  const contentType = options.contentType ?? response.headers?.get?.("content-type") ?? undefined;
  return decodeBytes(await readBodyBounded(response, maxBytes), { ...options, contentType });
}
