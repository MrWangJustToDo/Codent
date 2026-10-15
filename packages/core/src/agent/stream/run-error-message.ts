/**
 * Message extraction for AG-UI `RUN_ERROR` chunks.
 *
 * A module of its own because both directions of the module graph need it and must
 * not agree by duplication: `agent/stream` turns a chunk into an Error, and
 * `agent/compaction` classifies an Error that may still *be* a chunk. Before this
 * split the compaction layer could not import the extractor at all — `agent/stream`
 * imports the compaction layer's `isPromptTooLongError` caller chain — so a
 * shape-aware classifier would have had to re-implement the message rule.
 */

import type { StreamChunk } from "@tanstack/ai";

/**
 * Extract a human-readable message from an AG-UI RUN_ERROR chunk.
 *
 * Tolerant of both chunk shapes seen in the wild: the SDK's `{ message }` and a
 * wrapped `{ error: string | Error | { message } }`. The provider's own code lives
 * on `chunk.code`, not here — see `hydrateRunError`.
 */
export function extractRunErrorMessage(chunk: StreamChunk): string {
  if (chunk.type !== "RUN_ERROR") return "";
  const record = chunk as { message?: string; error?: { message?: string } | Error | string };
  if (typeof record.error === "string") return record.error;
  if (record.error instanceof Error) return record.error.message;
  return record.message ?? record.error?.message ?? "Unknown error";
}
