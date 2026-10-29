/**
 * Session-scoped log sink lifetime: bind, re-point, release and the destroy-time flush.
 *
 * The ordering is the contract: a destroy must land the buffered batch first, then release the
 * sink (which also clears its periodic timer), then unregister the process-level guard. Releasing
 * earlier sends final extension work into a buffer nothing drains; never releasing leaves a timer
 * writing into a directory that teardown is trying to remove.
 */

import { registerActiveAgentLog, unregisterActiveAgentLog } from "../agent/agent-log";
import { AGENT_LOG_DIR, isSafeSessionId } from "../agent/persistence/types.js";

import type { AgentLog } from "../agent/agent-log";
import type { AgentLogFileSinkOptions } from "../agent/agent-log/types.js";
import type { ResolvedCoreEnv } from "../env";

export interface AgentLogBindingDeps {
  getLog: () => AgentLog;
  getParentId: () => string | undefined;
  getSessionId: () => string | undefined;
  getAgentId: () => string;
  getCoreEnv: () => ResolvedCoreEnv;
  /** Bind through the built-in log extension (which tracks the sink for teardown). */
  attachViaManager?: (log: AgentLog, options: AgentLogFileSinkOptions) => (() => void) | null | undefined;
}

export class AgentLogBinding {
  private detachHandle: (() => void) | null = null;

  constructor(private readonly deps: AgentLogBindingDeps) {}

  /**
   * Attach (or re-point) the session JSONL sink. No-op for subagents: they write an independent
   * file into the parent's directory, bound by `AgentManager.spawnSubagent`.
   */
  bind(sessionId?: string, options?: { sessionBoundary?: boolean }): void {
    if (this.deps.getParentId()) return;

    const resolved = sessionId ?? this.deps.getSessionId() ?? this.deps.getAgentId();
    // The log directory is `AGENT_LOG_DIR/<id>`, so the id is a path segment. `SessionStore` refuses
    // an unsafe id, but `bind` runs BEFORE the store's restore validates it (resume binds the sink,
    // then loads), so an id from an external entry point (`session/load`, HTTP resume) would have
    // created the directory first. Fall back to the agent id, which this process minted.
    const safe = isSafeSessionId(resolved) ? resolved : this.deps.getAgentId();
    const dir = `${AGENT_LOG_DIR}/${safe}`;
    const log = this.deps.getLog();
    if (log.getFileSinkDir() === dir) return;

    this.detachHandle?.();
    const sinkOptions = {
      dir,
      env: this.deps.getCoreEnv(),
      ...(options?.sessionBoundary === false ? { sessionBoundary: false } : {}),
    };
    this.detachHandle = this.deps.attachViaManager?.(log, sinkOptions) ?? log.attachFileSink(sinkOptions);
    // Track for the process-level crash/exit guards.
    registerActiveAgentLog(log);
  }

  /**
   * Record a release handle for a sink bound outside {@link bind} — the subagent path owns the
   * options (parent dir + `{subagentId}.log`) and defers release until that agent is destroyed.
   */
  setExternalDetach(detach: () => void): void {
    this.detachHandle?.();
    this.detachHandle = detach;
  }

  /** Release the active sink binding. Idempotent; the handle is cleared first. */
  detach(): void {
    const detach = this.detachHandle;
    this.detachHandle = null;
    detach?.();
  }

  /**
   * Destroy-time: land buffered entries, release the sink, then unregister the guard.
   *
   * Awaitable: a runtime without sync fs (remote CoreEnv) can only write its final batch
   * asynchronously, so the caller must await this before the process exits. `AgentLog.flush()`
   * is a no-op when no sink is attached.
   */
  async flushOnDestroy(): Promise<void> {
    const log = this.deps.getLog();
    log.flushSync();
    try {
      await log.flush();
    } catch {
      // A failed final write must not block releasing the sink.
    }
    this.detach();
    unregisterActiveAgentLog(log);
  }
}
