/**
 * Shared helpers for TanStack agent stream error chunks.
 */

import { extractRunErrorMessage } from "./run-error-message.js";

import type { StreamChunk } from "@tanstack/ai";

/** Re-exported so existing importers keep working through this module. */
export { extractRunErrorMessage } from "./run-error-message.js";

/**
 * Return `error` carrying the `code` from an AG-UI RUN_ERROR chunk.
 *
 * `extractRunErrorMessage` keeps only the message, so a gateway that signals the failure
 * solely via `code` (e.g. `"429"` / `"503"`) would never reach the status/`\b429\b`
 * branches of `isTransientRetryableError`, and a normalized overflow code
 * (`context_overflow`) would never reach {@link isPromptTooLongError}. The SDK
 * stringifies an absent code into the literal `"undefined"` — not a real signal. A
 * no-op unless `chunk` is a RUN_ERROR with a usable string code and `error` does not
 * already carry one.
 */
export function attachRunErrorCode(error: Error, chunk: StreamChunk): Error {
  if (chunk.type !== "RUN_ERROR") return error;
  const target = error as Error & { code?: unknown };
  if (target.code !== undefined) return error;
  const rawCode = (chunk as { code?: unknown }).code;
  if (typeof rawCode === "string" && rawCode.length > 0 && rawCode !== "undefined") {
    target.code = rawCode;
  }
  return error;
}

/**
 * An error carrying the signals a `RUN_ERROR` chunk holds outside its message.
 *
 * `code` is the provider's stable failure code (`context_overflow`, `429`, …) — the
 * channel that survives the SDK's error-to-chunk conversion, and the one structured
 * signal a classifier can branch on instead of matching prose. `retryAfterMs` is the
 * SDK-normalized retry hint, surfaced on the error so a consumer that holds only the
 * error (not the chunk) can still honour it.
 */
export interface RunErrorSignals {
  code?: string;
  retryAfterMs?: number;
}

/**
 * Copy the SDK-normalized retry hint from a `RUN_ERROR` chunk onto `error`.
 *
 * Reads `metadata.tanstack.retryAfterMs` (the mirror `@tanstack/ai` 0.67+ writes)
 * and also the bare `retryAfterMs` a chunk may carry. No-op when `error` already
 * has one or the chunk has none — the same "the error owns the field once set"
 * rule as {@link attachRunErrorCode}, because both write the same object.
 */
export function attachRunErrorRetryAfterMs(error: Error, chunk: StreamChunk): Error {
  if (chunk.type !== "RUN_ERROR") return error;
  const target = error as Error & RunErrorSignals;
  if (target.retryAfterMs !== undefined) return error;
  const record = chunk as { retryAfterMs?: unknown; metadata?: { tanstack?: { retryAfterMs?: unknown } } };
  const raw = record.retryAfterMs ?? record.metadata?.tanstack?.retryAfterMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    target.retryAfterMs = raw;
  }
  return error;
}

/**
 * Fail fast when the model run emits RUN_ERROR instead of completing silently.
 *
 * The thrown error carries the chunk's `code` / `retryAfterMs` (via the two
 * `attachRunError*` helpers), so a consumer that classifies the failure downstream
 * sees the same signals it would have seen on the chunk route. Dropping them here
 * made an overflow check that reads `code` work on one route and not the other.
 */
export async function* throwOnRunError(stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    if (chunk.type === "RUN_ERROR") {
      const message = extractRunErrorMessage(chunk) || "Agent run failed";
      throw attachRunErrorRetryAfterMs(attachRunErrorCode(new Error(message), chunk), chunk);
    }
    yield chunk;
  }
}
