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
 * 1. **The bus** — every observable event, turned into entries by the rule table
 *    (`event-log-rules.ts`). This is the ONE recording path: a call site decides *what happened* by
 *    emitting an event, and the table decides whether, at what level, and in which category it
 *    reaches the file. `validate:no-direct-agent-log` keeps it that way.
 * 2. **The seam** — `AgentLog.debug/info/warn/error/eventEntry`, reached by the bridge itself and by
 *    the pre-registration window (bootstrap facts resolve a log through the manager before the
 *    agent is registered). It exists so a fact can be recorded when
 *    no bus consumer can see it yet — not as a general write path.
 *
 * The seam is a **privileged dependency injection**, not a bus event: a log-entry event would have
 * to be deliverable to this extension, but internal events are withheld from both wildcard delivery
 * and the observation surface, and an event this extension emits to feed itself is exactly the
 * recursion the internal classification exists to prevent. Injection has that property by
 * construction — the sink never emits.
 *
 * Subagents matter for the shape of this module: they have no extension runner (only roots get one,
 * `agent-factory.ts`), yet they must log. Root and child `AgentLog`s therefore attach to the SAME
 * workspace file, with `scope`/`sessionId` keeping the rows attributable; the extension ref-counts
 * the per-file sink and reuses it across every agent.
 */

import { createAgentEventBus } from "../agent-event-bus";
import { registerExtensionExitFlush } from "../agent-log/lifecycle-guards.js";
import { configuredLogLevel } from "../agent-log/log-level-env.js";

import { bridgeTelemetryToAgentLog } from "./event-log-bridge.js";
import { createJsonlFileSink, DEFAULT_LOG_FILENAME, type LogFileSink } from "./jsonl-file-sink.js";

// Registered with the process-exit guards so a hard exit lands pending batches; see the module note.

import type { AgentEventBus } from "../agent-event-bus";
import type { EventLogPolicy, EventLogResolver } from "./event-log-bridge.js";
import type { AgentLog } from "../agent-log/agent-log.js";
import type { AgentLogFileSinkOptions, LogPersistErrorInfo } from "../agent-log/types.js";

export type { EventLogPolicy, EventLogResolver, EventLogRule } from "./event-log-bridge.js";

interface SharedSinkEntry {
  sink: LogFileSink;
  refs: number;
  /**
   * Per-log persist-error reporters. A shared sink must report through the manager that owns a
   * LIVE log, not whichever manager happened to create the sink (that manager's registry may not
   * contain the failing log, and its diagnostic would be dropped).
   */
  reporters: Map<AgentLog, (info: LogPersistErrorInfo) => void>;
}

/**
 * Process-wide sink registry: one physical sink per workspace FILE, not per manager.
 *
 * Two runtimes over the same workspace are supported (`sharedSessionOwnership`), and both write
 * `.agents/logs/agent.log`. Per-manager maps would give each its own buffer/timer/rotation over one
 * file; the registry keys the sink by workspace identity so rotation has a single writer.
 */
const workspaceSinks = new Map<string, SharedSinkEntry>();
const envSinkIds = new WeakMap<object, number>();
let nextEnvSinkId = 0;

function sinkKey(options: AgentLogFileSinkOptions): string {
  const file = `${options.dir}\0${options.filename ?? DEFAULT_LOG_FILENAME}`;
  const env = options.env;
  if (!env) return `ambient:${file}`;
  if (env.remote === true) {
    // A remote env is one connection: two servers may report the same `rootPath` while being
    // different filesystems, so identity is the only safe discriminator.
    let id = envSinkIds.get(env);
    if (id === undefined) {
      id = ++nextEnvSinkId;
      envSinkIds.set(env, id);
    }
    return `remote:${id}:${file}`;
  }
  return `local:${env.rootPath}:${file}`;
}

export interface LogExtensionOptions {
  /** Bus whose events become entries. Defaults to a fresh root bus (standalone use). */
  bus?: AgentEventBus;
  /** Resolve the log an event belongs to (per-agent routing). */
  resolveLog: EventLogResolver;
  /** Rule overrides; `{ enabled: false }` suppresses event-driven logging entirely. */
  policy?: EventLogPolicy;
  /**
   * Report a sink persistence failure for `log`.
   *
   * Wired by the manager to that agent's `session:diagnostic`: the seam has no route to the session
   * (and must not gain one), so without this a failing disk looks like a healthy agent with an
   * empty `agent.log`. The sink throttles the reports.
   */
  onPersistError?: (log: AgentLog, info: LogPersistErrorInfo) => void;
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
 * `AGENT_LOG_LEVEL=debug|info|warn|error` — the one volume knob for the persisted timeline.
 *
 * Parsed by `agent-log/log-level-env.ts` (shared with `AgentLog.attachFileSink`, the embedded-host
 * fallback, so the knob cannot apply on one binding path and not the other).
 */

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
  /**
   * One physical sink per log file.
   *
   * The timeline is workspace-scoped now, so root and subagent logs, and every session the agent
   * switches through, all append to the same file. Creating a sink per `AgentLog` would give each
   * its own buffer/timer and interleave batches; the registry keeps one buffer and ref-counts the
   * bindings so the file closes only after the last agent log detaches.
   */
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
      // Apply the process-level level here: the sink is the first point at which a log is bound to
      // persisted output, and the seam is shared by every agent in the process.
      const level = configuredLogLevel();
      if (level) log.setMinLevel(level);
      // Re-pointing an already-attached log must release the previous binding first.
      sinks.get(log)?.();

      const key = sinkKey(sinkOptions);
      let entry = workspaceSinks.get(key);
      if (!entry) {
        // The owner set is filled below; the callback resolves it lazily so a failure is reported
        // through a LIVE log rather than whichever log happened to create the sink.
        const candidate: SharedSinkEntry = {
          sink: undefined as unknown as LogFileSink,
          refs: 0,
          reporters: new Map(),
        };
        candidate.sink = createJsonlFileSink({
          ...sinkOptions,
          ...(options.onPersistError
            ? {
                onPersistError: (info: LogPersistErrorInfo) => {
                  // Resolve at failure time: the first attached log may already be detached.
                  const report = candidate.reporters.values().next().value;
                  report?.(info);
                },
              }
            : {}),
        });
        entry = candidate;
        workspaceSinks.set(key, entry);
      }
      entry.refs += 1;
      if (options.onPersistError) {
        const reporter = (info: LogPersistErrorInfo): void => options.onPersistError?.(log, info);
        entry.reporters.set(log, reporter);
      }
      const shared = entry;

      const detach = (): void => {
        if (sinks.get(log) !== detach) return; // superseded — nothing of ours to release
        sinks.delete(log);
        shared.reporters.delete(log);
        log.detachSink(shared.sink.handleEntry);
        shared.refs -= 1;
        if (shared.refs <= 0) {
          workspaceSinks.delete(key);
          // `detach` is async on purpose (a remote CoreEnv can only write asynchronously); the
          // caller of this handle is synchronous, so at least never leave the rejection unhandled.
          void shared.sink.detach().catch(() => undefined);
        }
      };
      sinks.set(log, detach);
      log.attachSink(shared.sink);
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
