/**
 * Workspace log sink lifetime for one agent.
 *
 * The timeline is **one file per workspace** (`.agents/logs/agent.log`), size-rotated. It is bound
 * once when the agent is built and never re-pointed: a session switch, a resume or a `/new` is just
 * another recorded entry — the entry already carries `sessionId`, `run` and the agent scope, so the
 * file does not need to move.
 *
 * The close order is still the contract: land the buffered batch, release this agent's reference to
 * the shared sink, then unregister the process-level guard.
 */

import { registerActiveAgentLog, unregisterActiveAgentLog } from "../agent/agent-log";
import { AGENT_LOG_DIR } from "../agent/persistence/types.js";

import type { AgentLog } from "../agent/agent-log";
import type { AgentLogFileSinkOptions } from "../agent/agent-log/types.js";
import type { ResolvedCoreEnv } from "../env";

export interface AgentLogBindingDeps {
  getLog: () => AgentLog;
  getCoreEnv: () => ResolvedCoreEnv;
  /** Bind through the built-in log extension (which shares one sink per workspace). */
  attachViaManager?: (log: AgentLog, options: AgentLogFileSinkOptions) => (() => void) | null | undefined;
}

export class AgentLogBinding {
  private detachHandle: (() => void) | null = null;
  /** Whether a sink was ever attached (distinguishes "never bound" from "bound, then detached"). */
  private everBound = false;

  constructor(private readonly deps: AgentLogBindingDeps) {}

  /**
   * Bind the workspace sink. Idempotent: the first bind wins, and later session changes do not
   * detach/re-point it.
   */
  bind(): void {
    if (this.detachHandle) return;
    const log = this.deps.getLog();
    const sinkOptions = { dir: AGENT_LOG_DIR, env: this.deps.getCoreEnv() };
    this.detachHandle = this.deps.attachViaManager?.(log, sinkOptions) ?? log.attachFileSink(sinkOptions);
    // The attach may legitimately return a no-op handle when the env cannot append; `hasSink()` is
    // the truth, not "we called attach". Otherwise a later destroy reports nothing dropped while the
    // buffered bootstrap diagnostics silently die with the object.
    this.everBound = log.hasSink();
    registerActiveAgentLog(log);
  }

  /** Release this agent's reference. Idempotent. */
  detach(): void {
    const detach = this.detachHandle;
    this.detachHandle = null;
    detach?.();
  }

  /**
   * Destroy-time: land buffered entries, release the reference, then unregister the guard.
   *
   * Awaitable: a runtime without sync fs (remote CoreEnv) can only write its final batch
   * asynchronously, so the caller must await this before the process exits.
   */
  async flushOnDestroy(): Promise<void> {
    const log = this.deps.getLog();
    // A build that failed before the factory bound the sink drops its pending buffer with the
    // object. That buffer is exactly the bootstrap diagnostics the buffer exists for, so the loss
    // must at least be visible.
    if (!this.everBound && !log.hasSink() && (log.getPendingEntryCount() > 0 || log.getPendingDroppedCount() > 0)) {
      const count = log.getPendingEntryCount();
      const dropped = log.getPendingDroppedCount();
      console.warn(
        `[agent] dropping ${count} buffered log entr${count === 1 ? "y" : "ies"}` +
          `${dropped > 0 ? ` and ${dropped} already-overflowed entr${dropped === 1 ? "y" : "ies"}` : ""}` +
          ": no sink was bound before teardown"
      );
    }
    log.flushSync();
    try {
      await log.flush();
    } catch {
      // A failed final write must not block releasing the sink.
    }
    // Close BEFORE detaching: from here on the seam has no sink, and anything emitted in the rest of
    // teardown would otherwise be buffered for a drain that never comes.
    log.close();
    this.detach();
    unregisterActiveAgentLog(log);
  }
}
