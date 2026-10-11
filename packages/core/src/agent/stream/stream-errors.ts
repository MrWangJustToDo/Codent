/**
 * Shared helpers for TanStack agent stream error chunks.
 */

import type { StreamChunk } from "@tanstack/ai";

/** Extract a human-readable message from an AG-UI RUN_ERROR chunk. */
export function extractRunErrorMessage(chunk: StreamChunk): string {
  if (chunk.type !== "RUN_ERROR") return "";
  const record = chunk as { message?: string; error?: { message?: string } | Error | string };
  if (typeof record.error === "string") return record.error;
  if (record.error instanceof Error) return record.error.message;
  return record.message ?? record.error?.message ?? "Unknown error";
}

/**
 * Return `error` carrying the `code` from an AG-UI RUN_ERROR chunk.
 *
 * `extractRunErrorMessage` keeps only the message, so a gateway that signals the failure
 * solely via `code` (e.g. `"429"` / `"503"`) would never reach the status/`\b429\b`
 * branches of `isTransientRetryableError`. The SDK stringifies an absent code into the
 * literal `"undefined"` — not a real signal. A no-op unless `chunk` is a RUN_ERROR with a
 * usable string code and `error` does not already carry one.
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

/** Fail fast when the model run emits RUN_ERROR instead of completing silently. */
export async function* throwOnRunError(stream: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    if (chunk.type === "RUN_ERROR") {
      const message = extractRunErrorMessage(chunk);
      throw new Error(message || "Agent run failed");
    }
    yield chunk;
  }
}
