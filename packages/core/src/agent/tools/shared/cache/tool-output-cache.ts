/**
 * Tool Output Cache — saves large tool results to disk and returns a preview.
 *
 * When a tool result exceeds the cache threshold, the full output is written
 * to `.agents/cache/tool-output/{id}.txt` and a preview (head + tail) is returned
 * to the LLM with instructions to use `read_file` for the full content.
 *
 * ## Two cleanup paths (they are complements, not alternatives)
 *
 * 1. **Compaction — reference-based, optimistic.** When the conversation is
 *    compacted (auto or reactive), messages before the compact index are shadowed,
 *    so the LLM will never see them again and their files become collectable.
 *    `cleanupOrphanedToolCache()` deletes those. It only *can* fire for sessions
 *    that actually compact, and only for files that session's wire referenced —
 *    a file no session references is never in its candidate set. A referenced path
 *    must also live under {@link TOOL_OUTPUT_CACHE_DIR}: the collection key is the
 *    `cachedOutputPath` FIELD, which background job results use for their durable
 *    log, so containment — not the field name — decides what this pass may delete.
 * 2. **Age-based — unconditional backstop.** `sweepStaleToolOutput()` deletes any
 *    cache file older than {@link TOOL_OUTPUT_MAX_AGE_MS}, regardless of
 *    references. Without it, every session that never compacted (and every file
 *    no session ever referenced) leaks forever: the reference-based path has no
 *    global scan. It runs lazily on the first cache write of a process, mirroring
 *    `sweepStaleJobLogs` for background job logs.
 *
 * Both are non-fatal by contract: a failed delete never fails the tool call.
 */

import { AGENT_CACHE_DIR } from "../../../../utils/workspace-paths.js";

import { createStaleFileSweeper } from "./stale-sweep.js";

import type { StaleSweepOptions } from "./stale-sweep.js";
import type { ResolvedCoreEnv } from "../../../../env";
import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Constants
// ============================================================================

/** Cache directory holding one file per spilled tool result (workspace-relative). */
export const TOOL_OUTPUT_CACHE_DIR = `${AGENT_CACHE_DIR}/tool-output`;

/**
 * Only `.txt` entries are swept. Background job logs live in a sibling directory
 * and use `.log`, so a future merge of the two directories cannot let this sweep
 * eat a live job log.
 */
const CACHE_ENTRY_SUFFIX = ".txt";

/** Content length threshold to trigger disk caching (~2.5k tokens) */
export const CACHE_THRESHOLD = 10000;

/**
 * Per-process suffix for spill file names.
 *
 * The name used to be `<toolCallId>` alone. Provider tool ids are scoped to a REQUEST (`call_0` is
 * the common shape), so two sessions could write the same file — the later one silently overwrote
 * the earlier one's spill, and `cleanupOrphanedToolCache` could then delete a file another session
 * still referenced through its `cachedOutputPath`. The id stays in the name (readable, and it is the
 * key the reference collector matches), the suffix only makes the write unique. A re-run of the same
 * call leaves the previous file to the age sweep instead of clobbering it.
 */
let cacheFileSeq = 0;
const cacheProcessToken = Date.now().toString(36);

function uniqueCacheEntryName(id: string): string {
  cacheFileSeq += 1;
  return `${id}-${cacheProcessToken}${cacheFileSeq.toString(36)}`;
}

/** Number of lines to show from the start of the output */
const DEFAULT_HEAD_LINES = 200;

/** Number of lines to show from the end of the output */
const DEFAULT_TAIL_LINES = 50;

/** Number of chars to show from the start when content has few (but very long) lines */
const DEFAULT_HEAD_CHARS = 5000;

/** Number of chars to show from the end when content has few (but very long) lines */
const DEFAULT_TAIL_CHARS = 2000;

/** Spill files older than this are swept on the first cache write of a process. */
export const TOOL_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// Public API
// ============================================================================

/**
 * Write full tool output to disk and return the cache file path.
 *
 * Sweeps before writing so the stale-file pass cannot observe its own output
 * (a freshly written file is never a candidate anyway — the filter is age-based).
 */
export async function cacheToolOutput(env: ResolvedCoreEnv, content: string, id: string): Promise<string> {
  await sweepStaleToolOutput(env);
  const filePath = `${TOOL_OUTPUT_CACHE_DIR}/${uniqueCacheEntryName(id)}${CACHE_ENTRY_SUFFIX}`;
  await env.fs.writeFile(filePath, content);
  return filePath;
}

/**
 * The line telling the model where the rest of the output is, and whether it is all of it.
 */
function noteLine(
  cachedPath: string,
  totalLines: number,
  chars: number,
  truncated: boolean,
  pageOnly: boolean
): string {
  const size = `${totalLines} lines, ${chars} chars`;
  if (truncated) {
    return `Output saved to: ${cachedPath} (${size} — this run kept only its tail, so earlier output is gone)`;
  }
  return pageOnly
    ? `Output for this page saved to: ${cachedPath} (${size})`
    : `Full output saved to: ${cachedPath} (${size})`;
}

/**
 * Build a preview string from large content with a reference to the cached file.
 */
export function buildCachedPreview(
  content: string,
  cachedPath: string,
  /**
   * `truncated` says the CALLER's content is already a bounded view (the command's own accumulator kept
   * only a tail, which is all a cancelled or timed-out run can offer) — so the note must not promise a
   * full copy the file does not hold.
   */
  opts?: { headLines?: number; tailLines?: number; truncated?: boolean; pageOnly?: boolean }
): string {
  const headLines = opts?.headLines ?? DEFAULT_HEAD_LINES;
  const tailLines = opts?.tailLines ?? DEFAULT_TAIL_LINES;

  const lines = content.split("\n");
  const totalLines = lines.length;

  // Not large enough to benefit from truncation
  if (content.length <= CACHE_THRESHOLD) {
    return content;
  }

  // Line-based truncation — show first N and last N lines
  if (totalLines > headLines + tailLines) {
    const head = lines.slice(0, headLines).join("\n");
    const tail = lines.slice(-tailLines).join("\n");
    const omitted = totalLines - headLines - tailLines;

    return [
      head,
      "",
      `... (${omitted} lines omitted) ...`,
      "",
      tail,
      "",
      noteLine(cachedPath, totalLines, content.length, opts?.truncated === true, opts?.pageOnly === true),
      `Use read_file with path="${cachedPath}" and offset/limit to read specific sections.`,
    ].join("\n");
  }

  // Char-based truncation — for content with few lines but very long lines
  // (e.g., a single 2MB minified JSON line). Show a FIXED-SIZE head + tail by
  // char count. Previously this took content.length / 2 as the head, which for
  // multi-MB single-line content produced a multi-hundred-KB "preview" that
  // defeated the purpose of caching. A fixed small preview keeps the tool
  // result compact regardless of the original size.
  const head = content.slice(0, DEFAULT_HEAD_CHARS);
  const tail = content.slice(Math.max(DEFAULT_HEAD_CHARS, content.length - DEFAULT_TAIL_CHARS));
  const omitted = content.length - DEFAULT_HEAD_CHARS - DEFAULT_TAIL_CHARS;
  const note = noteLine(cachedPath, totalLines, content.length, opts?.truncated === true, opts?.pageOnly === true);

  if (omitted > 0) {
    return [
      head,
      "",
      `... (${omitted} chars omitted) ...`,
      "",
      tail,
      "",
      note,
      `Use read_file with path="${cachedPath}" and offset/limit to read specific sections.`,
    ].join("\n");
  }

  // Content fits in head+tail with no omission — still show cache hint
  return [
    content,
    "",
    note,
    `Use read_file with path="${cachedPath}" and offset/limit to read specific sections.`,
  ].join("\n");
}

/**
 * Check if content should be cached to disk.
 */
export function shouldCache(content: string): boolean {
  return content.length > CACHE_THRESHOLD;
}

/**
 * Cache content if it exceeds the threshold, returning either the original
 * content or a preview with cache path. Also returns the cache path if cached.
 */
export async function maybeCacheOutput(
  env: ResolvedCoreEnv,
  content: string,
  id: string,
  opts?: { headLines?: number; tailLines?: number; truncated?: boolean; pageOnly?: boolean }
): Promise<{ content: string; cachedOutputPath: string | null }> {
  if (!shouldCache(content)) {
    return { content, cachedOutputPath: null };
  }

  const cachedPath = await cacheToolOutput(env, content, id);
  const preview = buildCachedPreview(content, cachedPath, opts);
  return { content: preview, cachedOutputPath: cachedPath };
}

/**
 * A reference is collectable only when it points INSIDE the tool-output cache.
 *
 * The walker matches on the field NAME (`cachedOutputPath`), and background command results use
 * that same field for their durable job log (`.agents/cache/command-jobs/<id>.log`). Matching the
 * name alone meant a compaction deleted a finished job's log — that reference was never a cache
 * reference, and the job's later appends recreated a file with no header and no history. The
 * suffix check mirrors {@link toolOutputSweeper}, so both cleanup paths agree on what is
 * collectable.
 */
function isToolOutputCachePath(path: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  return normalized.startsWith(`${TOOL_OUTPUT_CACHE_DIR}/`) && normalized.endsWith(CACHE_ENTRY_SUFFIX);
}

/**
 * Walk a tool message's `content` for every spill path it references.
 *
 * A model tool message's `content` is a JSON **string** or an array of **text** parts
 * (`{ type: "text", content: "<json>" }`) — it is not a UI `tool-result` part. The previous
 * reader looked for `part.type === "tool-result"` (a UI-only shape) and skipped strings, so the
 * reference collector deleted nothing on the real wire. This walks every shape and recurses into
 * a part's `content` (and a tool-result part's `content` for callers that pass UI parts).
 *
 * It collects ALL references, not the first: a command writes stdout and stderr to separate files,
 * and returning the first one left the other uncollectable until the age sweep.
 */
function collectCachedPathsFromValue(value: unknown, paths: Set<string>, depth = 0): void {
  if (depth > 4) return;
  if (typeof value === "string") {
    try {
      collectCachedPathsFromValue(JSON.parse(value), paths, depth + 1);
    } catch {
      // Not JSON — a plain-text preview carries no reference this walker can trust.
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCachedPathsFromValue(item, paths, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const path = record.cachedOutputPath;
    if (typeof path === "string" && path.length > 0) paths.add(path);
    // A command caches stdout and stderr separately; `cachedOutputPath` names only one of them.
    const many = record.cachedOutputPaths;
    if (Array.isArray(many)) {
      for (const entry of many) {
        if (typeof entry === "string" && entry.length > 0) paths.add(entry);
      }
    }
    // Content parts keep their payload under `content`; recurse so `{type:"text", content}` and
    // a UI `tool-result` part are both covered.
    if (record.content !== undefined && record.content !== value) {
      collectCachedPathsFromValue(record.content, paths, depth + 1);
    }
  }
}

/**
 * Scan orphaned messages (those before compactIndex) for cached tool output
 * file paths and delete them from disk.
 */
export async function cleanupOrphanedToolCache(
  env: ResolvedCoreEnv,
  messages: ModelMessage[],
  compactIndex: number
): Promise<void> {
  if (compactIndex <= 0 || messages.length === 0) return;

  const pathsToDelete = new Set<string>();

  for (let i = 0; i < Math.min(compactIndex, messages.length); i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;

    // `msg.content` is a JSON string or an array of text parts on the model wire; the walker
    // handles both (and a UI tool-result part, for callers that pass those).
    const found = new Set<string>();
    collectCachedPathsFromValue(msg.content, found);
    // Only cache-owned files: the field name is shared with background job logs.
    for (const path of found) {
      if (isToolOutputCachePath(path)) pathsToDelete.add(path);
    }
  }

  if (pathsToDelete.size === 0) return;

  const fs = env.fs;
  const deletions = Array.from(pathsToDelete).map(async (filePath) => {
    try {
      const exists = await fs.exists(filePath);
      if (exists) {
        await fs.remove(filePath);
      }
    } catch {
      // Non-fatal — stale cache files are harmless
    }
  });

  await Promise.all(deletions);
}

// ============================================================================
// Stale sweep
// ============================================================================

/**
 * Delete cache files older than {@link TOOL_OUTPUT_MAX_AGE_MS}, which no live
 * surface can still be reading. Runs at most once per process unless forced.
 *
 * Age-based on purpose: the reference-based compaction pass can only collect
 * files a *compacting* session referenced, so anything else (a session that never
 * compacted, a file no session ever referenced) would otherwise accumulate
 * forever. Symmetric to `sweepStaleJobLogs` for background job logs — same
 * laziness, same silent degradation, same shared walker.
 */
const toolOutputSweeper = createStaleFileSweeper({
  dir: TOOL_OUTPUT_CACHE_DIR,
  suffix: CACHE_ENTRY_SUFFIX,
  maxAgeMs: TOOL_OUTPUT_MAX_AGE_MS,
});

export function sweepStaleToolOutput(env: ResolvedCoreEnv, options?: StaleSweepOptions): Promise<number> {
  return toolOutputSweeper.sweep(env, options);
}

/** Test-only escape hatch for the once-per-process guard. */
export function resetToolOutputSweepForTesting(): void {
  toolOutputSweeper.reset();
}
