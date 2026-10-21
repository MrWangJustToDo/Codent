/**
 * Compaction Prompt - Domain-specific prompt for conversation summarization.
 *
 * This prompt guides the LLM to generate high-quality summaries that preserve
 * essential context for continued agent work.
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Strip any runtime-managed `## Compact archives` section from a summary.
 *
 * The archive system is gone, but sessions persisted before its removal still carry the section in
 * their stored summary. Dropping it here keeps a stale path list from being fed to the summarizer
 * (or restated) on an incremental update.
 */
function stripCompactArchiveSections(text: string): string {
  return text.replace(/\n*## Compact archives?\b[\s\S]*?(?=\n## [^#]|\s*$)/gi, "").trimEnd();
}

/**
 * System prompt for the compaction subagent.
 * This tells the LLM its role is to summarize, not to continue the conversation.
 *
 * Based on OpenCode's compaction.txt prompt.
 */
export const COMPACTION_SYSTEM_PROMPT = `You are a helpful AI assistant tasked with summarizing conversations.

When asked to summarize, provide a detailed but concise summary of the conversation.
Focus on information that would be helpful for continuing the conversation, including:
- What was done
- What is currently being worked on
- Which files are being modified
- What needs to be done next
- Key user requests, constraints, or preferences that should persist
- Important technical decisions and why they were made
- What issues are currently blocked and why
- If images or files were shared, describe what they contained and what was discussed about them

Your summary should be comprehensive enough to provide context but concise enough to be quickly understood.

Output only the completed summary using the requested template. Do not include reasoning, planning, or meta-commentary about how you will summarize.

Respond in the same language as the conversation being summarized.

Do not respond to any questions in the conversation, only output the summary.`;

/**
 * The core compaction prompt template (used as the final user message).
 *
 * Based on the reference implementation from opencode, this prompt focuses on:
 * - What goal(s) the user is trying to accomplish
 * - What important instructions the user gave
 * - What notable things were learned (discoveries)
 * - What work was done, is in progress, or remains
 * - Which files are relevant
 */
export const COMPACTION_PROMPT = `Provide a detailed prompt for continuing the conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]
- [Background command jobs: list each job id (job_…), its final status/exit code and log path. The live job list is also re-injected as <background_jobs> after compaction.]

## Key Decisions

- **[Decision]**: [Brief rationale and context for why this decision was made]
- **[Technical approach]**: [Reasoning behind architecture or implementation choices]

## Blocked

[What issues are currently blocking progress, if any. Include error messages, investigation findings, and what was tried.]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---

Be concise but complete. Include specific file paths, function names, and technical details.

Respond in the same language as the conversation being summarized.`;

/**
 * Extra rules when the summarizer receives a `<still_in_context>` segment.
 * Kept separate so callers can attach it only when that segment is present.
 */
export const STILL_IN_CONTEXT_RULES = `## Segment rules

The conversation is split into labeled segments:
- \`<to_compress>\`: history that will leave the main agent's context — summarize this thoroughly.
- \`<turn_prefix>\` (when present): the discarded head of a single oversized turn — summarize per the split-turn rules below.
- \`<still_in_context>\`: recent turns that remain after compaction — use only to align Goal / Next / Accomplished with what is still visible.

Do NOT restate the \`<still_in_context>\` turns in detail; they will still be in the agent's context after compaction. Prefer capturing decisions, discoveries, and unfinished work from \`<to_compress>\`.`;

/**
 * Instruction used when summarizing ONLY the prefix of an oversized turn
 * (split-turn compaction). Modeled on pi's TURN_PREFIX_SUMMARIZATION_PROMPT.
 */
export const TURN_PREFIX_INSTRUCTION = `The conversation above is the PREFIX of a single oversized turn. The SUFFIX (recent work from the same turn) is retained in the agent's context — it is not shown here and must NOT be restated.

Summarize the prefix to provide context for the retained suffix, using this EXACT template:
---
## Original Request

[What did the user ask for in this turn?]

## Early Progress

- [Key decisions, discoveries, and work done in the prefix]

## Context for Retained Work

- [Information needed to understand and continue the retained recent work: file paths, function names, error messages, partial results]
---

Be concise. Focus on what's needed to understand the kept suffix.

Respond in the same language as the conversation being summarized.`;

/**
 * UPDATE compaction prompt template — used when a previous summary already exists.
 *
 * Based on PI's UPDATE_SUMMARIZATION_PROMPT, this tells the LLM to preserve
 * existing summary information and only add/update what's changed.
 *
 * The existing summary is passed via <previous-summary> tags in the prompt text.
 */
export const UPDATE_COMPACTION_PROMPT = `The conversation above contains new messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

When constructing the summary, stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]
- [Background command jobs: list each job id (job_…), its final status/exit code and log path. The live job list is also re-injected as <background_jobs> after compaction.]

## Key Decisions

- **[Decision]**: [Brief rationale and context for why this decision was made]
- Update or remove decisions that are no longer relevant

## Blocked

[What issues are currently blocking progress, if any. Include error messages, investigation findings, and what was tried.]
- Update or remove resolved blockages

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---

Keep each section concise. Preserve exact file paths, function names, and error messages.

Respond in the same language as the conversation being summarized.`;

// ============================================================================
// Public API
// ============================================================================

/**
 * Structured todo item for inclusion in compaction
 */
export interface CompactionTodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

/**
 * Build the compaction prompt with optional focus guidance, active todos,
 * and existing summary for incremental updates.
 *
 * @param options - Prompt configuration
 * @param options.focus - Optional focus area to emphasize in summarization
 * @param options.todos - Optional list of active todos to include in summary
 * @param options.existingSummary - Previous summary text (triggers update mode with <previous-summary> tags)
 * @param options.hasStillInContext - When true, append anti-duplication segment rules
 * @returns The complete prompt string
 *
 * @example
 * ```typescript
 * // Basic prompt (first compaction)
 * const prompt = buildCompactionPrompt();
 *
 * // Incremental update prompt (subsequent compactions)
 * const prompt = buildCompactionPrompt({
 *   existingSummary: "## Goal\n...",
 * });
 *
 * // With focus and todos
 * const prompt = buildCompactionPrompt({
 *   focus: "preserve the API design decisions",
 *   todos: [{ content: "Implement user auth", status: "in_progress", priority: "high" }],
 *   existingSummary: "## Goal\n...",
 * });
 * ```
 */
export function buildCompactionPrompt(options?: {
  focus?: string;
  todos?: CompactionTodoItem[];
  existingSummary?: string;
  hasStillInContext?: boolean;
}): string {
  const { focus, todos, existingSummary, hasStillInContext } = options ?? {};

  const parts: string[] = [];

  // If we have an existing summary, wrap it in <previous-summary> tags
  // and use the update prompt. The conversation history (initialMessages)
  // should NOT include this old summary message — it's passed here instead.
  // Strip runtime-managed ## Compact archives so the summarizer does not
  // restate path lists (runtime re-merges them after the update).
  if (existingSummary) {
    const summaryForUpdate = stripCompactArchiveSections(existingSummary);
    parts.push(`<previous-summary>\n${summaryForUpdate}\n</previous-summary>`);
    parts.push("");
    parts.push(UPDATE_COMPACTION_PROMPT);
  } else {
    parts.push(COMPACTION_PROMPT);
  }

  if (hasStillInContext) {
    parts.push(`\n${STILL_IN_CONTEXT_RULES}`);
  }

  if (focus) {
    parts.push(`\n## Special Focus\n\nPay particular attention to preserving information about: ${focus}`);
  }

  // Include active todos if provided - these go in the Accomplished section
  if (todos && todos.length > 0) {
    parts.push(
      `\n## Active Todo List\n\nThe following todos are currently active and should be included in the "Accomplished" section:\n`
    );

    for (const todo of todos) {
      const statusIcon =
        todo.status === "in_progress" ? "[IN PROGRESS]" : todo.status === "completed" ? "[DONE]" : "[PENDING]";
      const priorityLabel =
        todo.priority === "high" ? "(high priority)" : todo.priority === "low" ? "(low priority)" : "";
      parts.push(`- ${statusIcon} ${todo.content} ${priorityLabel}`.trim());
    }
  }

  return parts.join("\n");
}
