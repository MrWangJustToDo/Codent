/**
 * Run lifecycle middleware — usage tracking and stream side-effects.
 *
 * Status transitions live in {@link createStatusMiddleware}.
 * Turn-level finalization (`finalizeRun`: clear turn context, `agent:stop`, memory extract)
 * is owned by {@link AgentChatController.pumpToolPhases} / detached runners — not per-`chat()` finish.
 */

import { extractTanStackProvider, extractTanStackUsage } from "../../runtime-types/token-usage.js";

import { defineMiddleware } from "./phase.js";

import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { ModelPricing } from "../../models/types.js";
import type { UsageTracker } from "../../runtime-types";
import type { AgentIterationState } from "../../runtime-types/session-payloads.js";
import type { TokenUsage } from "../../runtime-types/token-usage.js";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";
import type { ChatMiddleware } from "@tanstack/ai";

// ============================================================================
// Lifecycle middleware
// ============================================================================

/**
 * Provider id from the `provider/model` model-id convention
 * ("deepseek/deepseek-v4-flash-0731" → "deepseek"). The runtime pipeline never
 * surfaces a provider name — the OpenAI-base adapters map only token fields and
 * `rebuildTokenUsage` folds AG-UI `SpecTokenUsage[]` into a single object before
 * `onUsage` — so the model prefix is the only reliable source. Returns undefined
 * for bare model ids (no `/`).
 */
function providerFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : undefined;
}

export interface LifecycleMiddlewareDeps {
  usage: UsageTracker;
  getPricing: () => ModelPricing | null | undefined;
  onThinking?: () => void;
  emitEvent?: EmitAgentTelemetryFn;
  /** Global usage-history hook: record each model iteration's tokens + cost. */
  recordUsage?: (input: { model?: string; usage: TokenUsage; costUsd: number }) => void;
  /** Effective agent-loop budget for this run (surfaced as the iteration ceiling). */
  maxIterations?: number;
  /** Called at the start of each model iteration with 1-based progress. */
  onIteration?: (state: AgentIterationState) => void;
  /**
   * Identity of the owning user turn. `firstOutput` is per turn, not per `chat()`: a restart-style
   * retry (429, capability strip, reactive compact) re-enters the engine, and the first output of the
   * retried attempt is still the turn's first output.
   */
  getRunToken?: () => unknown;
}

export function createLifecycleMiddleware(deps: LifecycleMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  let thinkingEmitted = false;
  let startTime = 0;
  // Per-round timer: reset on each RUN_STARTED so tok/s counts only pure model
  // time (tool execution between rounds is excluded from the denominator).
  let roundStart = 0;
  // Per-call observability captured for the `llm:response` timeline entry.
  let firstTokenAt = 0;
  let lastModel: string | undefined;
  let lastProvider: string | undefined;
  let lastRoundUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = { inputTokens: 0, outputTokens: 0 };
  let lastIteration = 0;
  /**
   * Model turns seen since the run token last changed — the index `iteration` and `turn:start`
   * report.
   *
   * Counted in `onIteration`, the only hook that fires exactly once per model call. Neither of the
   * two alternatives works: `ctx.iteration` is the ENGINE's counter and is 0 at `onStart` (upstream
   * assigns it in `beforeModel`, after `runOnStart`), and counting `onStart` would count *chats* —
   * a pump starts one chat per tool phase, so it happens to match, while a worker's single chat
   * with many iterations would report 1 forever.
   *
   * Consequence worth knowing: a restart-style retry (429 / capability strip / reactive compact) is
   * another model call and takes the next index. `agent:retry` is the event that marks it.
   */
  let turnsInRun = 0;
  let turnsRunToken: unknown;
  let lastRoundElapsedMs = 0;
  let lastReasoningTokens = 0;
  let lastCostUsd = 0;
  // Turn/message boundary state (see `turn:end` / `message:*` in the event registry).
  let turnIndex = 0;
  let turnToolCalls = 0;
  let turnClosed = false;
  /** Whether `turn:start` was emitted for the current chat (it is emitted per model call). */
  let turnOpen = false;
  let runFirstOutput = false;
  let runToken: unknown;
  let messageStarted = false;
  let messageId = "";
  let messageFirstOutput = false;
  let messageText = "";
  let messageToolCalls = 0;

  return defineMiddleware("observe", {
    name: "lifecycle",
    onIteration: (_ctx, info) => {
      // This — not `onStart` — is the turn boundary: `onStart` fires once per `chat()` while this
      // fires once per model call, so the index here is the run-scoped one.
      // One read: the run token is the same value for both the turn counter and `firstOutput`.
      const token = deps.getRunToken?.() ?? null;
      if (token !== turnsRunToken) {
        turnsRunToken = token;
        turnsInRun = 0;
      }
      turnsInRun += 1;
      lastIteration = turnsInRun;
      const index = turnsInRun;
      // Progress keeps the ENGINE's 0-based counter: `max` is that engine's budget, so a run-scoped
      // index would report `60/50` for a turn that crossed tool phases.
      deps.onIteration?.({ current: info.iteration + 1, max: deps.maxIterations ?? 0 });
      turnIndex = index;
      turnToolCalls = 0;
      turnClosed = false;
      messageStarted = false;
      messageId = "";
      messageText = "";
      messageToolCalls = 0;
      // Per-user-turn identity for `firstOutput` (a retried attempt keeps the same run id).
      if (token !== runToken) {
        runToken = token;
        runFirstOutput = false;
      }
      deps.emitEvent?.("turn:start", { index, max: deps.maxIterations ?? 0 });
      turnOpen = true;
    },
    onStart: (ctx) => {
      thinkingEmitted = false;
      startTime = Date.now();
      roundStart = startTime;
      firstTokenAt = 0;
      lastModel = ctx.model;
      // Reset here too: this request announces turn 1 of a new run, but the counter still holds the
      // previous run's total until the first `onIteration` of this chat.
      const requestToken = deps.getRunToken?.() ?? null;
      if (requestToken !== turnsRunToken) {
        turnsRunToken = requestToken;
        turnsInRun = 0;
      }
      // The turn this chat is about to run. Assigning it here (not only in `onIteration`) is what
      // keeps a chat that ends BEFORE its first iteration honest: early termination, a pending tool
      // phase and the upstream error path all reach `onFinish` without an iteration, and the
      // response would otherwise report the previous turn's number.
      lastIteration = turnsInRun + 1;

      deps.emitEvent?.("llm:request", {
        model: ctx.model,
        // Sticky from the previous iteration; falls back to the model-id prefix
        // for the first request of a run (usage never carries a provider here —
        // see {@link providerFromModel}).
        provider: lastProvider ?? providerFromModel(ctx?.model),
        // The turn this request is about to run: `onIteration` fires after `onStart` (upstream
        // runs `runOnStart` once per chat, before its first iteration), so the counter still holds
        // the previous turn's value here. `llm:response` reports the index the turn actually got.
        iteration: turnsInRun + 1,
        messagesCount: ctx.messages.length,
        toolsCount: ctx.toolNames?.length ?? 0,
      });
    },
    onChunk: (ctx, chunk) => {
      // TanStack fires RUN_STARTED once per model iteration (each LLM stream),
      // so this marks the start of a new round for per-round timing.
      if (chunk.type === "RUN_STARTED") {
        roundStart = Date.now();
        firstTokenAt = 0;
      }

      if (
        !thinkingEmitted &&
        (chunk.type === "REASONING_MESSAGE_START" || chunk.type === "REASONING_MESSAGE_CONTENT")
      ) {
        thinkingEmitted = true;
        if (!firstTokenAt) firstTokenAt = Date.now();
        deps.onThinking?.();
      }

      // ---- assistant message boundaries ----
      if (
        chunk.type === "TEXT_MESSAGE_START" ||
        chunk.type === "REASONING_MESSAGE_START" ||
        chunk.type === "TOOL_CALL_START"
      ) {
        if (!messageStarted) {
          messageStarted = true;
          messageId =
            (chunk as { messageId?: string }).messageId ??
            (ctx as { currentMessageId?: string } | undefined)?.currentMessageId ??
            `turn-${turnIndex}`;
          messageFirstOutput = !runFirstOutput;
          runFirstOutput = true;
          deps.emitEvent?.("message:start", {
            role: "assistant",
            messageId,
            firstOutput: messageFirstOutput,
          });
        }
      }
      if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta) {
        messageText += chunk.delta;
      }
      if (chunk.type === "TOOL_CALL_START") {
        turnToolCalls += 1;
        messageToolCalls += 1;
      }
      if (chunk.type === "RUN_FINISHED") {
        // A turn paused for approval / `ask_user` gets a second, interrupt-shaped RUN_FINISHED for the
        // same iteration. Closing twice would report a suspended turn as finished.
        if (turnClosed) return chunk;
        // A chat can end before its first model call (early termination, a pending tool phase, a
        // failed start). It never opened a turn, so there is nothing to close — emitting here used
        // the PREVIOUS turn's index (0 for the first) and produced a `turn:end` with no `turn:start`.
        if (!turnOpen) return chunk;
        turnClosed = true;
        turnOpen = false;
        const finishReason = (chunk as { finishReason?: string }).finishReason ?? null;
        deps.emitEvent?.("turn:end", { index: turnIndex, finishReason, toolCalls: turnToolCalls });
        if (messageStarted) {
          deps.emitEvent?.("message:end", {
            role: "assistant",
            messageId,
            firstOutput: messageFirstOutput,
            text: messageText,
            toolCalls: messageToolCalls,
            finishReason,
          });
          messageStarted = false;
        }
      }

      if (!firstTokenAt && chunk.type === "TEXT_MESSAGE_CONTENT") {
        firstTokenAt = Date.now();
      }

      return chunk;
    },
    onUsage: (ctx, usage) => {
      const parsed = extractTanStackUsage(usage);
      lastRoundUsage = parsed;
      // AG-UI SpecTokenUsage[] entries carry a provider; keep the extractor as
      // the preferred source (future-proof) and fall back to the model prefix.
      lastProvider = extractTanStackProvider(usage) ?? providerFromModel(ctx?.model) ?? lastProvider;
      deps.usage.updateWindowUsage(parsed, deps.getPricing());
      // onUsage fires once per model iteration (each RUN_FINISHED). Record this
      // round's wall-clock (since RUN_STARTED) + output tokens independently so
      // multi-iteration runs accumulate an accurate aggregate tok/s. Falls back
      // to the run start for rounds that never saw a RUN_STARTED.
      const roundElapsed = Date.now() - roundStart;
      deps.usage.addLlmCall(roundElapsed, parsed.outputTokens);
      lastRoundElapsedMs = roundElapsed;
      lastReasoningTokens = deps.usage.getLastCallReasoningTokens();
      lastCostUsd = deps.usage.getLastCallCostUsd();
      deps.recordUsage?.({ model: ctx.model ?? lastModel, usage: parsed, costUsd: lastCostUsd });
    },
    onFinish: (_ctx, info) => {
      // Rounds are already recorded per-iteration in onUsage; nothing to add
      // here. Emit telemetry with the overall run duration.
      // This ROW is one request. `window.outputTokens` accumulates across iterations/turns, so
      // pairing it with the last sample's input/cache described no real call; report the last
      // round's own numbers (the window totals stay on the usage channel).
      deps.emitEvent?.("llm:response", {
        model: lastModel,
        provider: lastProvider,
        iteration: lastIteration,
        finishReason: info.finishReason ?? undefined,
        inputTokens: lastRoundUsage.inputTokens,
        outputTokens: lastRoundUsage.outputTokens,
        cacheReadTokens: lastRoundUsage.cacheReadTokens ?? 0,
        cacheWriteTokens: lastRoundUsage.cacheWriteTokens ?? 0,
        reasoningTokens: lastReasoningTokens,
        costUsd: lastCostUsd,
        roundElapsedMs: lastRoundElapsedMs,
        firstTokenMs: firstTokenAt > 0 ? firstTokenAt - roundStart : undefined,
        durationMs: Date.now() - startTime,
      });
    },
  });
}
