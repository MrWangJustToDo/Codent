import { convertMessagesToModelMessages, type ChatMiddleware, type ModelMessage } from "@tanstack/ai";

import {
  applyCompactionResult,
  autoCompact,
  isCompactionCancel,
  isLatestDurableMessageCompactionSummary,
  keepPolicyProjectionOptions,
  resolveKeepPolicy,
} from "../../agent/compaction";
import { projectWireFromChannel } from "../../agent/compaction/wire-projection.js";
import { toError } from "../../utils/errors.js";

import { defineMiddleware } from "./phase.js";

import type { WireProjectionCache } from "../../agent/compaction";
import type { CompactionConfig } from "../../agent/compaction/types.js";
import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { TodoManager } from "../../agent/todo";
import type { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import type { ResolvedCoreEnv } from "../../env";
import type { AgentManager, EmitAgentTelemetryFn, UsageTracker } from "../../runtime-types";
import type { CompactionController } from "../controllers/compaction-controller.js";

export { projectWireFromChannel, type WireProjectionSource } from "../../agent/compaction/wire-projection.js";

export interface CompactionMiddlewareDeps {
  agentId: string;
  manager: AgentManager;
  getCompactionConfig: () => CompactionConfig | null;
  /** Resolved workspace env (owning runtime or ambient) for tool-cache maintenance. */
  getCoreEnv: () => ResolvedCoreEnv;
  /** Model input context window in tokens, if known (drives keep policy + trigger). */
  getContextWindow?: () => number | undefined;
  getUIChannel: () => AgentUIChannel | null;
  getUsage: () => UsageTracker;
  getTodoManager: () => TodoManager | null;
  shouldTriggerAutoCompact: (messages?: ModelMessage[]) => boolean;
  /** Compaction ownership (status, generation, start/complete/error events). */
  compactions: CompactionController;
  /** Publishes the post-compact cache-cleanup failure (`compaction:cache-cleanup-error`). */
  emitEvent: EmitAgentTelemetryFn;
  /**
   * Wire-projection cache to use. Supplied by the agent so that `getMessagesForLLM`
   * (manual `/compact`, reactive compact, memory extraction) and this middleware share
   * one cache and therefore one projection — not just one *implementation*.
   */
  getWireProjectionCache: () => WireProjectionCache;
}

/** TanStack compaction via {@link ChatMiddleware.onConfig}. */
export function createCompactionMiddleware(deps: CompactionMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  /**
   * How much the context must grow past the fill a failed auto attempt started at before that
   * attempt is worth repeating.
   *
   * The floor itself lives on {@link CompactionController} (`getAutoRetryFloor`), because this
   * middleware is rebuilt with the runner and a per-closure variable lost the memory exactly when a
   * new pipeline took over. See the controller for the bug that caused.
   */
  const RETRY_AFTER_FILL_GROWTH = 8_000;

  return defineMiddleware("context-transform", {
    name: "compaction",
    onConfig: async (_ctx, config) => {
      const wireCache = deps.getWireProjectionCache();
      const engineMessages = config.messages as ModelMessage[];
      const channel = deps.getUIChannel();

      if (!channel) {
        return { messages: engineMessages };
      }

      const compactionConfig = deps.getCompactionConfig();
      const contextWindow = deps.getContextWindow?.();
      // Always project from the live channel. Early tool results and compact
      // appends land on the channel before the next inner iteration.
      let llmMessages = projectWireFromChannel(channel, compactionConfig, contextWindow, wireCache);

      const managed = deps.manager.getAgent(deps.agentId);
      const isSubagent = Boolean(managed?.parentId);
      // Hoisted for the catch: a throw from the summarizer must be classified against the run's
      // signal, not by matching the word "abort" in its message.
      const runAbortSignal = managed?.run.currentAbortController?.signal;

      const alreadyCompacted = isLatestDurableMessageCompactionSummary(channel.getMessages());
      if (!isSubagent && !alreadyCompacted && deps.shouldTriggerAutoCompact(llmMessages)) {
        const fillBefore = deps.getUsage().getContextFillTokens() ?? 0;
        const retryFloor = deps.compactions.getAutoRetryFloor();
        if (retryFloor !== null && fillBefore < retryFloor + RETRY_AFTER_FILL_GROWTH) {
          // The previous attempt failed (or made no progress) on this same context; retrying
          // before it grows would re-summarize the whole prefix on every model call.
          return { messages: llmMessages };
        }

        const lease = deps.compactions.begin("auto", { tokensBefore: fillBefore });
        if (!lease) return { messages: llmMessages };
        try {
          const incompleteTodos = deps.getTodoManager()?.getIncompleteTodos() ?? [];
          const todos = incompleteTodos.map((t) => ({
            content: t.content,
            status: t.status as "pending" | "in_progress" | "completed",
            priority: t.priority as "high" | "medium" | "low",
          }));

          const usage = deps.getUsage();
          // The context fill, not the raw input field — see UsageTracker.getContextFillTokens().
          const actualTokens = usage.getContextFillTokens() ?? 0;
          const fromChannel = convertMessagesToModelMessages(channel.getMessages());
          // Cancel the summarizer with the run so an Esc mid-compaction does not
          // leave a half-written checkpoint.
          const result = await autoCompact(llmMessages, compactionConfig ?? {}, deps.agentId, deps.manager, {
            todos: todos.length > 0 ? todos : undefined,
            actualTokens: actualTokens || undefined,
            contextWindow,
            ...(runAbortSignal ? { abortSignal: runAbortSignal } : {}),
          });

          // A manual compaction (or a session switch) can claim ownership while the auto
          // summarizer is finishing. Do not apply its checkpoint or report completion in that case.
          if (!deps.compactions.isCurrent(lease)) {
            return { messages: llmMessages };
          }

          if (
            applyCompactionResult(deps.getCoreEnv(), fromChannel, channel, usage, result, {
              ...keepPolicyProjectionOptions(resolveKeepPolicy(compactionConfig ?? {}, contextWindow)),
              onCacheCleanupError: (err) => {
                // The cleanup callback is asynchronous (`applyCompactionResult` fires it from a
                // `.catch`), so by the time it runs the lease has ALREADY finished as completed:
                // calling `finish` here was a no-op (`isCurrent` false) and the failure vanished.
                // Report it directly, as the other two compaction paths do.
                deps.emitEvent("compaction:cache-cleanup-error", { error: err.message });
              },
            })
          ) {
            wireCache.invalidate();
            llmMessages = projectWireFromChannel(channel, compactionConfig, contextWindow, wireCache);
          }

          if (result.compacted) {
            deps.compactions.clearAutoRetryFloor();
            deps.compactions.finish(lease, {
              status: "completed",
              tokensBefore: result.tokensBefore,
              tokensAfter: result.tokensAfter,
            });
          } else if (result.aborted) {
            // Esc cancelled the summarizer: give the status back and emit nothing. Arming the retry
            // floor here (the old path treated it as `skipped`) deferred the next real compaction
            // until the context grew another 8k tokens.
            deps.compactions.release(lease);
          } else if (result.error) {
            // A real failure used to fall into `skipped`: no event, no log, indistinguishable
            // from "nothing to compact", and the reason was dropped.
            deps.compactions.armAutoRetryFloor(fillBefore);
            deps.compactions.finish(lease, { status: "failed", error: result.error });
          } else {
            // No progress (empty summary, summarizer no-op): remember where we tried so the
            // next model call does not start the same summarization again.
            deps.compactions.armAutoRetryFloor(fillBefore);
            deps.compactions.finish(lease, { status: "skipped" });
          }
        } catch (err) {
          // A user cancel is not a compaction failure — stay silent (but give the status back).
          if (isCompactionCancel(err, runAbortSignal)) {
            deps.compactions.release(lease);
          } else if (deps.compactions.isCurrent(lease)) {
            const error = toError(err);
            deps.compactions.armAutoRetryFloor(fillBefore);
            deps.compactions.finish(lease, { status: "failed", error: error.message });
          }
        } finally {
          // Idempotent: `finish`/`release` above already ended it. This covers a throw out of the
          // catch block itself, so the agent cannot stay stuck in `compacting`.
          deps.compactions.release(lease);
        }
      }

      return { messages: llmMessages };
    },
  });
}
