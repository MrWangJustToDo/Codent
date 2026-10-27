/**
 * Built-in log extension — owns log **policy**.
 *
 * The emission seam (`AgentLog`) does level filtering, run stamping, envelope construction and
 * hands the assembled entry to a sink. Everything about *what a log looks like* and *where it
 * goes* is assembled here:
 *
 * - **Sink** — the JSONL file with size rotation (`jsonl-file-sink.ts`).
 * - **Policy** — the event→entry rule table, formatting and payload summarizing, and the
 *   subscription that applies them (`event-log-bridge.ts`).
 *
 * So this module is mostly composition: it is the one place that says "these two halves are one
 * feature", which is what makes logging removable/observable as a unit rather than a behaviour
 * spread across the seam's call sites.
 *
 * Two entry paths, and they are deliberately different mechanisms:
 *
 * 1. **The seam** — `AgentLog.debug/info/warn/error/eventEntry` (the ~76 call sites plus the
 *    `ctx.logger` facade). These pass assembled entries straight through; their routing is decided
 *    at the call site, not by a rule.
 * 2. **The bus** — every observable event, turned into entries by the rule table. This is the
 *    subscription that centralizes lifecycle logging.
 *
 * The seam is a **privileged dependency injection**, not a bus event: a log-entry event would have
 * to be deliverable to this extension, but internal events are withheld from both wildcard delivery
 * and the observation surface, and an event this extension emits to feed itself is exactly the
 * recursion the internal classification exists to prevent. Injection has that property by
 * construction — the sink never emits.
 *
 * Subagents matter for the shape of this module: they have no extension runner (only roots get one,
 * `agent-factory.ts`), yet they write logs to their own file. So the extension exposes a **sink
 * factory** that core binds per `AgentLog` — root and subagent alike — rather than a per-agent
 * extension instance.
 */

import { createAgentEventBus } from "../agent-event-bus";
import { registerExtensionExitFlush } from "../agent-log/lifecycle-guards.js";

import { bridgeTelemetryToAgentLog } from "./event-log-bridge.js";
import { createJsonlFileSink } from "./jsonl-file-sink.js";

// Registered with the process-exit guards so a hard exit lands pending batches; see the module note.

import type { AgentEventBus } from "../agent-event-bus";
import type { EventLogPolicy, EventLogResolver } from "./event-log-bridge.js";
import type { AgentLog } from "../agent-log/agent-log.js";
import type { AgentLogFileSinkOptions } from "../agent-log/types.js";

export type { EventLogPolicy, EventLogResolver, EventLogRule } from "./event-log-bridge.js";

export interface LogExtensionOptions {
  /** Bus whose events become entries. Defaults to a fresh root bus (standalone use). */
  bus?: AgentEventBus;
  /** Resolve the log an event belongs to (per-agent routing). */
  resolveLog: EventLogResolver;
  /** Rule overrides; `{ enabled: false }` suppresses event-driven logging entirely. */
  policy?: EventLogPolicy;
}

export interface LogExtension {
  /** The bus this instance consumes. */
  readonly bus: AgentEventBus;
  /**
   * Attach this extension's sink to a log (root or subagent). Returns the detach function, which
   * releases the registry entry, the sink, and the log's seam binding — all three, because a
   * half-release (registry dropped, seam still bound) silently swallows entries.
   *
   * Bind every log the agent writes through — including subagent logs — because a subagent has no
   * extension runner of its own and would otherwise lose its file. The caller owns the returned
   * handle: `destroyAgent` releases the log it bound, so a subagent sink does not outlive its agent.
   */
  attachSink(log: AgentLog, options: AgentLogFileSinkOptions): () => void;
  /**
   * How many logs currently hold a sink from this extension.
   *
   * Exposed for the lifecycle assertions: a released agent must shrink this by exactly one, which
   * is the only externally visible evidence that a sink was released rather than merely detached
   * from the seam.
   */
  getAttachedSinkCount(): number;
  /** Start consuming bus events. Idempotent; a no-op when the policy disables logging. */
  start(): void;
  /** Stop consuming, release the exit-path registration, and detach every sink attached. */
  dispose(): void;
}

/**
 * Create the built-in log extension.
 *
 * Follows the built-in-extension convention (one canonical `createXxxExtension` factory) while
 * remaining a **stream consumer + sink provider** rather than an `ExtensionAPI`: it needs no tools,
 * commands or interceptors, and the seam cannot be a bus subscription (see the module note on the
 * privileged injection).
 */
export function createLogExtension(options: LogExtensionOptions): LogExtension {
  const bus = options.bus ?? createAgentEventBus("root");
  // The detach closure is the key, not a sink object: `attachSink` already returns exactly the
  // handle that releases a binding (registry entry + sink + seam), so storing a second, weaker
  // handle here is what would let the two diverge — `dispose()` detached the sink and forgot the
  // seam, and the log then wrote into a dead buffer while its entries were retained by nobody.
  const sinks = new Map<AgentLog, () => void>();
  let unsubscribe: (() => void) | null = null;
  // Process-exit path: the sink owns a flush timer, so a hard exit must land the pending batch
  // itself. Registered on the same guards that flush the active logs, and released with the
  // instance so a disposed extension never runs on `exit`.
  let unregisterExitFlush: (() => void) | null = null;
  let started = false;

  const flushSinksSync = (): void => {
    for (const log of sinks.keys()) log.flushSync();
  };

  return {
    bus,

    attachSink(log, sinkOptions) {
      // Re-pointing an already-attached log must release the previous binding first (its batch is
      // landed by `detach()`), including the seam side — otherwise the seam keeps feeding a sink
      // that is no longer in this registry.
      sinks.get(log)?.();
      const sink = createJsonlFileSink(sinkOptions);
      const detach = (): void => {
        if (sinks.get(log) !== detach) return; // superseded — nothing of ours to release
        sinks.delete(log);
        sink.detach();
        // Conditional: a superseded handle must not unbind the live binding (the `sinks.get` check
        // above covers this registry, the seam guard covers the seam itself).
        log.detachSink(sink.handleEntry);
      };
      sinks.set(log, detach);
      log.attachSink(sink);
      return detach;
    },

    start() {
      if (started) return;
      started = true;
      unsubscribe = bridgeTelemetryToAgentLog(bus, options.resolveLog, options.policy);
      unregisterExitFlush = registerExtensionExitFlush(flushSinksSync, { last: true });
    },

    getAttachedSinkCount: () => sinks.size,

    dispose() {
      unsubscribe?.();
      unsubscribe = null;
      unregisterExitFlush?.();
      unregisterExitFlush = null;
      started = false;
      // Release through the same handle `attachSink` returned: it detaches the sink *and* the
      // seam, so a disposed extension cannot leave a log bound to a dead sink (which would swallow
      // entries without retaining or writing them).
      for (const detach of [...sinks.values()]) detach();
      sinks.clear();
    },
  };
}
