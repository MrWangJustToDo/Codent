/**
 * Compaction helpers for {@link ManagedAgent} (reactive + manual `/compact`).
 */

import { convertMessagesToModelMessages } from "@tanstack/ai";

import { isCompactionCancel } from "../agent/compaction/abort-classification.js";
import { applyCompactionResult, applyReactiveCompactionResult } from "../agent/compaction/apply-compaction-result.js";
import { autoCompact } from "../agent/compaction/auto-compact.js";
import { keepPolicyProjectionOptions, resolveKeepPolicy } from "../agent/compaction/keep-policy.js";
import { getModelVisibleMessages } from "../agent/compaction/message-chain-projection.js";
import { isPromptTooLongError, reactiveCompact } from "../agent/compaction/reactive-compact.js";
import { estimateTokens } from "../agent/compaction/token-estimator.js";
import { toError } from "../utils/errors.js";

import type { AgentManager } from "./agent-manager.js";
import type { ResolvedCoreEnv } from "../env";
import type { CompactionController, CompactionLease } from "./controllers/compaction-controller.js";
import type { CompactionService } from "./services/compaction-service.js";
import type { EmitAgentTelemetryFn } from "./telemetry/emit-agent-telemetry.js";
import type { UsageTracker } from "./telemetry/usage-tracker.js";
import type { AgentLog } from "../agent/agent-log/agent-log.js";
import type { CompactionConfig } from "../agent/compaction/types.js";
import type { TodoManager } from "../agent/todo";
import type { AgentUIChannel } from "../agent/ui/ui-channel.js";
import type { ModelMessage, UIMessage as TanStackUIMessage } from "@tanstack/ai";

export interface ReactiveCompactHost {
  id: string;
  parentId?: string;
  getUI: () => AgentUIChannel | undefined;
  usage: UsageTracker;
  getCompaction(): CompactionService;
  /** Compaction ownership (leases, status, start/complete/error events). */
  compactions: CompactionController;
  getCanonicalFromUI: () => ModelMessage[];
  getMessagesForLLM: (canon?: ModelMessage[]) => ModelMessage[];
  emitEvent: EmitAgentTelemetryFn;
  compactionConfig?: { keepRecentTokens?: number } | null;
  /** Model input context window in tokens, if known (drives the reactive tail budget). */
  getContextWindow: () => number | undefined;
  /** Resolved workspace env (owning runtime or ambient). */
  getCoreEnv: () => ResolvedCoreEnv;
  /** Current run abort signal, so a cancel also cancels the summarizer. */
  getAbortSignal?: () => AbortSignal | undefined;
  /** The agent log, for non-fatal diagnostics (cache cleanup). */
  getLog?: () => AgentLog | null;
}

export async function handleManagedReactiveCompact(
  host: ReactiveCompactHost,
  error: unknown,
  manager: AgentManager
): Promise<boolean> {
  if (host.parentId) return false;
  if (!isPromptTooLongError(error)) return false;
  if (!host.getCompaction().canRetryReactiveCompact()) {
    host.emitEvent("compaction:reactive-max-retries");
    return false;
  }

  const channel = host.getUI();
  if (!channel) return false;

  const retry = host.getCompaction().recordReactiveCompactRetry();
  // Ownership is a lease from the controller: it publishes `compacting` + the start event and is
  // the one place a superseded attempt stops being able to apply its tail or restore the status.
  const lease = host.compactions.begin("reactive", {
    retry,
    maxRetries: host.getCompaction().getMaxReactiveCompactRetries(),
  });
  if (!lease) return false;
  const current = () => host.compactions.isCurrent(lease);
  // Hoisted so the catch can classify the throw against the same signal.
  const abortSignal = host.getAbortSignal?.();

  try {
    const canon = host.getCanonicalFromUI();
    const llmMessages = host.getMessagesForLLM(canon);
    const compactedMessages = await reactiveCompact(llmMessages, host.id, manager, {
      ...(host.compactionConfig?.keepRecentTokens != null
        ? { keepRecentTokens: host.compactionConfig.keepRecentTokens }
        : {}),
      ...(host.getContextWindow() && host.getContextWindow()! > 0 ? { contextWindow: host.getContextWindow() } : {}),
      ...(abortSignal ? { abortSignal } : {}),
    });

    // A manual/auto compaction or a session switch can claim status while the reactive
    // summarizer is finishing. Its checkpoint must not land in the new transcript.
    if (!current()) return false;

    // Capture window fill before apply (usage is reset by applyReactiveCompactionResult).
    const tokensBefore = host.usage.getContextFillTokens();

    const applied = applyReactiveCompactionResult(host.getCoreEnv(), canon, channel, host.usage, compactedMessages, {
      ...keepPolicyProjectionOptions(resolveKeepPolicy(host.compactionConfig ?? {}, host.getContextWindow())),
      onCacheCleanupError: (err) => {
        // A cache-cleanup failure is not a failed compaction: emitting `compaction:reactive-error`
        // here rendered as "Reactive compact failed" even though the summary had been applied.
        host.getLog?.()?.warn("compaction", "Reactive compact cache cleanup failed", {
          phase: "cache-cleanup",
          error: err.message,
        });
      },
    });

    // An empty/unappliable result is NOT a compaction: do not append a checkpoint, do not reset
    // the window, and do not report `completed` (the retry budget/status must see the truth).
    if (!applied) {
      host.compactions.release(lease);
      return false;
    }

    if (!current()) return false;

    host.compactions.finish(lease, {
      status: "completed",
      originalCount: llmMessages.length,
      compactedCount: compactedMessages.length,
      tokensBefore,
      tokensAfter: host.usage.getContextFillTokens(),
    });
    return true;
  } catch (err) {
    if (!current()) return false;
    // A user cancel is not a reactive-compaction failure — stay silent, but give the status back.
    // The signal is authoritative: a gateway error whose text says "aborted" while the run is
    // still live is a failure, not a cancel.
    if (isCompactionCancel(err, abortSignal)) {
      host.compactions.release(lease);
      return false;
    }
    const compactError = toError(err);
    // `finish` restores the status as part of the terminal outcome; without that the agent would
    // stay stuck in "compacting" (onRecoveryRetry only unwinds "error"), blocking the stream-recovery
    // loop's other strategies (capability / transient).
    host.compactions.finish(lease, { status: "failed", error: compactError.message });
    return false;
  } finally {
    // Closure is structural, not a property of remembering every `return`. `release` is
    // lease-checked and idempotent: after `finish` (or after a newer lease superseded this one)
    // it is a no-op, so it can only ever end THIS producer's lease — never a newer owner's.
    //
    // This replaces the former `CompactionController.settle()`, which was lease-blind: it forced
    // `compacting → running` by reading the status alone, so a delayed retry shell could have
    // overwritten the status of a compaction that had legitimately claimed ownership since.
    host.compactions.release(lease);
  }
}

// ============================================================================
// Manual compact (`/compact` / AgentSession `compact`)
// ============================================================================

export interface ManualCompactHost {
  id: string;
  getUI: () => AgentUIChannel | undefined;
  usage: UsageTracker;
  getTodoManager: () => TodoManager | null;
  /** Compaction ownership: the lease created for THIS `/compact`. */
  compactions: CompactionController;
  lease: CompactionLease;
  compactionConfig: CompactionConfig | null;
  /** Model input context window in tokens, if known (drives the keep policy). */
  getContextWindow: () => number | undefined;
  /** Resolved workspace env (owning runtime or ambient). */
  getCoreEnv: () => ResolvedCoreEnv;
  resetSystemPrompt: () => void;
  persistSession: () => void;
  maybeSaveSessionUIMessages: (messages: TanStackUIMessage[], reason: "force") => void;
  getLog?: () => AgentLog | null;
}

export type ManualCompactResult =
  { ok: true; message: string; tokensBefore?: number; tokensAfter?: number } | { ok: false; error: string };

/**
 * Run the same autoCompact path as the app `/compact` command.
 */
export async function runManualCompact(
  host: ManualCompactHost,
  manager: AgentManager,
  options?: { focus?: string; messages?: TanStackUIMessage[] }
): Promise<ManualCompactResult> {
  const channel = host.getUI();
  if (!channel) {
    return { ok: false, error: "Agent UI channel not available" };
  }

  if (options?.messages?.length) {
    channel.setMessages(options.messages);
  }

  const allModelMessages = convertMessagesToModelMessages(channel.getMessages());
  const keepOptions = keepPolicyProjectionOptions(
    resolveKeepPolicy(host.compactionConfig ?? {}, host.getContextWindow())
  );
  const messages = getModelVisibleMessages(allModelMessages, keepOptions);
  if (messages.length === 0) {
    return { ok: false, error: "No messages to compact" };
  }

  const incompleteTodos: Array<{ content: string; status: string; priority: string }> =
    host.getTodoManager()?.getIncompleteTodos() ?? [];
  const todos = incompleteTodos.map((t) => ({
    content: t.content,
    status: t.status as "pending" | "in_progress" | "completed",
    priority: t.priority as "high" | "medium" | "low",
  }));

  const tokensBeforeEstimate = estimateTokens(messages);
  const actualTokens = host.usage.getContextFillTokens();
  const abortSignal = host.lease.signal;
  const owned = () => host.compactions.isCurrent(host.lease);

  // The lease was claimed (status published) before this function was entered; a stale caller must
  // not apply anything to the transcript that replaced the one it started on.
  if (!owned()) return { ok: false, error: "Compaction aborted" };

  try {
    const result = await autoCompact(messages, host.compactionConfig || {}, host.id, manager, {
      focus: options?.focus,
      todos: todos.length > 0 ? todos : undefined,
      actualTokens: actualTokens || undefined,
      contextWindow: host.getContextWindow(),
      ...(abortSignal ? { abortSignal } : {}),
    });

    // The session may have switched while the summarizer was finishing. Do not apply a summary
    // to the transcript that replaced the one this compaction started on.
    if (!owned() || abortSignal?.aborted) {
      host.compactions.release(host.lease);
      return { ok: false, error: "Compaction aborted" };
    }

    const applied = applyCompactionResult(host.getCoreEnv(), allModelMessages, channel, host.usage, result, {
      ...keepOptions,
      onCacheCleanupError: (err) => {
        host.getLog?.()?.warn("compaction", "Manual compact cache cleanup failed", {
          phase: "cache-cleanup",
          error: err.message,
        });
      },
    });

    if (!applied) {
      if (abortSignal?.aborted) {
        host.compactions.release(host.lease);
        return { ok: false, error: "Compaction aborted" };
      }
      // The summarizer boundary tags its own cancel; a bare `skipped` here reported a cancel as
      // "Nothing to compact" with `ok: true` (remote/ACP treated it as completed).
      if (result.aborted) {
        host.compactions.release(host.lease);
        return { ok: false, error: "Compaction aborted" };
      }
      if (result.error) {
        host.compactions.finish(host.lease, { status: "failed", error: result.error });
        return { ok: false, error: result.error };
      }
      // No progress: restore the status, but report nothing (a no-op is not a completion).
      host.compactions.finish(host.lease, { status: "skipped" });
      return {
        ok: true,
        message:
          "Nothing to compact — not enough older conversation to summarize (reduce keepRecentTokens or add more history).",
      };
    }

    // An abort can land between apply and persistence; the new session must not receive the old
    // compaction's checkpoint or state write.
    if (!owned() || abortSignal?.aborted) {
      host.compactions.release(host.lease);
      return { ok: false, error: "Compaction aborted" };
    }

    host.resetSystemPrompt();
    host.persistSession();
    host.maybeSaveSessionUIMessages(channel.getMessages(), "force");

    const tokensBefore = result.tokensBefore ?? tokensBeforeEstimate;
    const tokensAfter = result.tokensAfter;
    const compressionRatio = tokensBefore > 0 ? Math.round((1 - tokensAfter / tokensBefore) * 100) : 0;
    const todoNote = incompleteTodos.length > 0 ? ` (${incompleteTodos.length} todos preserved)` : "";

    host.compactions.finish(host.lease, { status: "completed", tokensBefore, tokensAfter });
    return {
      ok: true,
      message: `Compacted: ${tokensBefore} → ${tokensAfter} tokens (${compressionRatio}% reduction)${todoNote}`,
      tokensBefore,
      tokensAfter,
    };
  } catch (error) {
    if (isCompactionCancel(error, host.lease.signal)) {
      // A cancel already took the status (and invalidated the lease); `release` is the no-op case
      // where the summarizer itself threw an abort without one.
      host.compactions.release(host.lease);
      return { ok: false, error: "Compaction aborted" };
    }
    const err = toError(error);
    // A cancel is silent (the auto path does the same); a real failure is not.
    host.compactions.finish(host.lease, { status: "failed", error: err.message });
    return { ok: false, error: `Compaction failed: ${err.message}` };
  }
}
