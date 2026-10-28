import { convertMessagesToModelMessages, type ChatMiddleware, type ModelMessage } from "@tanstack/ai";

import {
  applyCompactionResult,
  autoCompact,
  isLatestDurableMessageCompactionSummary,
  keepPolicyProjectionOptions,
  resolveKeepPolicy,
} from "../../agent/compaction";
import { projectWireFromChannel } from "../../agent/compaction/wire-projection.js";
import { isAbortError } from "../../runtime-types/abort.js";
import { toError } from "../../utils/errors.js";

import { defineMiddleware } from "./phase.js";

import type { AgentLog } from "../../agent/agent-log";
import type { WireProjectionCache } from "../../agent/compaction";
import type { CompactionConfig } from "../../agent/compaction/types.js";
import type { ToolRunContext } from "../../agent/runner/run-context.js";
import type { TodoManager } from "../../agent/todo";
import type { AgentUIChannel } from "../../agent/ui/ui-channel.js";
import type { ResolvedCoreEnv } from "../../env";
import type { AgentManager, UsageTracker } from "../../runtime-types";
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
  log: AgentLog | null;
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
   * Fill (in tokens) at which the last attempt failed or made no progress.
   *
   * A failing summarizer used to be retried on EVERY model call: the trigger reads the same fill
   * and `isLatestDurableMessageCompactionSummary` stays false, so a 30-iteration run could start
   * 30 full summarizer subagents over the whole pre-cut history. One failure is remembered until
   * the context has grown enough to be worth another attempt (or a success clears it); a user
   * abort is not a failure and does not arm this.
   */
  let failedAtFill: number | null = null;
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

      const alreadyCompacted = isLatestDurableMessageCompactionSummary(channel.getMessages());
      if (!isSubagent && !alreadyCompacted && deps.shouldTriggerAutoCompact(llmMessages)) {
        const fillBefore = deps.getUsage().getContextFillTokens() ?? 0;
        if (failedAtFill !== null && fillBefore < failedAtFill + RETRY_AFTER_FILL_GROWTH) {
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
          const runAbortSignal = managed?.run.currentAbortController?.signal;
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
                deps.compactions.finish(lease, { status: "failed", phase: "cache-cleanup", error: err.message });
              },
            })
          ) {
            wireCache.invalidate();
            llmMessages = projectWireFromChannel(channel, compactionConfig, contextWindow, wireCache);
          }

          if (result.compacted) {
            failedAtFill = null;
            deps.compactions.finish(lease, {
              status: "completed",
              tokensBefore: result.tokensBefore,
              tokensAfter: result.tokensAfter,
            });
          } else {
            // No progress (empty summary, summarizer no-op): remember where we tried so the
            // next model call does not start the same summarization again.
            failedAtFill = fillBefore;
            deps.compactions.finish(lease, { status: "skipped" });
          }
        } catch (err) {
          // A user cancel is not a compaction failure — stay silent (but give the status back).
          if (isAbortError(err)) {
            deps.compactions.release(lease);
          } else if (deps.compactions.isCurrent(lease)) {
            const error = toError(err);
            failedAtFill = fillBefore;
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
