/**
 * Derive subagent run statistics from UI message snapshots and stream metadata.
 */

import { splitStepSegments } from "../stream/extract-assistant-text.js";
import { isToolCallPart } from "../stream/message-parts.js";

import { BEGIN_SUMMARY_TOOL_NAME } from "./begin-summary-tool.js";
import { EMPTY_SUMMARY } from "./subagent-output.js";

import type { SubagentResult } from "./types.js";
import type { AgentStatus } from "../../runtime-types/agent-status.js";
import type { AgentIterationState } from "../../runtime-types/session-payloads.js";
import type { StreamChunk, UIMessage } from "@tanstack/ai";

/**
 * Finish reasons that mean the model hit an output/token limit (not the agent
 * step budget). TanStack's {@link maxIterations} does **not** emit a dedicated
 * reason — step-budget cutoffs leave the last model reason (`tool_calls`).
 */
const OUTPUT_LIMIT_FINISH_REASONS = new Set(["length"]);

export interface DeriveSubagentRunStatsInput {
  messages: UIMessage[];
  maxIterations: number;
  finishReason: string | null;
  /**
   * The engine's own verdict that the agent loop stopped before the model finished
   * (`RUN_FINISHED.metadata.tanstack.loopStopped`, `@tanstack/ai` >= 1.3).
   *
   * `@tanstack/ai@1.4.0` only ever stamps `true` (`withTanstackMetadata(..., { loopStopped: true })`)
   * and it does so only when the engine itself refused another model call. A normal finish — and an
   * approval / client-tool pause, which the engine treats as an ordinary outcome — carries NO field,
   * so `undefined` is the common case and keeps the pre-1.3 heuristic below (a known best-effort
   * over-report: `tool_calls` alone cannot separate that pause from a cutoff). `false` is honoured
   * defensively if a replayed or future chunk shape supplies it; this SDK does not emit it.
   */
  loopStopped?: boolean;
  output: string;
  aborted: boolean;
  status?: AgentStatus;
  /**
   * The child agent's own loop progress, read from the retained `iteration` state.
   *
   * Authoritative when present: this is the engine's own count
   * (`IterationInfo.iteration + 1`), so it needs no inference. It covers turns the
   * message-derived count cannot see at all — see {@link countSubagentIterations}.
   */
  observedIterations?: AgentIterationState;
}

/** Whether the subagent called {@link BEGIN_SUMMARY_TOOL_NAME} (explore natural end). */
export function hasBeginSummaryCall(messages: UIMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (isToolCallPart(part) && part.name === BEGIN_SUMMARY_TOOL_NAME) return true;
    }
  }
  return false;
}

export function countSubagentToolCalls(messages: UIMessage[]): number {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool-call").length;
}

/**
 * Count agent-loop style rounds: each contiguous tool-call batch from one model
 * turn (parallel tools = 1 round). Falls back to text-only step segments.
 *
 * **Not the same quantity as the engine's iteration count** ({@link AgentIterationState}), and
 * it is kept only as a fallback for callers that have no access to that state:
 *
 *   - it cannot see turns that start no tool batch, so a final text-only turn — a real model
 *     turn that spends budget — is not counted at all (measured: 2 here vs 3 engine turns for a
 *     transcript of two tool rounds plus a closing answer);
 *   - it has to GUESS when it can count nothing (`sawAssistant` false / no assistant message),
 *     returning a floor of 1;
 *   - it is only available after the run.
 *
 * `deriveSubagentRunStats` prefers the engine's count when the caller passes it, which is why
 * that parameter exists.
 */
export function countSubagentIterations(messages: UIMessage[]): number {
  let rounds = 0;
  let sawAssistant = false;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    sawAssistant = true;

    let inToolCallBatch = false;
    for (const part of message.parts) {
      if (part.type === "tool-call") {
        if (!inToolCallBatch) {
          rounds++;
          inToolCallBatch = true;
        }
      } else if (part.type === "tool-result") {
        // End of a tool batch — next tool-call starts a new round (sequential turns).
        inToolCallBatch = false;
      } else {
        inToolCallBatch = false;
      }
    }
  }

  if (rounds > 0) return rounds;

  if (!sawAssistant) return 1;

  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant) return 1;

  return Math.max(1, splitStepSegments(lastAssistant.parts).length);
}

/** What the terminal {@link RUN_FINISHED} of a child run reported. */
export interface StreamFinishInfo {
  finishReason: string | null;
  /** `undefined` when the SDK/run supplied no verdict (an older metadata shape). */
  loopStopped: boolean | undefined;
}

/**
 * The engine's own "the loop stopped before the model finished" verdict, or `undefined`.
 *
 * It rides `metadata.tanstack.loopStopped` on the terminal `RUN_FINISHED` (`@tanstack/ai` >= 1.3).
 * Read defensively: an older chunk shape has no metadata, and "absent" must stay distinct from
 * `false` so the caller can fall back to the pre-1.3 heuristic. Note the emitting side only stamps
 * `true`, so the distinction is a tolerance for foreign chunks, not a value this SDK produces.
 */
function readLoopStopped(chunk: StreamChunk): boolean | undefined {
  const metadata = (chunk as { metadata?: { tanstack?: { loopStopped?: unknown } } }).metadata;
  const value = metadata?.tanstack?.loopStopped;
  return value === true ? true : value === false ? false : undefined;
}

/** Wrap a stream to capture {@link RUN_FINISHED} finish reason and loop verdict. */
export async function* captureStreamFinishReason(
  stream: AsyncIterable<StreamChunk>,
  onFinish: (info: StreamFinishInfo) => void
): AsyncIterable<StreamChunk> {
  for await (const chunk of stream) {
    if (chunk.type === "RUN_FINISHED") {
      const record = chunk as { finishReason?: string };
      // A run can emit more than one terminal chunk when tool iterations defer their finish;
      // the LAST one describes the run's outcome.
      onFinish({ finishReason: record.finishReason ?? null, loopStopped: readLoopStopped(chunk) });
    }
    yield chunk;
  }
}

export function deriveSubagentRunStats(
  input: DeriveSubagentRunStatsInput
): Pick<SubagentResult, "iterations" | "maxIterations" | "reachedLimit" | "incomplete"> {
  // Prefer the engine's own count when the caller has it. It cannot undercount the
  // way the message-derived count does (a final text-only turn is a real model turn
  // that spends budget but starts no tool batch), and the budget comparison below is
  // a decision — undercounting it misses a real cutoff.
  const observed = input.observedIterations?.current;
  const iterations = observed && observed > 0 ? observed : countSubagentIterations(input.messages);
  const toolCalls = countSubagentToolCalls(input.messages);
  const finishReason = input.finishReason;
  const calledBeginSummary = hasBeginSummaryCall(input.messages);

  // TanStack `maxIterations(n)` stops the loop without rewriting finishReason.
  // When the step budget cuts off mid-tooling, the last model reason is typically `tool_calls`.
  // Fallback: an explore subagent that exhausted the budget WITHOUT ever calling
  // `begin_summary` cannot have finished naturally — some cutoffs end on a text
  // narration step (finishReason "stop"), which would otherwise hide the limit.
  //
  // Not for a cancelled run. A user cancel lands mid-tool-loop, so `finishReason` is `tool_calls`
  // and the count can sit at the ceiling — the run was stopped, not cut off, and reporting both
  // `aborted` and `reachedLimit` puts a "limit reached" label on a run nobody let finish. The
  // gates downstream already read it that way (`incomplete` is only evaluated when NOT aborted,
  // which is why the fallback never fired for these); this is the same rule in the flag itself.
  //
  // The engine's own `loopStopped` decides when a chunk supplies it: `true` is exactly "the strategy
  // or `onShouldContinue` refused another model call while tool results waited". That is the one
  // thing this SDK actually emits (`@tanstack/ai@1.4.0` never stamps `false`), and it is what makes
  // a cutoff that ended on a narration step (`finishReason: "stop"`) visible.
  //
  // Everything else — a normal finish, an approval/client-tool pause — leaves the field absent, which
  // keeps the heuristic below. That heuristic is best-effort, not a fix for the pause case: a
  // `tool_calls` finish with no verdict still reads as a cutoff. `false` is honoured if it ever
  // arrives, but it is not a shape this SDK produces.
  //
  // This comparison is `iterationCount >= max` in the engine's own units
  // (`maxIterations(max) => ({iterationCount}) => iterationCount < max`), which is
  // why `iterations` above has to be that same count and not a tool-batch tally.
  const hitStepBudget =
    input.maxIterations > 0 &&
    !input.aborted &&
    (input.loopStopped !== undefined
      ? input.loopStopped
      : finishReason === "tool_calls" || (!calledBeginSummary && toolCalls > 0 && iterations >= input.maxIterations));
  const reachedLimit = hitStepBudget;

  const hasSummary = input.output.trim().length > 0 && input.output !== EMPTY_SUMMARY;
  const hitOutputLimit = finishReason != null && OUTPUT_LIMIT_FINISH_REASONS.has(finishReason);

  let incomplete = false;
  if (!input.aborted) {
    if (!hasSummary) {
      incomplete = true;
    } else if (reachedLimit || hitOutputLimit || input.status === "error") {
      incomplete = true;
    } else if (toolCalls > 0 && !calledBeginSummary) {
      // Explore tools require begin_summary before a trustworthy final answer.
      // Headless runs with `tools: {}` (compaction/memory) never hit this branch.
      incomplete = true;
    }
  }

  return {
    iterations: Math.max(iterations, 1),
    // The ceiling the count was measured against, so a host can render `used/budget` —
    // and it must be the budget the count was actually compared with, i.e. this same
    // `maxIterations` (an observed state carries its own `max`, which is the child's
    // configured default and can differ from the caller's).
    maxIterations: input.maxIterations,
    reachedLimit,
    incomplete,
  };
}
