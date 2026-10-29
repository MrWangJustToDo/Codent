/**
 * Model-facing shaping for `execute_typescript` results.
 *
 * Code-mode exposes a curated subset of tools as `external_*` sandbox bindings. Those bindings
 * call the tool's raw `execute`, NOT its `toModelOutput` projection, so a media-returning tool
 * (`read_file` on an image/PDF) hands the sandbox the raw `{ type: "image", base64, … }` object.
 * A script that returns it then reaches the wire as `{ success, result: { …base64… } }`, and
 * `execute_typescript` registered no projection of its own — `applyToolCompact` skips a tool with
 * no handler and the base64 lands in the prompt as plain text. The model cannot "see" it, and
 * every turn re-sends the payload.
 *
 * This lifts those media entries back into `ContentPart[]` through `read_file`'s own
 * {@link describeReadFileMedia}, so the two paths cannot describe the same file differently.
 * Everything else keeps the persisted JSON text unchanged, so an ordinary script result is not
 * reshaped.
 *
 * Scope: `applyToolCompact` is skipped for subagents (`tool-compact-middleware`), so a subagent's
 * `execute_typescript` media still reaches the wire as text — the same pre-existing limit `read_file`
 * has on that path, not something this projection can reach.
 */

import { isContentPartArray } from "@tanstack/ai";

import { isRecord } from "../../utils/is-record.js";
import { defaultMimeForPartType } from "../media/types.js";
import { describeReadFileMedia } from "../tools/builtin/fs/read/format-result.js";
import { isProjectedModelContent } from "../tools/runtime/projected-model-content.js";

import type { MediaRenderInput } from "../tools/builtin/fs/read/format-result.js";
import type { ModelToolContent } from "../tools/runtime/contract.js";
import type { ContentPart } from "@tanstack/ai";
import type { ExecuteTypescriptOutput } from "@tanstack/ai-code-mode";

// ============================================================================
// Types
// ============================================================================

/** The raw `read_file` media output a sandbox binding can hand back. */
interface MediaOutput {
  type: "image" | "pdf";
  base64: string;
  mimeType?: string;
  path?: string;
  size?: number;
  extractedText?: string;
  pageCount?: number;
}

/**
 * Cap how many media parts one call may lift, so a script cannot flood the context.
 *
 * Governs media THIS module synthesizes; a binding that already returns `ContentPart[]` passes its
 * own parts through uncapped (they are not ours to drop).
 */
const MAX_LIFTED_MEDIA_PARTS = 16;

// ============================================================================
// Detection
// ============================================================================

function isMediaOutput(value: unknown): value is MediaOutput {
  if (!isRecord(value)) return false;
  return (
    (value.type === "image" || value.type === "pdf") && typeof value.base64 === "string" && value.base64.length > 0
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ============================================================================
// Rendering
// ============================================================================

/**
 * Normalise a loose sandbox media object into the shape `read_file`'s renderer takes.
 *
 * A binding hands back `read_file`'s output, but through the isolate the optional fields may be
 * absent (`JSON` round-trip, a script that built the object itself), so the defaults live here
 * rather than in the shared renderer.
 */
function toMediaRenderInput(media: MediaOutput): MediaRenderInput {
  return {
    type: media.type,
    path: readString(media.path) ?? "(unknown path)",
    base64: media.base64,
    ...(typeof media.size === "number" ? { size: media.size } : {}),
    ...(media.type === "image"
      ? { mimeType: readString(media.mimeType) ?? defaultMimeForPartType("image") }
      : {
          ...(media.extractedText !== undefined ? { extractedText: media.extractedText } : {}),
          ...(typeof media.pageCount === "number" ? { pageCount: media.pageCount } : {}),
        }),
  };
}

/** Render a non-media entry as text, keeping the persisted JSON shape for it. */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function collectLogs(logs: unknown): string[] {
  if (!Array.isArray(logs)) return [];
  return logs.filter((line): line is string => typeof line === "string" && line.length > 0);
}

function liftMedia(result: unknown, logs: unknown): ContentPart[] | null {
  // A binding may already return ContentPart[] (e.g. an MCP multimodal result); keep it as is.
  if (isContentPartArray(result)) {
    const withLogs = collectLogs(logs);
    return withLogs.length > 0 ? [{ type: "text", content: `Logs:\n${withLogs.join("\n")}` }, ...result] : result;
  }

  const entries = Array.isArray(result) ? result : [result];
  const media = entries.filter(isMediaOutput);
  if (media.length === 0) return null;

  const lines: string[] = [];
  const parts: ContentPart[] = [];
  let described = 0;
  for (const entry of entries) {
    if (isMediaOutput(entry)) {
      const { line, part } = describeReadFileMedia(toMediaRenderInput(entry));
      lines.push(line);
      described += 1;
      if (parts.length < MAX_LIFTED_MEDIA_PARTS) parts.push(part);
      continue;
    }
    // Non-media entries keep their JSON text; media entries are the only ones carrying base64.
    lines.push(stringify(entry));
  }

  // Say so when the cap bit: the lines above describe every file, so silently attaching fewer
  // would leave the model counting attachments that are not there.
  const omitted = described - parts.length;
  if (omitted > 0) {
    lines.push(
      `[${omitted} media attachment${omitted === 1 ? "" : "s"} omitted: at most ${MAX_LIFTED_MEDIA_PARTS} are attached per call]`
    );
  }

  const withLogs = collectLogs(logs);
  if (withLogs.length > 0) lines.push(`Logs:\n${withLogs.join("\n")}`);

  return [{ type: "text", content: lines.filter((line) => line.length > 0).join("\n\n") }, ...parts];
}

// ============================================================================
// Projection
// ============================================================================

/**
 * `toModelOutput` for `execute_typescript`: lift media a script returned from an `external_*`
 * binding into multimodal parts, leaving every other result as its persisted JSON text.
 *
 * Idempotent: a re-projection of content this function already produced is a no-op (see
 * {@link isProjectedModelContent}).
 */
export function projectCodeModeModelOutput(output: unknown): ModelToolContent {
  if (isProjectedModelContent(output)) return output;

  const envelope = isRecord(output) ? (output as ExecuteTypescriptOutput) : undefined;
  // A failed or malformed run has nothing to lift; keep the existing JSON text.
  if (!envelope || envelope.success === false) return stringify(output);

  const parts = liftMedia(envelope.result, envelope.logs);
  return parts ?? stringify(output);
}
