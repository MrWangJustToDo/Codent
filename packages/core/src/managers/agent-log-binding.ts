/**
 * Session-scoped log sink lifetime: bind, re-point, release and the destroy-time flush.
 *
 * The ordering is the contract: a destroy must land the buffered batch first, then release the
 * sink (which also clears its periodic timer), then unregister the process-level guard. Releasing
 * earlier sends final extension work into a buffer nothing drains; never releasing leaves a timer
 * writing into a directory that teardown is trying to remove.
 */

import { registerActiveAgentLog, unregisterActiveAgentLog } from "../agent/agent-log";
import { AGENT_LOG_DIR } from "../agent/persistence/types.js";

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
  bind(sessionId?: string): void {
    if (this.deps.getParentId()) return;

    const resolved = sessionId ?? this.deps.getSessionId() ?? this.deps.getAgentId();
    const dir = `${AGENT_LOG_DIR}/${resolved}`;
    const log = this.deps.getLog();
    if (log.getFileSinkDir() === dir) return;

    this.detachHandle?.();
    const options = { dir, env: this.deps.getCoreEnv() };
    this.detachHandle = this.deps.attachViaManager?.(log, options) ?? log.attachFileSink(options);
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

  /** Destroy-time: land buffered entries, release the sink, then unregister the guard. */
  flushOnDestroy(): void {
    const log = this.deps.getLog();
    log.flushSync();
    this.detach();
    unregisterActiveAgentLog(log);
  }
}
