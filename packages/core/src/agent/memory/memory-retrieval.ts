/**
 * Memory Retrieval - Intelligent on-demand memory loading.
 *
 * Each user turn, this module selects the most relevant memories using an
 * LLM side-query (with keyword fallback) and returns their full content
 * for injection into the agent's context.
 *
 * Design follows Claude Code's `findRelevantMemories` pattern:
 * 1. Scan — list all memory files (frontmatter only)
 * 2. Filter — exclude memories already surfaced this session
 * 3. Select — LLM side-query picks top 5 by name+description
 * 4. Load — read full body of selected memories (with budget caps)
 * 5. Format — produce injectable text for system prompt
 *
 * @example
 * ```typescript
 * const relevant = await findRelevantMemories("How do I indent?", manager, model);
 * const injected = formatRelevantMemories(relevant);
 * // injected string goes into buildSystemPrompt()
 * ```
 */

import { z } from "zod";

import { getEnv, type ResolvedCoreEnv } from "../../env";
import { truncateToUtf8Bytes } from "../../utils/bytes.js";
import { splitDisplayLines } from "../../utils/display-lines.js";
import { errorMessage } from "../../utils/errors.js";
import { formatSectionTag } from "../turn-context/turn-context-message.js";

import {
  DEFAULT_MAX_MEMORY_BYTES_PER_FILE,
  DEFAULT_MAX_MEMORY_LINES_PER_FILE,
  DEFAULT_MAX_RELEVANT_MEMORIES,
  DEFAULT_MAX_SESSION_MEMORY_BYTES,
} from "./types.js";

import type { MemoryManager } from "./memory-manager.js";
import type { Memory, MemoryCompletion, MemoryLog } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface RelevantMemory {
  filename: string;
  name: string;
  type: string;
  description: string;
  content: string;
}

export interface FindRelevantMemoriesOptions {
  maxItems?: number;
  maxBytesPerFile?: number;
  maxLinesPerFile?: number;
  maxSessionBytes?: number;
}

// ============================================================================
// Constants
// ============================================================================

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful \
to an AI coding agent as it processes a user's query. \
Select memories you are CERTAIN will be relevant to the query — when in doubt, do not select.

Rules:
- Select at most 5 memories
- Only select memories whose description clearly relates to the query
- Prefer memories with a higher importance score (shown as [imp:N]) when relevance is comparable
- If none are relevant, return an empty list`;

/**
 * Unwrap the single-key wrapper some providers emit around the selection object.
 *
 * Measured against the configured Anthropic-style endpoint (forced-tool
 * `structured_output`): the model intermittently returns
 * `{"selected_memories":{"selected_memories":[...]}}` instead of
 * `{"selected_memories":[...]}` — 2 of 4 sampled calls. The nesting is present in
 * the provider's `tool_use.input` itself, so nothing in our parsing produced it, and
 * the request we send is correct (`input_schema` carries the array-typed field, and
 * the renderer output is unchanged by this transform). It is a model quirk on that
 * provider, not a prompt defect: describing the array element did not stop it.
 *
 * **Narrow on purpose.** Only a single-key object whose value is itself an object
 * that already contains that same key is unwrapped. Every other shape stays as it
 * was, so the transform cannot silently reinterpret a genuine response:
 *
 * | Input | Result |
 * |---|---|
 * | `{"selected_memories":[...]}` | accepted (untouched) |
 * | `{"selected_memories":{"selected_memories":[...]}}` | unwrapped, accepted |
 * | `{"result":{"selected_memories":[...]}}` | rejected (key differs) |
 * | `{"selected_memories":{...},"extra":1}` | rejected (more than one key) |
 * | triple nesting | rejected (one level only) |
 *
 * This is a schema **transform**, not a text repair: the value is passed through
 * unchanged when it does not match, and the schema still decides what is valid. The
 * text-mode path's "a document may be located, but never repaired" rule applies to
 * editing the reply's text to make it parseable, which this does not do.
 */
function unwrapSingleKeyWrapper(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;

  const keys = Object.keys(value);
  if (keys.length !== 1) return value;

  const key = keys[0];
  const nested = (value as Record<string, unknown>)[key];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return value;

  // The wrapper is only redundant when the inner object already carries the key we
  // are about to read — otherwise the "wrapper" is the actual payload.
  return key in nested ? nested : value;
}

/**
 * The object the selector must produce, before the wrapper tolerance is applied.
 * Kept as its own binding so the preprocessed schema can declare the same output
 * type — `z.preprocess` widens its output to `unknown`, which would otherwise leak
 * into `selected_memories` at the call site.
 */
const SELECTION_RESULT = z
  .object({
    selected_memories: z
      .array(z.string())
      .describe("filenames (or bare names) of the memories judged relevant; empty when none are"),
  })
  .describe("the memory selection result");

/**
 * The selection contract, enforced by the port rather than by prompt wording.
 *
 * `resolveSelectedMemoryFilename` already drops filenames it cannot match, so
 * the schema guarantees only "an array of strings" and leaves the manifest
 * lookup where it is.
 *
 * The `preprocess` stage exists only to absorb the provider's double-nesting quirk
 * (see {@link unwrapSingleKeyWrapper}); `renderSchemaContract` reads the wrapped
 * schema's properties, so the text-mode contract is identical with or without it —
 * verified against the live provider and pinned by validate-memory-llm-contract.
 *
 * The assertion only restores the output type `z.preprocess` widens to `unknown`
 * (zod's `ZodPreprocess` does not thread the inner schema's type). The runtime value
 * is the pipe itself, so nothing about `~standard` — and therefore nothing about what
 * the provider is sent — changes.
 */
const SELECTION_SCHEMA = z.preprocess(unwrapSingleKeyWrapper, SELECTION_RESULT) as unknown as typeof SELECTION_RESULT;

// ============================================================================
// Manifest Formatting
// ============================================================================

/**
 * Format a memory catalog for the LLM selector.
 * Each line: `[type] filename (timestamp) [importance]: description`
 */
function formatManifest(memories: Memory[]): string {
  return memories
    .map((m) => {
      const ts = m.updatedAt ?? m.createdAt ?? "";
      const tsLabel = ts ? ` (${ts})` : "";
      const imp = typeof m.importance === "number" ? ` [imp:${m.importance}]` : "";
      return `[${m.type}] ${m.filename}${tsLabel}${imp}: ${m.description}`;
    })
    .join("\n");
}

// ============================================================================
// Expiry Filtering
// ============================================================================

/**
 * Filter out memories whose `expiresAt` is in the past or unparseable.
 * Memories without an expiry are always kept.
 */
function filterExpired(memories: Memory[], log?: MemoryLog): Memory[] {
  const now = Date.now();
  const live: Memory[] = [];
  let expired = 0;
  for (const m of memories) {
    if (m.expiresAt) {
      const t = Date.parse(m.expiresAt);
      if (Number.isNaN(t) || t <= now) {
        expired++;
        continue;
      }
    }
    live.push(m);
  }
  if (expired > 0) {
    log?.info(`Filtered ${expired} expired memories from retrieval`);
  }
  return live;
}

// ============================================================================
// Content Budget Enforcement
// ============================================================================

/**
 * Truncate memory body to per-file budget (lines and bytes).
 */
function truncateBody(
  body: string,
  maxLines: number = DEFAULT_MAX_MEMORY_LINES_PER_FILE,
  maxBytes: number = DEFAULT_MAX_MEMORY_BYTES_PER_FILE,
  env?: ResolvedCoreEnv
): string {
  const byteLength = (value: string) => (env ?? getEnv()).byteLength(value, "utf-8");

  // Raw line count: CRLF is not folded and a final newline keeps its trailing empty segment,
  // matching the previous `split("\n")` exactly.
  const lines = splitDisplayLines(body, { normalizeCrlf: false, dropTrailingEmpty: false });
  const lineCapped =
    lines.length > maxLines ? lines.slice(0, maxLines).join("\n") + "\n[truncated: exceeded line limit]" : body;

  if (byteLength(lineCapped) <= maxBytes) return lineCapped;

  // Reserve ~30 bytes for the trailing byte-limit notice inside the budget.
  return truncateToUtf8Bytes(lineCapped, maxBytes - 30, { byteLength }).text + "\n[truncated: exceeded byte limit]";
}

// ============================================================================
// LLM Selection
// ============================================================================

/**
 * Use a lightweight LLM call to select relevant memories from the manifest.
 *
 * Uses the injected one-shot completion (`ctx.llm`) for the selection call.
 */
async function selectWithLLM(query: string, manifest: string, complete: MemoryCompletion): Promise<string[]> {
  // A schema failure rejects out of here; the caller turns it into the keyword fallback, the same
  // path a transport failure takes. `ctx.llm` owns usage attribution and the `side-query` log row.
  const data = (await complete({
    system: SELECT_MEMORIES_SYSTEM_PROMPT,
    prompt: `Query: ${query}\n\nAvailable memories:\n${manifest}`,
    maxOutputTokens: 256,
    schema: SELECTION_SCHEMA,
  })) as { selected_memories: string[] };

  return data.selected_memories;
}

// ============================================================================
// Keyword Fallback
// ============================================================================

/**
 * Simple keyword matching fallback when LLM selection fails.
 * Scores each memory by how many query words appear in name + description.
 */
function selectWithKeywords(query: string, memories: Memory[], maxItems: number): string[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (words.length === 0) return [];

  const scored = memories.map((m) => {
    const text = `${m.name} ${m.description} ${m.type}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (text.includes(word)) score++;
    }
    return { filename: m.filename, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems)
    .map((s) => s.filename);
}

/**
 * Map an LLM-selected name to a real memory filename.
 * Accepts exact filename, missing `.md`, or bare `name` matching frontmatter.
 */
export function resolveSelectedMemoryFilename(
  selected: string,
  candidateMap: Map<string, Memory>,
  candidates: Memory[]
): Memory | undefined {
  const trimmed = selected.trim();
  if (!trimmed) return undefined;

  const direct = candidateMap.get(trimmed);
  if (direct) return direct;

  const withMd = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  const byFilename = candidateMap.get(withMd);
  if (byFilename) return byFilename;

  const lower = trimmed.toLowerCase();
  const lowerMd = withMd.toLowerCase();
  const base = trimmed.replace(/\.md$/i, "").toLowerCase();

  return candidates.find((m) => {
    const filenameLower = m.filename.toLowerCase();
    return (
      filenameLower === lower ||
      filenameLower === lowerMd ||
      m.name.toLowerCase() === base ||
      filenameLower.replace(/\.md$/i, "") === base
    );
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Find and load memories relevant to the current query.
 *
 * 1. Lists all memories from MemoryManager
 * 2. Filters out `alreadySurfaced` filenames
 * 3. Runs a structured completion to select top N (with keyword fallback)
 * 4. Loads full body of selected memories (with per-file and session budget caps)
 *
 * @param query - The user's current query/message
 * @param memoryManager - MemoryManager instance for listing/reading
 * @param complete - Structured one-shot completion (null = keyword only). The extension passes
 *   its `ctx.llm` port, so usage, the prompt-cache/model connection and abort handling stay host-side.
 * @param alreadySurfaced - Set of filenames already shown this session
 * @param options - Budget and limit overrides
 * @param env - Runtime env for byte accounting (defaults to the ambient registry)
 * @returns Array of relevant memories with truncated full content
 */
export async function findRelevantMemories(
  query: string,
  memoryManager: MemoryManager,
  complete: MemoryCompletion | null,
  alreadySurfaced: ReadonlySet<string> = new Set(),
  options: FindRelevantMemoriesOptions = {},
  env?: ResolvedCoreEnv,
  log?: MemoryLog
): Promise<RelevantMemory[]> {
  const resolvedEnv = env ?? getEnv();
  const {
    maxItems = DEFAULT_MAX_RELEVANT_MEMORIES,
    maxBytesPerFile = DEFAULT_MAX_MEMORY_BYTES_PER_FILE,
    maxLinesPerFile = DEFAULT_MAX_MEMORY_LINES_PER_FILE,
    maxSessionBytes = DEFAULT_MAX_SESSION_MEMORY_BYTES,
  } = options;

  const allMemories = await memoryManager.listMemories();

  // Drop expired memories (expiresAt in the past) before any selection work.
  const live = filterExpired(allMemories, log);

  // Pre-filter already-surfaced before LLM call (don't waste slots on repeats)
  const candidates = live.filter((m) => !alreadySurfaced.has(m.filename));
  if (candidates.length === 0) {
    return [];
  }

  const manifest = formatManifest(candidates);

  // Select relevant filenames — LLM with keyword fallback on throw or empty result
  let selectedFilenames: string[];
  let selectionMethod: "llm" | "keyword" | "keyword-fallback" = "keyword";
  if (complete) {
    try {
      selectedFilenames = await selectWithLLM(query, manifest, complete);
      selectionMethod = "llm";
      if (selectedFilenames.length === 0) {
        selectedFilenames = selectWithKeywords(query, candidates, maxItems);
        if (selectedFilenames.length > 0) {
          selectionMethod = "keyword-fallback";
        }
      }
    } catch (err) {
      // The port has already recorded the reason under `side-query`; this entry
      // records only the decision made here, so one failure is not filed twice.
      const reason = errorMessage(err);
      log?.info(`Fell back to keyword memory selection (${reason})`);
      selectedFilenames = selectWithKeywords(query, candidates, maxItems);
      selectionMethod = "keyword-fallback";
    }
  } else {
    selectedFilenames = selectWithKeywords(query, candidates, maxItems);
  }

  if (selectedFilenames.length === 0) {
    return [];
  }

  // Resolve filenames → Memory objects (normalize LLM naming quirks)
  const candidateMap = new Map(candidates.map((m) => [m.filename, m]));
  let resolved: Memory[] = [];
  for (const filename of selectedFilenames.slice(0, maxItems)) {
    const mem = resolveSelectedMemoryFilename(filename, candidateMap, candidates);
    if (!mem) {
      log?.warn(`Selected filename "${filename}" not found in candidate map`);
      continue;
    }
    if (resolved.some((m) => m.filename === mem.filename)) continue;
    resolved.push(mem);
  }

  // Non-empty but unresolvable LLM picks used to skip keyword fallback — fix that.
  if (resolved.length === 0 && selectionMethod === "llm" && selectedFilenames.length > 0) {
    const fallback = selectWithKeywords(query, candidates, maxItems);
    if (fallback.length > 0) {
      selectionMethod = "keyword-fallback";
      resolved = [];
      for (const filename of fallback) {
        const mem = candidateMap.get(filename);
        if (mem) resolved.push(mem);
      }
    }
  }

  const results: RelevantMemory[] = [];
  let totalBytes = 0;

  for (const mem of resolved) {
    const content = truncateBody(mem.body, maxLinesPerFile, maxBytesPerFile, resolvedEnv);
    const contentBytes = resolvedEnv.byteLength(content, "utf-8");

    // Enforce session-level budget
    if (totalBytes + contentBytes > maxSessionBytes) {
      break;
    }
    totalBytes += contentBytes;

    results.push({
      filename: mem.filename,
      name: mem.name,
      type: mem.type,
      description: mem.description,
      content,
    });
  }

  const names = results.map((r) => r.filename).join(", ");
  log?.info(
    `Loaded ${results.length} relevant memories (${totalBytes} bytes, method: ${selectionMethod})${names ? `: ${names}` : ""}`
  );

  return results;
}

// ============================================================================
// Formatting for Injection
// ============================================================================

/** Inner tag for the selected-memory block (the extension's section carries the `<ctx kind>`). */
const MEMORY_SELECTION_TAG = "relevant_memories";

/**
 * Format relevant memories into injectable text.
 *
 * Uses XML tags (`<relevant_memories>`, `<memory>`) to provide unambiguous boundaries so markdown
 * content inside memories (headings, code fences, `---` separators) doesn't bleed into the
 * surrounding context. The outer `<ctx kind=...>` tag belongs to the extension section, not here.
 *
 * Returns empty string if no memories are provided.
 */
export function formatRelevantMemories(memories: RelevantMemory[]): string {
  if (memories.length === 0) return "";

  const parts = memories.map(
    (m) =>
      `<memory name="${m.name.replace(/"/g, "&quot;")}" type="${m.type}">\n${m.description}\n\n${m.content}\n</memory>`
  );

  return formatSectionTag(MEMORY_SELECTION_TAG, [
    "The following memories were selected as relevant to the current conversation.",
    "Apply any user preferences, project facts, or conventions described below.",
    "",
    parts.join("\n\n"),
  ]);
}
