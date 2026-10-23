import { DISCOVERY_TOOL_NAME } from "@tanstack/ai";
import { z } from "zod";

import { TODO_PRIORITIES, TODO_STATUSES } from "../../todo/types.js";

// ============================================================================
// Tool Output Base Schema (common fields shared by all tool outputs)
// ============================================================================

/**
 * Common fields every tool output inherits.
 *
 * - `cachedOutputPath`: path to a disk-cached copy of large output, or `null`
 *   when no caching occurred. Standardized across all tools so the UI and LLM
 *   can rely on it being present.
 *
 * Errors are NOT represented in the output schema — tools throw on failure,
 * and the AI SDK surfaces the error via the `output-error` tool state
 * (`part.errorText` on the UI side). This keeps the success output clean and
 * avoids a redundant `error: null` field on every successful result.
 */
export const toolOutputBaseSchema = z.object({
  cachedOutputPath: z
    .string()
    .nullable()
    .describe(
      "Path to the full output on disk — a cached tool result or a background job's log — or null when no such file was written."
    ),
});

// ============================================================================
// Tool Output Schemas
// ============================================================================

export const listFileOutputSchema = z.object({
  entries: z
    .array(
      z.object({
        name: z.string().describe("Name of the file or directory."),
        type: z.string().describe("Type: 'file' or 'directory'."),
        size: z.number().optional().describe("Size in bytes (for files)."),
        modified: z.string().optional().describe("ISO timestamp of last modification."),
      })
    )
    .describe("Array of directory entries."),
  offset: z.number().describe("The offset used for pagination (0-indexed)."),
  limit: z.number().describe("The limit used for pagination."),
  count: z.number().describe("Number of entries returned in this page."),
  totalEntries: z.number().describe("Total number of entries in the directory."),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

export const runCommandOutputSchema = z.object({
  command: z.string().describe("The command that was executed."),
  stdout: z.string().describe("Standard output from the command."),
  stderr: z.string().describe("Standard error output from the command."),
  exitCode: z
    .number()
    .describe("Exit code of the command (0 = success). Use -1 while a background job is still running."),
  durationMs: z.number().describe("Execution duration in milliseconds (0 for a just-started background job)."),
  success: z
    .boolean()
    .describe(
      "Whether the command succeeded (exit code 0). Background starts report success=true when spawn succeeds."
    ),
  /** Present when the command was started with run_in_background. */
  jobId: z
    .string()
    .optional()
    .describe(
      `Background job id — get_command_output / kill_command are lazy tools; discover them via ${DISCOVERY_TOOL_NAME} first.`
    ),
  /** Present for background starts; typically "running". */
  status: z
    .enum(["running", "exited", "killed", "failed"])
    .optional()
    .describe("Background job status when run_in_background was used."),
  runInBackground: z.boolean().optional().describe("True when the command was started in the background."),
  /**
   * Present when the USER aborted the run while this command was executing. The tool
   * returns a normal result carrying this marker instead of letting the abort surface as a
   * thrown error, so the row renders as "cancelled" (same contract as the `task` tool's
   * `aborted` flag) rather than as a tool failure.
   */
  cancelled: z.boolean().optional().describe("True when the user aborted the run while this command was executing."),
  /**
   * Present when the command was terminated because its deadline elapsed. `stdout`/`stderr` carry
   * the partial output produced before the kill and `exitCode` is -1 ("not finished"). Distinct
   * from `cancelled`, which is a USER abort.
   */
  timedOut: z
    .boolean()
    .optional()
    .describe("True when the command was terminated at its deadline (partial output preserved)."),
  /** The deadline (ms) that elapsed — present with `timedOut`; the UI/compact presenters name it. */
  timeoutMs: z.number().optional().describe("The elapsed deadline in ms — present with `timedOut`."),
  ...toolOutputBaseSchema.shape,
});

export const getCommandOutputSchema = z.object({
  jobId: z.string().describe("Background job id."),
  status: z.enum(["running", "exited", "killed", "failed"]).describe("Current job status."),
  stdout: z.string().describe("Stdout produced since the last poll (incremental)."),
  stderr: z.string().describe("Stderr produced since the last poll (incremental)."),
  exitCode: z.number().nullable().describe("Exit code when finished; null while running."),
  running: z.boolean().describe("Whether the job is still running."),
  ...toolOutputBaseSchema.shape,
});

export const killCommandOutputSchema = z.object({
  jobId: z.string().describe("Background job id that was killed."),
  status: z.enum(["running", "exited", "killed", "failed"]).describe("Status after kill attempt."),
  killed: z.boolean().describe("Whether the job was found and kill was attempted."),
  ...toolOutputBaseSchema.shape,
});

// Note: readFileOutputSchema is now defined in read-file-tool.ts
// as a discriminated union to support multiple file types (text, image, pdf, directory, error)

export const writeFileOutputSchema = z.object({
  path: z.string().describe("The file path that was written."),
  bytesWritten: z.number().describe("Number of bytes written."),
  created: z.boolean().describe("Whether a new file was created (vs overwritten)."),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

export const editFileOutputSchema = z.object({
  path: z.string().describe("The file path that was edited."),
  replacements: z.number().describe("Number of replacements made."),
  oldFile: z.string().describe("The original file content before any edits were applied."),
  newFile: z.string().describe("The full file content after all edits have been applied."),
  results: z
    .array(
      z.object({
        oldString: z.string().describe("The search string (truncated if long)."),
        newString: z.string().describe("The replacement string."),
        found: z.boolean().describe("Whether the string was found in the file."),
        replaced: z.boolean().describe("Whether the replacement was made."),
        count: z.number().describe("Number of occurrences replaced."),
        startLine: z.number().optional().describe("Expected start line (1-indexed)."),
        actualLine: z.number().optional().describe("Actual line where match was found (1-indexed)."),
      })
    )
    .describe("Details of each edit operation."),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

export const globOutputSchema = z.object({
  files: z.array(z.string()).describe("Array of matching file paths."),
  offset: z.number().describe("The offset used for pagination (0-indexed)."),
  limit: z.number().describe("The limit used for pagination."),
  content: z.string().describe("The full glob output as a string (for caching)."),
  /**
   * Present when the USER aborted the run while the search was running. `files` is then empty
   * because nothing was scanned — NOT because the pattern matched nothing.
   */
  cancelled: z.boolean().optional().describe("True when the user aborted the run while the search was running."),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

export const grepOutputSchema = z.object({
  matches: z
    .array(
      z.object({
        file: z.string().describe("File path containing the match."),
        lineNumber: z
          .number()
          .int()
          .nonnegative()
          .describe("Line number of the match (1-indexed). 0 when not applicable (e.g. files_with_matches)."),
        content: z.string().describe("Content of the matching line (empty in files_with_matches mode)."),
        /**
         * Context rows are returned for display but are not counted by offset/limit.
         * Older consumers may ignore this field; `content` still carries the `[context] ` marker.
         */
        kind: z.enum(["match", "context"]).optional().describe("Whether this row is a match or context."),
      })
    )
    .describe("Array of matches found."),
  offset: z.number().describe("The offset used for pagination (0-indexed)."),
  limit: z.number().describe("The limit used for pagination."),
  content: z.string().describe("The full grep output as a string (for caching)."),
  /**
   * Present when the USER aborted the run while the search was running. `matches` is then empty
   * because nothing was scanned — NOT because the pattern matched nothing.
   */
  cancelled: z.boolean().optional().describe("True when the user aborted the run while the search was running."),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

export const todoOutputItemSchema = z.object({
  id: z.string().describe("Unique identifier for the todo."),
  content: z.string().describe("Description of the task."),
  status: z.enum(TODO_STATUSES).describe("Current status: pending | in_progress | completed."),
  priority: z.enum(TODO_PRIORITIES).describe("Priority level: high | medium | low."),
  createdAt: z.number().describe("Timestamp when created (ms epoch)."),
  updatedAt: z.number().describe("Timestamp when last updated (ms epoch)."),
});

export const todoOutputSchema = z.object({
  title: z.string().describe("Title for the current todo set."),
  /** Whether this list is plan-bound (`plan`) or a normal agent todo list (`agent`). Survives resume via tool parts. */
  source: z.enum(["plan", "agent"]).describe("Origin of this todo set for UI and resume."),
  /** Structured todo items for rich UI rendering. Mirrors the internal TodoItem list. */
  items: z.array(todoOutputItemSchema).describe("Structured todo items for UI rendering."),
  stats: z
    .object({
      total: z.number().describe("Total number of todos."),
      completed: z.number().describe("Number of completed todos."),
      inProgress: z.number().describe("Number of in-progress todos."),
      pending: z.number().describe("Number of pending todos."),
    })
    .describe("Todo completion statistics."),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

// ============================================================================
// Tool Output Types
// ============================================================================

export type ListFileOutput = z.infer<typeof listFileOutputSchema>;
export type RunCommandOutput = z.infer<typeof runCommandOutputSchema>;
export type GetCommandOutput = z.infer<typeof getCommandOutputSchema>;
export type KillCommandOutput = z.infer<typeof killCommandOutputSchema>;
// Note: ReadFileOutput is now exported from read-file-tool.ts
export type WriteFileOutput = z.infer<typeof writeFileOutputSchema>;
export type EditFileOutput = z.infer<typeof editFileOutputSchema>;
export type GlobOutput = z.infer<typeof globOutputSchema>;
export type GrepOutput = z.infer<typeof grepOutputSchema>;
export type TodoOutput = z.infer<typeof todoOutputSchema>;
