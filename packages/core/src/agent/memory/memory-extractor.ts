/**
 * Memory Extractor - Background extraction and consolidation of memories.
 *
 * After each agent turn, this module analyzes recent conversation messages
 * and extracts new memories (user preferences, project facts, feedback).
 *
 * Both operations are one-shot structured queries against a Zod contract:
 * the schema is sent as the provider's output schema and validates the reply,
 * so a text-shaped response can never be mistaken for a valid one and no
 * pattern-matching recovery is needed.
 *
 * @example
 * ```typescript
 * const count = await extractMemories(messages, memoryManager, textAdapter, log, undefined, usage);
 * // Returns number of newly extracted memories
 *
 * await consolidateMemories(memoryManager, textAdapter, log, usage);
 * // Merges/deduplicates when threshold exceeded
 * ```
 */

import { z } from "zod";

import { runSideTextQuery } from "../../models/adapter/side-text-query.js";
import { extractTextFromContent } from "../compaction/message-utils.js";

import { isExpiredMemory } from "./memory-expiry.js";
import { DEFAULT_HARD_MAX_MEMORIES, memoryTypeSchema } from "./types.js";

import type { MemoryManager } from "./memory-manager.js";
import type { Memory } from "./types.js";
import type { TextAdapterConfig } from "../../models/adapter/adapter-factory.js";
import type { UsageTracker } from "../../runtime-types/hosts.js";
import type { AgentLog } from "../agent-log/agent-log.js";
import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Constants
// ============================================================================

/** Max output tokens for the extraction query (compact JSON array). */
const MEMORY_EXTRACT_MAX_TOKENS = 2000;

/** Max output tokens for the consolidation query (merge/delete JSON). */
const MEMORY_CONSOLIDATE_MAX_TOKENS = 4000;

/**
 * Upper bound on accepted extraction entries — a guard against a runaway
 * response, applied after validation rather than by truncating the payload.
 */
const MAX_EXTRACTED_ENTRIES = 20;

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Your role is to identify and extract \
durable knowledge from conversation transcripts that should be remembered across sessions.

Reply with a JSON **object** containing a single key "memories", whose value is the array of \
extracted entries. No prose, no markdown code fences, no other top-level keys.

Each entry in "memories" MUST contain exactly these fields, and MUST NOT add others:
  - "name": short kebab-case identifier (e.g. "user-preference-tabs")
  - "type": one of ${memoryTypeSchema.options.join(", ")}
  - "description": one-line summary for index lookup
  - "body": full detail in markdown
  - "importance" (optional): number 0–1 rating how valuable this memory is across future
    sessions; omit it for typical entries rather than inventing a value.
  - "expiresAt" (optional): ISO timestamp when this memory stops being relevant; omit for
    durable memories.

You extract (prefer capturing rather than skipping when unsure):
- User preferences (coding style, tool choices, communication preferences)
- User corrections and feedback (things the user corrected or asked you to do differently)
- Project facts (architecture, conventions, dependencies, workflows, tool contracts)
- Decisions and constraints the user stated for this repo or agent behavior
- External references (URLs, docs, tools mentioned)

Rules:
- Extract reusable knowledge that would help a future session — when in doubt, extract a short entry
- Do NOT extract ephemeral one-off task chatter (temporary file paths, one-time debug noise, transient errors)
- Do NOT duplicate information already covered by existing memories (update wording only if clearly new)
- Keep descriptions concise (one line)
- Keep body content focused and specific
- Use kebab-case for names (e.g., "user-prefers-tabs")
- Use an empty "memories" array only when the dialogue truly has nothing durable`;

const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidation assistant. Your role is to merge, \
deduplicate, and clean up a collection of memory entries.

You will receive a lightweight catalog of all memories (filename, name, type, description — NO body).
Your job is to decide which memories to merge, delete, or keep.

Rules:
1. Merge memories that cover the same topic into a single entry. Provide the merged description and body.
2. Delete memories that are outdated, contradicted, or no longer useful.
3. Prefer merging over deleting; keep a healthy set (roughly under 40) without discarding useful project facts.
4. Preserve user preferences and feedback above all else.
5. Keep descriptions concise (one line).
6. Use kebab-case for names.

Field notes:
- Every entry in "merged" MUST contain exactly these fields, and MUST NOT add others:
  - "name": short kebab-case identifier (e.g. "user-preference-tabs")
  - "type": one of ${memoryTypeSchema.options.join(", ")}
  - "description": one-line summary for index lookup
  - "body": full merged detail in markdown
  - "replaces": the source filenames this entry replaces
- "importance" (optional): 0–1 weight for the merged entry; omit to keep default.
- "expiresAt" (optional): ISO expiry; omit unless the merged topic is time-bound.
- "deleted": files to remove outright (outdated/contradicted).
- Files not mentioned in either list are kept as-is.
- If no changes are needed, return empty "merged" and "deleted" lists.
- Reply with the JSON object only — no prose, no markdown code fences.`;

/** Number of recent messages to analyze for extraction */
const EXTRACTION_WINDOW = 30;

/** Maximum characters of dialogue to send for extraction */
const MAX_EXTRACTION_CHARS = 12000;

/** Maximum characters of the lightweight catalog (frontmatter only) sent for consolidation */
const MAX_CONSOLIDATION_CATALOG_CHARS = 20000;

// ============================================================================
// Model contracts
// ============================================================================

/**
 * An importance outside 0–1 is dropped rather than rejected: the value is a
 * hint the model adds voluntarily, and failing the whole entry over it would
 * throw away a perfectly good memory.
 *
 * `.optional()` sits outside the transform so the field stays optional in both
 * the input and the output shape — otherwise the port's input-derived type and
 * the schema's output type disagree on whether the key is required.
 */
const importanceSchema = z
  .number()
  .min(0)
  .max(1)
  .transform((value) => Math.round(value * 100) / 100)
  .optional()
  .catch(undefined);

/**
 * An unparseable expiry is dropped for the same reason as importance. A
 * parseable one is normalized to ISO so the frontmatter writer sees one format.
 */
const expiresAtSchema = z
  .string()
  .transform((value) => {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  })
  .optional()
  .catch(undefined);

/**
 * One extracted memory.
 *
 * `type` is validated against the known set rather than defaulted, so a model
 * that invents a fifth type is rejected instead of silently filed as `user`
 * (the old code substituted `"user"` for anything unrecognized).
 *
 * The `.describe()` strings are not documentation — they are the field contract
 * text mode renders into the prompt (`renderSchemaContract`), so the wording a
 * model sees and the shape the validator enforces come from this one place. The
 * system prompt keeps a hand-written example for readability; the descriptions
 * are what guarantee completeness.
 */
const extractedMemorySchema = z.object({
  name: z.string().min(1).describe('short kebab-case identifier (e.g. "user-prefers-tabs")'),
  type: memoryTypeSchema.describe("memory category — must be one of the listed values"),
  description: z.string().min(1).describe("one-line summary for index lookup"),
  body: z.string().min(1).describe("full detail in markdown"),
  importance: importanceSchema.describe(
    "number 0–1 rating how valuable this memory is across future sessions; omit for typical entries"
  ),
  expiresAt: expiresAtSchema.describe("ISO timestamp when this memory stops being relevant; omit for durable memories"),
});

/**
 * Extraction returns the entries under an object key, **not** as a bare array.
 *
 * The array is the natural shape, and the old schema used it — but a top-level
 * array reaches the provider as `{ type: "object", properties: {} }`, because the
 * structured-output request is built from the schema's `properties` (see
 * `assertObjectRootSchema` in `models/adapter/side-text-query.ts`). The model then
 * invents a wrapper key (`value`, `input`, `entries`, …) and the reply can never
 * match, so extraction returned zero memories on every turn while logging a schema
 * error that read like a flaky model. The key is pinned here and named in the
 * prompt so the two cannot disagree.
 *
 * **Failure is all-or-nothing, deliberately.** One malformed entry rejects the
 * whole response, so the caller writes nothing rather than writing the entries
 * that happened to survive. The trade-off is explicit: the system prompt says
 * "prefer capturing rather than skipping", and a per-entry `.catch` would keep
 * that bias, but it would also mean a model that systematically emits one bad
 * field (say, a `type` it keeps inventing) silently produces *no* memories
 * while looking successful. A visible zero, with the offending path in the log,
 * is the failure mode worth having; entry-level recovery hides a broken
 * contract behind partial results.
 */
const extractionSchema = z.object({
  memories: z.array(extractedMemorySchema).describe("the extracted entries; an empty array means nothing new"),
});

/**
 * A merged memory. `replaces` is required: a merge that does not name its
 * source files leaves the originals on disk, which is worse than not merging —
 * the merged entry and its sources would both be listed.
 */
const mergedMemorySchema = extractedMemorySchema.extend({
  replaces: z.array(z.string()).describe("the source filenames this merged entry replaces"),
});

/**
 * Consolidation decisions: which entries to fold together, which to drop.
 *
 * No `.catch([])` on either collection. A collection-level catch collapses the
 * *entire* list on a single bad entry without throwing, and the caller then
 * runs the deletions anyway — a merge that failed validation would still delete
 * the files it claimed to replace, losing them outright. Rejecting the response
 * keeps `deleted` from being applied on top of a `merged` that never happened.
 *
 * Also note the two failure semantics differ on purpose: consolidation requires a
 * recognizable decision object, while extraction rejects anything whose
 * `memories` entry is malformed. Neither accepts an unrecognized top-level shape
 * as "nothing to do".
 */
const consolidationSchema = z.object({
  merged: z.array(mergedMemorySchema).describe("entries to fold together; empty when nothing needs merging"),
  deleted: z.array(z.string()).describe("filenames to remove outright (outdated or contradicted)"),
});

// ============================================================================
// Conversation Serialization
// ============================================================================

/**
 * Serialize recent messages to plain text for extraction.
 * Same technique as compaction: prevents tool-call contamination.
 */
function serializeForExtraction(messages: ModelMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractTextFromContent(msg.content);
    if (text) parts.push(`${msg.role}: ${text}`);
  }

  return parts.join("\n\n");
}

// ============================================================================
// Memory Extraction
// ============================================================================

type ExtractedMemory = z.infer<typeof extractedMemorySchema>;
type ConsolidationDecisions = z.infer<typeof consolidationSchema>;

/**
 * Extract new memories from recent conversation messages.
 *
 * Runs one structured side query against {@link extractionSchema}; the schema is
 * both the request contract and the response validator, so there is no JSON
 * recovery step and no field-by-field repair afterwards.
 *
 * A failure (transport or schema) yields zero new memories — extraction is
 * opportunistic background work and must never disturb the turn.
 *
 * @param messages - Full conversation messages
 * @param memoryManager - MemoryManager instance for reading existing + writing new
 * @param textAdapter - Text adapter for the extraction query
 * @param log - Optional agent log for failure visibility
 * @param abortSignal - Aborts the query when the triggering turn is cancelled
 * @param usage - Owning agent's tracker, so the extraction query is accounted for. Its
 *   tokens are real spend: without this the call reaches the global usage store but no
 *   session's lifetime totals (`memory-retrieval.selectWithLLM` does the same for the
 *   prefetch selection query).
 * @returns Number of newly extracted memories
 */
export async function extractMemories(
  messages: ModelMessage[],
  memoryManager: MemoryManager,
  textAdapter: TextAdapterConfig,
  log?: AgentLog,
  abortSignal?: AbortSignal,
  usage?: UsageTracker | null
): Promise<number> {
  // Take only recent messages
  const recentMessages = messages.slice(-EXTRACTION_WINDOW);

  const dialogue = serializeForExtraction(recentMessages);
  if (!dialogue.trim()) return 0;

  // Keep the TAIL of the window: extraction exists to capture what the user just said (a
  // correction, a preference, a decision), and the previous `slice(0, …)` kept the OLDEST 12k
  // characters of the 30-message window — silently dropping the turn that triggered extraction.
  const boundedDialogue = dialogue.slice(-MAX_EXTRACTION_CHARS);

  // Get existing memories to avoid duplicates
  const existing = await memoryManager.listMemories();
  const existingDesc = existing.length > 0 ? existing.map((m) => `- ${m.name}: ${m.description}`).join("\n") : "(none)";

  const prompt = [
    "Extract user preferences, constraints, or project facts from this dialogue.",
    'Return a JSON object: { "memories": [ { ...entry } ] }. An empty "memories" array means nothing new.',
    "Each entry needs: name, type, description, body, and optionally importance and expiresAt.",
    `- name: short kebab-case identifier (e.g. "user-preference-tabs")`,
    `- type: one of ${memoryTypeSchema.options.join(", ")}`,
    "- description: one-line summary for index lookup",
    "- body: full detail in markdown",
    "- importance (optional): number 0–1 rating how valuable this memory is across",
    "  future sessions. Prefer 0.7–1.0 for durable user preferences / core project",
    "  facts; 0.3–0.6 for moderately useful details; omit for typical entries.",
    "- expiresAt (optional): ISO timestamp when this memory stops being relevant",
    "  (e.g. a temporary constraint or a deprecation date). Omit for durable memories.",
    "Reply with the JSON object only — no prose, no markdown code fences.",
    `Existing memories:\n${existingDesc}`,
    "",
    `Dialogue:\n${boundedDialogue}`,
  ].join("\n");

  let extracted: ExtractedMemory[];
  try {
    const { data, usage: queryUsage } = await runSideTextQuery(textAdapter, {
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      userPrompt: prompt,
      maxOutputTokens: MEMORY_EXTRACT_MAX_TOKENS,
      abortSignal,
      log,
      schema: extractionSchema,
    });
    extracted = data.memories;
    // Side queries record themselves in the global usage store, but that store is
    // observability — not the owning agent's lifetime totals. Accounting for the call
    // here is what keeps memory extraction from being the one LLM call in the run no
    // `UsageTracker` ever sees. Same contract as `memory-retrieval.selectWithLLM`.
    if (usage && queryUsage) usage.addTotal(queryUsage);
  } catch {
    // Transport and schema failures both land here. The port has already logged
    // the reason; an abort is expected, not a fault, so neither is re-reported.
    return 0;
  }

  const items = extracted;
  let count = 0;
  for (const item of items.slice(0, MAX_EXTRACTED_ENTRIES)) {
    await memoryManager.writeMemory(item.name, item.type, item.description, item.body, {
      importance: item.importance,
      expiresAt: item.expiresAt,
    });
    count++;
  }

  return count;
}

// ============================================================================
// Memory Consolidation
// ============================================================================

export interface ConsolidationResult {
  /** Whether the consolidation actually modified anything */
  changed: boolean;
  /** Number of memories after consolidation */
  count: number;
}

/**
 * Consolidate memories when the count exceeds the threshold.
 *
 * Two-phase approach:
 * 1. LLM consolidation — send a lightweight catalog (frontmatter only, no
 *    bodies) so the LLM can see ALL memories without hitting token limits.
 *    The LLM returns merge/delete decisions. For merges, it writes the merged
 *    body from the descriptions.
 * 2. Hard-cap eviction — if the count still exceeds {@link DEFAULT_HARD_MAX_MEMORIES}
 *    after LLM consolidation, evict the oldest memories (by updatedAt) until
 *    under the cap.
 *
 * @param memoryManager - MemoryManager instance
 * @param textAdapter - Text adapter for the consolidation query
 * @param log - Optional agent log for failure visibility
 * @returns Consolidation result with changed flag and final count
 */
export async function consolidateMemories(
  memoryManager: MemoryManager,
  textAdapter: TextAdapterConfig,
  log?: AgentLog,
  usage?: UsageTracker | null
): Promise<ConsolidationResult> {
  const memories = await memoryManager.listMemories();
  if (memories.length < memoryManager.getConsolidateThreshold()) {
    return { changed: false, count: memories.length };
  }

  // Phase 1: LLM consolidation via lightweight catalog (frontmatter only).
  // This avoids the token-truncation problem where sending full bodies would
  // exceed the context and cause the LLM to only see a subset of memories.
  const llmChanged = await llmConsolidate(memories, memoryManager, textAdapter, log, usage);

  // Phase 2: Hard-cap eviction. If LLM consolidation didn't reduce enough,
  // evict oldest memories by updatedAt to stay under the hard limit.
  const postLlmMemories = llmChanged ? await memoryManager.listMemories() : memories;
  const evicted = await evictOldest(postLlmMemories, memoryManager);

  const changed = llmChanged || evicted > 0;
  const finalCount = postLlmMemories.length - evicted;
  return { changed, count: changed ? finalCount : memories.length };
}

/**
 * Pure deletion decision for one consolidation pass.
 *
 * Returns the filenames that must be removed: every `replaces` / `deleted` entry that
 * existed in the PRE-merge snapshot (`memories`) and was NOT written by this same pass
 * (`writtenFilenames`).
 *
 * Skipping this pass's own writes is the point. Merged memories are written first, and
 * the delete step consults `memories` — the pre-merge snapshot — so a merge naturally
 * named after one of its sources (`alpha-note` + `beta-note` → `alpha-note`) carries
 * `replaces: ["alpha-note.md"]`, the snapshot still lists it, and an unguarded delete
 * removes the merged file written a moment earlier (observed: the store ends up empty).
 * Returning the decision instead of performing I/O keeps that rule testable in isolation.
 */
export function applyConsolidationDecisions(
  memories: ReadonlyArray<{ filename: string }>,
  decisions: {
    merged: ReadonlyArray<{ replaces: ReadonlyArray<string> }>;
    deleted: ReadonlyArray<string>;
  },
  writtenFilenames: Iterable<string>
): string[] {
  const written = new Set(writtenFilenames);
  const candidates = new Set<string>();
  for (const merge of decisions.merged) {
    for (const filename of merge.replaces) candidates.add(filename);
  }
  for (const filename of decisions.deleted) candidates.add(filename);

  return [...candidates].filter((filename) => !written.has(filename) && memories.some((m) => m.filename === filename));
}

/**
 * Phase 1: LLM-driven consolidation using a lightweight frontmatter-only catalog.
 *
 * Returns true if any files were written or deleted. A failure (transport or
 * schema) returns false, leaving every existing memory untouched.
 */
async function llmConsolidate(
  memories: Memory[],
  memoryManager: MemoryManager,
  textAdapter: TextAdapterConfig,
  log?: AgentLog,
  usage?: UsageTracker | null
): Promise<boolean> {
  // Build a lightweight catalog: filename + name + type + description (no body).
  // 59 memories × ~80 chars each ≈ 5KB — well within token limits.
  const catalog = memories.map((m) => `- ${m.filename} | ${m.type} | ${m.name} | ${m.description}`).join("\n");

  const prompt = [
    "Below is a catalog of all memory files (filename | type | name | description).",
    "Decide which to merge, delete, or keep.",
    "",
    catalog.slice(0, MAX_CONSOLIDATION_CATALOG_CHARS),
  ].join("\n");

  let decisions: ConsolidationDecisions;
  try {
    const { data, usage: queryUsage } = await runSideTextQuery(textAdapter, {
      systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
      userPrompt: prompt,
      maxOutputTokens: MEMORY_CONSOLIDATE_MAX_TOKENS,
      log,
      schema: consolidationSchema,
    });
    decisions = data as ConsolidationDecisions;
    // Accounted for the same reason as the extraction query — see `extractMemories`.
    if (usage && queryUsage) usage.addTotal(queryUsage);
  } catch {
    // The port logged the reason. Reporting "no change" keeps the existing
    // memories exactly as they are rather than half-applying a failed response.
    return false;
  }

  // Both collections are required by the schema, so a response that omitted one
  // is a failure, not "nothing to do" — there is no empty-array default here.
  const { merged, deleted } = decisions;
  let changed = false;

  // Write merged memories first, tracking the filename each write actually produced
  // (`writeMemory` derives it from a slug, so the recorded name — not `merge.name` — is
  // what the delete step below must compare against).
  const writtenFilenames = new Set<string>();
  for (const merge of merged) {
    const filename = await memoryManager.writeMemory(merge.name, merge.type, merge.description, merge.body, {
      importance: merge.importance,
      expiresAt: merge.expiresAt,
    });
    writtenFilenames.add(filename);
    changed = true;
  }

  // Delete replaced and explicitly-deleted files, but never one THIS pass just wrote.
  // The delete decision consults `memories` (the pre-merge snapshot), which still lists a
  // source the merge overwrote in place — so a merge named after one of its sources would
  // otherwise delete its own output.
  for (const filename of applyConsolidationDecisions(memories, { merged, deleted }, writtenFilenames)) {
    await memoryManager.deleteMemory(filename);
    changed = true;
  }

  return changed;
}

/**
 * Phase 2: Evict oldest memories (by updatedAt) until under the hard cap.
 *
 * Eviction order (cheapest to keep):
 * 1. Expired memories (expiresAt in the past) — no longer relevant at all.
 * 2. Lowest importance (explicit importance sorts before unset).
 * 3. Oldest by updatedAt (fall back to createdAt, then filename).
 *
 * Returns the number of evicted files.
 */
async function evictOldest(memories: Memory[], memoryManager: MemoryManager): Promise<number> {
  if (memories.length <= DEFAULT_HARD_MAX_MEMORIES) return 0;

  const now = Date.now();

  // Sort: expired first, then by importance (ascending, unset treated as 0.5), then oldest.
  const sorted = [...memories].sort((a, b) => {
    const aExpired = isExpiredMemory(a, now) ? 1 : 0;
    const bExpired = isExpiredMemory(b, now) ? 1 : 0;
    if (aExpired !== bExpired) return bExpired - aExpired;

    const ia = typeof a.importance === "number" ? a.importance : 0.5;
    const ib = typeof b.importance === "number" ? b.importance : 0.5;
    if (ia !== ib) return ia - ib;

    const ta = a.updatedAt ?? a.createdAt ?? "";
    const tb = b.updatedAt ?? b.createdAt ?? "";
    return ta.localeCompare(tb);
  });

  const toEvict = sorted.slice(0, sorted.length - DEFAULT_HARD_MAX_MEMORIES);
  for (const m of toEvict) {
    await memoryManager.deleteMemory(m.filename);
  }
  return toEvict.length;
}
