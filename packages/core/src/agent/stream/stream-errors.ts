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
 * Read the SDK-normalized retry hint from a `RUN_ERROR` chunk (or any source with the same shape).
 *
 * One definition of the field path: {@link attachRunErrorRetryAfterMs} writes it onto an error and
 * `extractRetryAfterMs` (recovery) reads it from a chunk or a caught error. Those two used to parse
 * the same two locations independently, so a third location added by the SDK would have been
 * picked up by only one of them.
 */
export function readRetryAfterMs(source: unknown): number | undefined {
  if (source == null || typeof source !== "object") return undefined;
  const record = source as {
    retryAfterMs?: unknown;
    metadata?: { tanstack?: { retryAfterMs?: unknown } };
  };
  const direct = record.retryAfterMs;
  if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;
  const nested = record.metadata?.tanstack?.retryAfterMs;
  if (typeof nested === "number" && Number.isFinite(nested) && nested > 0) return nested;
  return undefined;
}

/**
 * Copy the SDK-normalized retry hint from a `RUN_ERROR` chunk onto `error`.
 *
 * No-op when `error` already has one or the chunk has none — the same "the error owns the field
 * once set" rule as {@link attachRunErrorCode}, because both write the same object.
 */
export function attachRunErrorRetryAfterMs(error: Error, chunk: StreamChunk): Error {
  if (chunk.type !== "RUN_ERROR") return error;
  const target = error as Error & RunErrorSignals;
  if (target.retryAfterMs !== undefined) return error;
  const raw = readRetryAfterMs(chunk);
  if (raw !== undefined) target.retryAfterMs = raw;
  return error;
}

/**
 * The Error a `RUN_ERROR` chunk represents, carrying the chunk's out-of-band signals
 * (`code`, `retryAfterMs`).
 *
 * Two consumers must build this identically: the recovery loop (which classifies it and may
 * retry) and {@link throwOnRunError} (which turns the chunk into a throw for direct channel
 * consumers). Building it twice is how an overflow check that reads `code` worked on one route
 * and not the other.
 */
export function runErrorFromChunk(chunk: StreamChunk): Error {
  const message = extractRunErrorMessage(chunk) || "Agent run failed";
  return attachRunErrorRetryAfterMs(attachRunErrorCode(new Error(message), chunk), chunk);
}

/**
 * Fail fast when the model run emits RUN_ERROR instead of completing silently.
 */
export async function* throwOnRunError(stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    if (chunk.type === "RUN_ERROR") throw runErrorFromChunk(chunk);
    yield chunk;
  }
}
