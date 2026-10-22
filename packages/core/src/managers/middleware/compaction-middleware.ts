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
import type { AgentManager, AgentStatusController, UsageTracker } from "../../runtime-types";
import type { EmitAgentTelemetryFn } from "../telemetry/emit-agent-telemetry.js";

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
  status: AgentStatusController;
  log: AgentLog | null;
  emitEvent?: EmitAgentTelemetryFn;
  /**
   * Wire-projection cache to use. Supplied by the agent so that `getMessagesForLLM`
   * (manual `/compact`, reactive compact, memory extraction) and this middleware share
   * one cache and therefore one projection — not just one *implementation*.
   */
  getWireProjectionCache: () => WireProjectionCache;
}

/** TanStack compaction via {@link ChatMiddleware.onConfig}. */
export function createCompactionMiddleware(deps: CompactionMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("context-transform", {
    name: "compaction",
    onIteration: () => {
      deps.getTodoManager()?.incrementRound();
    },
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
        const compactionGeneration = managed?.beginCompactionGeneration();
        try {
          deps.status.beginCompaction("auto");

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

          // A manual compaction (or a session switch) can claim the status while the auto
          // summarizer is finishing. Do not apply its checkpoint or report completion in that case.
          if (managed && !managed.isCompactionCurrent(compactionGeneration)) {
            return { messages: llmMessages };
          }

          if (
            applyCompactionResult(deps.getCoreEnv(), fromChannel, channel, usage, result, {
              ...keepPolicyProjectionOptions(resolveKeepPolicy(compactionConfig ?? {}, contextWindow)),
              onCacheCleanupError: (err) => {
                deps.emitEvent?.("compaction:auto-error", {
                  phase: "cache-cleanup",
                  error: err.message,
                });
              },
            })
          ) {
            managed?.resetAdmittedTurnContext(true);
            wireCache.invalidate();
            llmMessages = projectWireFromChannel(channel, compactionConfig, contextWindow, wireCache);
          }

          if (result.compacted) {
            deps.emitEvent?.("compaction:auto-complete", {
              tokensBefore: result.tokensBefore,
              tokensAfter: result.tokensAfter,
            });
          }
        } catch (err) {
          // A user cancel is not a compaction failure — stay silent.
          if (!isAbortError(err) && (!managed || managed.isCompactionCurrent(compactionGeneration))) {
            const error = toError(err);
            deps.emitEvent?.("compaction:auto-error", { error: error.message });
          }
        } finally {
          // Only the owner that still holds the compaction generation may restore status.
          if (!managed || managed.isCompactionCurrent(compactionGeneration)) deps.status.endCompaction();
        }
      }

      return { messages: llmMessages };
    },
  });
}
