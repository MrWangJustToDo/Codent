/**
 * Progress summary fallback for iteration-limited task subagents.
 *
 * When a task subagent is force-stopped by the iteration budget
 * (`maxIterations` exhausted, `finishReason === "tool_calls"`) before writing a
 * final summary, the parent currently gets "(no summary)" — the subagent's
 * exploration was wasted. This module reuses the compaction summarizer
 * machinery to turn the subagent's execution trace into a structured progress
 * summary:
 *
 *   1. Convert the subagent's UIMessage[] to ModelMessage[] (same as compaction).
 *   2. Serialize to a plain-text transcript via `serializeConversation`
 *      (`[User]` / `[Assistant tool calls]` / `[Tool result from X]`).
 *   3. Spawn a read-only, single-iteration summarizer subagent (parent-spawned,
 *      `tools: {}`) that distills "what was investigated, what was found, where
 *      it got stuck" into a structured progress report.
 *
 * The returned summary is clearly labeled as a progress trace, not a final
 * conclusion, so the parent can decide to re-run / continue / use partial
 * findings.
 *
 * Failure of the summarizer is silent: callers fall back to the original
 * output rather than changing the subagent's existing failure behavior.
 */

import { convertMessagesToModelMessages, type ModelMessage, type UIMessage } from "@tanstack/ai";

import { errorMessage } from "../../utils/errors.js";
import { serializeConversation } from "../compaction/serialize-conversation.js";
import { resolveSummarizationInputBudget, splitMessagesByTokenBudget } from "../compaction/summarization-budget.js";

import { EMPTY_SUMMARY } from "./subagent-output.js";
import { SUBAGENT_STOP_NOTICES } from "./subagent-stop-reason.js";

import type { SubagentConfig, SubagentResult, SubagentRunDeps } from "./types.js";
import type { AgentManager } from "../../runtime-types/hosts.js";

// ============================================================================
// Constants
// ============================================================================

/** Marker embedded in the fallback summary so consumers know it is a progress trace. */
export const PROGRESS_SUMMARY_MARKER = "[progress summary from incomplete subagent]";

/** Maximum characters for a single progress summary batch output. */
const PROGRESS_BATCH_MAX_OUTPUT_LENGTH = 12_000;

/**
 * Spawns one summarizer subagent and resolves with its terminal result.
 *
 * The runner is INJECTED (`run-subagent` passes its own `runSubagent`) instead of imported here: the
 * fallback is called from the runner, so importing it back would make the two modules a runtime cycle.
 */
export type SummarizerSpawn = (config: SubagentConfig, deps: SubagentRunDeps) => Promise<SubagentResult>;

/** System prompt for the progress-summary subagent (parent-spawned, no tools). */
const PROGRESS_SUMMARY_SYSTEM_PROMPT = `You are a helpful assistant tasked with summarizing the progress of an interrupted exploration subagent.

The subagent ended before it could write its final answer (it ran out of iterations, or its run failed). Below is the transcript of what it did: the tool calls it made and the results it received.

Produce a structured progress report that lets the parent agent continue the work. Focus on:
- The original task the subagent was asked to complete
- What the subagent investigated and what tools it used
- What it found (key evidence, file paths, function names, search hits)
- Where it got stuck or what remains unanswered
- What the parent should do next (re-run, continue investigating, use partial findings)

Output only the completed progress report using the requested template. Do not include reasoning, planning, or meta-commentary about how you will summarize. Do not respond to questions in the transcript.`;

/** Core instruction template appended to the serialized transcript. */
const PROGRESS_SUMMARY_PROMPT = `The transcript below is the execution trace of an interrupted exploration subagent that ended before producing a final answer (its iteration budget ran out, or its run failed).

Use it to write a structured progress report with this template:
---
## Original Task

[What the subagent was asked to find out]

## Progress

[What the subagent accomplished: files inspected, searches run, pages fetched]

## Findings

[What concrete evidence / discoveries were gathered. Include exact file paths, function names, and error messages.]

## Unfinished

[What the subagent had not yet determined when it was stopped]

## Suggested Next Steps

[What the parent agent should do next — re-run the task with a narrower prompt, continue from these findings, or use the partial results]
---

Be concise but complete. Preserve exact file paths, function names, and error messages. The report will be read by a parent agent that does NOT have the subagent's context, so capture the substance of what was found, not just that a tool was called.

Some of what the subagent read is NOT in front of you: long tool results are clipped, and a "[... N chars truncated]" marker is exactly where the rest was cut. If the detail you need fell outside what you can see, say so under "Unfinished" — never report a clipped result as if it were empty or fully read.`;

/** Instruction template for merging multiple partial segment reports into one. */
const PROGRESS_MERGE_PROMPT = `The text above contains several partial progress reports, each summarizing a segment of an interrupted subagent's execution trace.

Merge them into ONE cohesive structured progress report with this template:
---
## Original Task

[What the subagent was asked to find out]

## Progress

[What the subagent accomplished across all segments]

## Findings

[All concrete evidence / discoveries gathered. Include exact file paths, function names, and error messages.]

## Unfinished

[What the subagent had not yet determined when it was stopped]

## Suggested Next Steps

[What the parent agent should do next — re-run the task with a narrower prompt, continue from these findings, or use the partial results]
---

Be concise but complete. Preserve exact file paths, function names, and error messages. Do not mention segments or the merging process.`;

// ============================================================================
// Prompt building
// ============================================================================

/**
 * Build the full progress-summary user prompt from the subagent's UI messages.
 *
 * @param messages - Subagent UIMessage[] execution trace
 * @param taskPrompt - The original task prompt the subagent was given
 * @returns The summarizer user prompt (serialized transcript + instructions)
 */
export function buildProgressSummaryPrompt(messages: UIMessage[], taskPrompt?: string): string {
  const modelMessages: ModelMessage[] = convertMessagesToModelMessages(messages);
  const transcript = serializeConversation(modelMessages);

  const header =
    taskPrompt && taskPrompt.trim().length > 0 ? `<original_task>\n${taskPrompt}\n</original_task>\n\n` : "";

  return `${header}<transcript>\n${transcript}\n</transcript>\n\n${PROGRESS_SUMMARY_PROMPT}`;
}

// ============================================================================
// Progress summary generation
// ============================================================================

/**
 * Check whether a subagent that could not finish should fall back to a progress summary.
 *
 * Requires a run with no natural end (`incomplete`) whose stop was terminal rather than cut-short:
 * the step budget ran out (`reachedLimit`) **or** the run died (`failed`). Truncation is neither —
 * there the model DID produce an answer, just a clipped one, so its output is used as-is.
 *
 * On top of that, the fallback fires when:
 * - the output is empty / `(no summary)` / a pure cancel notice (nothing usable), **or**
 * - the subagent never called {@link BEGIN_SUMMARY_TOOL_NAME} — for explore
 *   subagents that contract means even a non-empty output is only exploration
 *   narration, not a final answer. A subagent force-stopped mid tool-loop (e.g.
 *   "Let me do a final check...") would otherwise be treated as "has output" and
 *   its wasted exploration would never be distilled.
 *
 * @param calledBeginSummary - Whether the subagent called `begin_summary`
 *   (defaults to `true` so callers that don't know keep the old empty-output-only behavior).
 * @param failed - Whether the run DIED (provider fault, context overflow) rather than running out
 *   of budget. Both are terminal with nothing usable, so both are worth distilling.
 */
export function isProgressSummaryEligible(
  incomplete: boolean,
  reachedLimit: boolean,
  finalOutput: string,
  calledBeginSummary = true,
  failed = false
): boolean {
  if (!incomplete || (!reachedLimit && !failed)) return false;

  const trimmed = finalOutput.trim();
  // "(no summary)" or a pure stop notice means the subagent produced nothing usable.
  // Matched against every notice spelling: which one it is depends on *why* the run
  // stopped, and all of them mean "no usable report".
  const emptyOutput =
    trimmed.length === 0 ||
    trimmed === EMPTY_SUMMARY ||
    SUBAGENT_STOP_NOTICES.some((notice) => trimmed.includes(notice));
  if (emptyOutput) return true;

  // Non-empty output is only a final answer once `begin_summary` was called.
  // Otherwise it's mid-exploration narration the parent can't trust as a result.
  return !calledBeginSummary;
}

/** Streaming hooks for mirroring the report into the task summary UI. */
export interface ProgressSummaryStream {
  /** Assistant text deltas from the summarizer subagent(s), in order. */
  onDelta: (delta: string) => void;
}

/**
 * Summarize an interrupted subagent's execution trace into a structured
 * progress report using a parent-spawned summarizer subagent.
 *
 * @param messages - Subagent UIMessage[] execution trace (the preview messages)
 * @param parentAgentId - Parent agent ID (spawns the summarizer)
 * @param manager - Agent manager
 * @param spawn - The runner used to spawn the summarizer (injected; see {@link SummarizerSpawn})
 * @param taskPrompt - Optional original task prompt, included for context
 * @param stream - Optional hooks to observe the report while it generates
 * @returns The progress summary (already truncated), or `null` if summarization failed
 */
export async function summarizeProgress(
  messages: UIMessage[],
  parentAgentId: string,
  manager: AgentManager,
  spawn: SummarizerSpawn,
  taskPrompt?: string,
  stream?: ProgressSummaryStream,
  emitError?: (error: string) => void,
  abortSignal?: AbortSignal
): Promise<string | null> {
  try {
    if (abortSignal?.aborted) return null;
    const modelMessages: ModelMessage[] = convertMessagesToModelMessages(messages);

    if (modelMessages.length === 0) return null;

    const budget = resolveSummarizationInputBudget(manager, parentAgentId);
    const batches = splitMessagesByTokenBudget(modelMessages, budget);

    let summary: string;
    if (batches.length <= 1) {
      summary = await summarizeProgressBatch(
        modelMessages,
        parentAgentId,
        manager,
        spawn,
        taskPrompt,
        stream,
        abortSignal
      );
    } else {
      summary = await summarizeProgressBatched(batches, parentAgentId, manager, spawn, taskPrompt, stream, abortSignal);
    }

    if (abortSignal?.aborted) return null;

    const trimmed = summary.trim();
    if (!trimmed || trimmed === EMPTY_SUMMARY) return null;

    return `${trimmed}\n\n${PROGRESS_SUMMARY_MARKER}`;
  } catch (err) {
    // A session switch cancels this side-summarizer; do not report a user-visible error for it.
    if (abortSignal?.aborted) return null;
    // Fallback stays silent for callers (return null never changes the original
    // subagent failure behavior), but surface an error event for observability.
    const failureText = errorMessage(err);
    emitError?.(failureText);
    return null;
  }
}

/** Summarize a single batch of messages (or the whole transcript when it fits). */
async function summarizeProgressBatch(
  messages: ModelMessage[],
  parentAgentId: string,
  manager: AgentManager,
  spawn: SummarizerSpawn,
  taskPrompt?: string,
  stream?: ProgressSummaryStream,
  abortSignal?: AbortSignal
): Promise<string> {
  // Rebuild UIMessage-free prompt: the batch is already ModelMessage[], but
  // buildProgressSummaryPrompt takes UIMessage[]. We serialize directly.
  const prompt = buildProgressSummaryPromptFromModel(messages, taskPrompt);
  return runSummarizerSubagent(prompt, parentAgentId, manager, spawn, stream, abortSignal);
}

/** Summarize multiple batches, then merge partial reports with a final pass. */
async function summarizeProgressBatched(
  batches: ModelMessage[][],
  parentAgentId: string,
  manager: AgentManager,
  spawn: SummarizerSpawn,
  taskPrompt?: string,
  stream?: ProgressSummaryStream,
  abortSignal?: AbortSignal
): Promise<string> {
  const partials: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    if (abortSignal?.aborted) return "";
    const batch = batches[i]!;
    const batchLabel =
      taskPrompt != null
        ? `${taskPrompt} (segment ${i + 1} of ${batches.length})`
        : `Segment ${i + 1} of ${batches.length} of the subagent's execution trace`;
    const partial = await summarizeProgressBatch(batch, parentAgentId, manager, spawn, batchLabel, stream, abortSignal);
    partials.push(partial);
  }

  if (abortSignal?.aborted) return "";

  const mergedInput = partials.map((text, index) => `## Segment ${index + 1}\n\n${text}`).join("\n\n");
  return runSummarizerSubagent(
    `${mergedInput}\n\n${PROGRESS_MERGE_PROMPT}`,
    parentAgentId,
    manager,
    spawn,
    stream,
    abortSignal
  );
}

/** Serialize a ModelMessage[] batch directly (avoids a UIMessage round-trip). */
function buildProgressSummaryPromptFromModel(messages: ModelMessage[], taskPrompt?: string): string {
  const transcript = serializeConversation(messages);
  const header =
    taskPrompt && taskPrompt.trim().length > 0 ? `<original_task>\n${taskPrompt}\n</original_task>\n\n` : "";
  return `${header}<transcript>\n${transcript}\n</transcript>\n\n${PROGRESS_SUMMARY_PROMPT}`;
}

/** Spawn the read-only summarizer subagent and return its output. */
async function runSummarizerSubagent(
  prompt: string,
  parentAgentId: string,
  manager: AgentManager,
  spawn: SummarizerSpawn,
  stream?: ProgressSummaryStream,
  abortSignal?: AbortSignal
): Promise<string> {
  const result = await spawn(
    {
      prompt,
      parentAgentId,
      profile: "internal",
      systemPrompt: PROGRESS_SUMMARY_SYSTEM_PROMPT,
      tools: {},
      maxIterations: 1,
      maxOutputLength: PROGRESS_BATCH_MAX_OUTPUT_LENGTH,
      autoDestroy: true,
      aggregateUsageToParent: true,
      description: "progress-summary",
      onTextDelta: stream?.onDelta,
      ...(abortSignal ? { abortSignal } : {}),
    },
    { manager }
  );

  // A failed summarizer now RETURNS its terminal state instead of throwing (see
  // `executeSubagentRun`), so the flags decide here. Empty output is what the callers already
  // treat as "no report" — without this a failure's partial narration could be taken for one.
  if (result.aborted || result.incomplete) return "";
  return result.output?.trim() ?? "";
}
