/**
 * Task Tool - Spawns a subagent for delegated tasks.
 *
 * The task tool allows the parent agent to delegate exploration or research
 * tasks to a subagent with fresh context. The subagent runs with read-only
 * tools and returns only a summary to the parent.
 *
 * This keeps the parent's context clean - only the summary is added,
 * not all the intermediate tool calls the subagent made.
 *
 * @example
 * ```typescript
 * const taskTool = createTaskTool({ parentAgentId: agent.id, agentManager: manager });
 *
 * // Agent can now use the task tool:
 * // "Use the task tool to find what testing framework this project uses"
 * ```
 */

import { z } from "zod";

import { generateId } from "../../utils/generate-id.js";
import { defineServerTool, isProjectedModelContent } from "../tools/runtime/define-tool.js";
import { maybeCacheOutput } from "../tools/util/tool-output-cache.js";
import { withDuration } from "../tools/util/tool-result.js";
import { toolOutputBaseSchema } from "../tools/util/types.js";

import { runSubagent } from "./run-subagent.js";
import { getTaskPreforkCoordinator } from "./task-prefork.js";
import { SUBAGENT_NO_TRUNCATE } from "./types.js";

import type { AgentManager } from "../../runtime-types/hosts.js";

// ============================================================================
// Types
// ============================================================================

export interface TaskToolConfig {
  /** Parent agent ID to spawn subagent from */
  parentAgentId: string;
  /** Agent manager for subagent lifecycle */
  manager: AgentManager;
}

// ============================================================================
// Output Schema
// ============================================================================

export const taskOutputSchema = z.object({
  /** Subagent ID - can be used to track or access the subagent */
  subagentId: z.string().describe("ID of the subagent that executed this task"),
  /** Summary of what the subagent found/accomplished */
  summary: z.string().describe("Summary of the subagent's findings"),
  /** Whether the summary was truncated by maxOutputLength (not disk-cache preview) */
  truncated: z.boolean().describe("Whether the summary was truncated by maxOutputLength"),
  /** Number of iterations the subagent used */
  iterations: z.number().describe("Iterations used by the subagent"),
  /** The subagent's iteration budget, so a restored row can show `used/budget` */
  maxIterations: z.number().describe("Iteration budget the subagent ran under"),
  /** Whether the subagent hit the iteration limit */
  reachedLimit: z.boolean().describe("Whether iteration limit was reached"),
  /**
   * Whether the subagent finished without a natural end — step-budget cutoff,
   * output length limit, error, empty summary, or missing `begin_summary` after tools.
   * The returned findings may be partial.
   */
  incomplete: z.boolean().describe("Whether the subagent was force-stopped before producing a final answer"),
  /** Whether the subagent was cancelled (aborted) before completing */
  aborted: z.boolean().describe("Whether the subagent was cancelled before completing"),
  /**
   * Why the subagent stopped, when `aborted` is true.
   *
   * `aborted` alone says the run did not finish; it does not say who stopped it. The
   * distinction is the whole point of this field: `user` is the operator, the other two
   * are the agent's own lifecycle. Optional so outputs persisted before it existed — and
   * the non-aborted case — stay readable.
   */
  stopReason: z
    .enum(["user", "parent-run", "parent-stop", "unknown"])
    .optional()
    .describe("Why an aborted subagent stopped (user / parent-run / parent-stop)"),
  /** Token usage */
  usage: z
    .object({
      inputTokens: z.number(),
      outputTokens: z.number(),
      totalTokens: z.number(),
      /**
       * Billed prompt tokens (cache-aware). Hosts must render this, not `inputTokens`:
       * under an exclusive upstream `inputTokens` is only the cache-miss part.
       *
       * Optional because results persisted before this field existed do not carry it —
       * readers fall back to the cache counters (see `formatTaskOutput`).
       */
      billedInputTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
    })
    .describe("Token usage for this subtask"),
  /** Execution duration in milliseconds */
  durationMs: z.number().describe("Execution duration in milliseconds"),
  ...toolOutputBaseSchema.shape,
});

export type TaskOutput = z.infer<typeof taskOutputSchema>;

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Creates the task tool for delegating work to subagents.
 *
 * The task tool:
 * 1. Spawns a subagent with fresh context (empty messages)
 * 2. Subagent uses read-only tools to complete the task
 * 3. Only the final summary is returned to the parent
 * 4. Subagent's full message history is discarded
 *
 * @param config - Tool configuration with parent agent ID and manager
 * @returns TanStack server tool
 */
export const createTaskTool = ({ parentAgentId, manager }: TaskToolConfig) => {
  return defineServerTool({
    name: "task",
    present: {
      category: "tasks",
      detailed: true,
    },
    description: `Spawn a subagent with fresh context to complete a delegated task.

Use this tool when you need to:
- Explore the codebase to find specific information
- Research a question that requires reading multiple files
- Look up current external docs or web information without polluting your context
- Perform complex multi-step exploration without polluting your context

Parallelism: independent tasks SHOULD be emitted together as multiple tool calls
in the same message — they run concurrently and the results arrive as one batch.
Only sequence tasks when one depends on another's findings.

Keep each task narrow: one question, or one file set, per call. The subagent has a fixed step
budget, and a broad audit can exhaust it before it summarizes — you then get a flagged partial
report instead of the answer.

The subagent:
- Starts with fresh context (doesn't see your conversation history)
- Has read-only tools: read_file, glob, grep, list_file, tree, websearch, webfetch, plus
  run_command restricted to read-only, project-internal commands (ls, cat, git status/log/diff) —
  writes, background commands, paths outside the project, and any command the safety policy cannot
  classify are denied
- Cannot modify files or spawn additional subagents
- Returns a summary plus status flags (reachedLimit, incomplete, aborted; stopReason when aborted)
- A long summary is a PREVIEW: it keeps the head and tail and ends with 'Full output saved to:
  <path>'. Read that file before treating the findings as complete — the middle is not in the summary.

How to use the result:
- Treat findings as trustworthy and extendable only when the run completed cleanly
  (incomplete=false, aborted=false, reachedLimit=false) and the summary is not a preview whose
  middle you still need.
- If any of those flags indicate a partial/forced stop, treat the summary as incomplete —
  re-run with a narrower prompt or continue exploring before finalizing decisions (e.g. create_plan).

Example use cases:
- "Find what testing framework this project uses"
- "List all API endpoints in the codebase"
- "Search for how error handling is implemented"
- "Look up the latest docs for library X and summarize the API"
- "Explore the authentication module structure"`,

    inputSchema: z.object({
      prompt: z.string().describe("The task for the subagent to complete. Be specific about what you want to know."),
      description: z
        .string()
        .optional()
        .describe("Short description of the task (shown in UI). Defaults to 'subtask'."),
    }),

    outputSchema: taskOutputSchema,

    execute: async ({ prompt, description }, { toolCallId, coreEnv }) => {
      // Prefer the subagent's own wall-clock run duration — for pre-forked
      // tasks the join wait would undercount (or be ~0 when already done).
      let runDurationMs: number | undefined;
      const output = await withDuration(async () => {
        // Join a pre-forked run when the task-prefork middleware already
        // started this subagent while args were streaming (parallel task
        // calls). Falls back to a serial spawn for uncapped/unseen calls.
        const parentManaged = manager.getAgent(parentAgentId);
        const preforked = parentManaged ? await getTaskPreforkCoordinator(parentManaged).join(toolCallId) : null;

        // Subagent owns its RunCoordinator AbortController (created in prepareForRun
        // and passed into TanStack chat). We do NOT register it on the parent's
        // pendingAbortControllers — child cancellation stays isolated from the
        // parent's own controller. Parent cancel still reaches the child through
        // ManagedAgent.abort() → cascadeAbortToChildren (running children get
        // child.abort()), so no external abortSignal is passed here; runAgent
        // wires the subagent's currentAbortController into chat so sub.abort()
        // actually stops the stream. Preforked runs take the parent-signal
        // listener path in task-prefork-middleware instead.
        const result =
          preforked ??
          (await runSubagent(
            {
              subagentId: generateId("subagent", {
                exists: (id) => manager.getAgent(id) != null,
              }),
              prompt,
              description,
              parentAgentId,
              parentTaskToolCallId: toolCallId,
              autoDestroy: false,
              maxOutputLength: SUBAGENT_NO_TRUNCATE,
            },
            { manager }
          ));
        runDurationMs = result.durationMs;

        let summary = result.output;
        // Length truncation from subagent (maxOutputLength). Separate from disk-cache preview below.
        const truncated = result.truncated;
        let cachedOutputPath: string | null = null;

        // Large summaries are previewed for the parent context; full text stays on disk.
        // Do NOT flip `truncated` here — that flag means maxOutputLength cut the summary.
        const cached = await maybeCacheOutput(coreEnv, result.output, `${toolCallId}-task`);
        cachedOutputPath = cached.cachedOutputPath;
        if (cachedOutputPath) {
          summary = cached.content;
        }

        return {
          subagentId: result.subagentId,
          summary,
          truncated,
          iterations: result.iterations,
          maxIterations: result.maxIterations,
          reachedLimit: result.reachedLimit,
          incomplete: result.incomplete,
          aborted: result.aborted,
          ...(result.stopReason ? { stopReason: result.stopReason } : {}),
          usage: result.usage,
          cachedOutputPath,
        };
      }).then((output) => {
        if (runDurationMs != null) output.durationMs = runDurationMs;
        return output;
      });
      return output;
    },

    // Summary + completion status for the model (usage stays UI-only).
    //
    // No iteration counts here, and none in the description either (it lists only the four
    // status flags). `reachedLimit` already IS the budget verdict and needs no knowledge of
    // the ceiling, while a bare count says nothing without one — so the pair is host-only,
    // persisted on the output for a restored `used/budget` readout.
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: TaskOutput }) {
      if (isProjectedModelContent(output)) return output;
      // `truncated` is NOT here: the task tool runs with `SUBAGENT_NO_TRUNCATE`, so it is always
      // false, while the summary the model actually receives may still be a cached PREVIEW. Listing
      // a dead flag beside the live ones invited a model to read `truncated=false` as "complete".
      // The preview announces itself in the text (`Full output saved to …`), which is the honest signal.
      const status = [
        `reachedLimit=${output.reachedLimit}`,
        `incomplete=${output.incomplete}`,
        `aborted=${output.aborted}`,
        ...(output.stopReason ? [`stopReason=${output.stopReason}`] : []),
      ].join(" ");
      return [
        {
          type: "text" as const,
          content: `${output.summary}\n\n[task status: ${status}]`,
        },
      ];
    },
  });
};
