import { createSequentialIdGenerator } from "../../utils/generate-id.js";
import { truncateText } from "../../utils/text-truncation.js";
import { createJsonlFileSink } from "../log/jsonl-file-sink.js";
import { MAX_LOG_MESSAGE_CHARS, MAX_LOG_STACK_CHARS } from "../log/payload.js";
import { redactLogValue, redactSecrets } from "../log/redaction.js";

import { registerActiveAgentLog, unregisterActiveAgentLog } from "./lifecycle-guards.js";
import { configuredLogLevel } from "./log-level-env.js";

import type { AgentLogFileSinkOptions, LogCategory, LogEntry, LogLevel, LogScope } from "./types.js";

// ============================================================================
// Log ID Generator
// ============================================================================

export const generateLogId = createSequentialIdGenerator("log");

/**
 * Entries retained while no sink is bound.
 *
 * With today's construction order the window is SHORT: `agent-factory.ts` binds the JSONL sink
 * (`bindLogSink`) before `new AgentBootstrap(...).bootstrapRoot()`, so bootstrap logs do not touch
 * this buffer at all. What lands here is the earlier build window (`buildToolset` / `setEventBus`
 * diagnostics) plus embedded hosts that never attach a managed sink and call
 * `attachFileSink` themselves at the very end.
 *
 * The buffer is drained into the first sink that attaches, and capped so such a host cannot grow
 * memory without bound. 200 is headroom for build-time noise, not a measured bootstrap count — the
 * old "measured 8 bootstrap entries" note described a call order that no longer exists. If a
 * healthy workspace ever approaches the cap, the fix is binding the sink earlier, not a bigger cap.
 */
export const MAX_PENDING_LOG_ENTRIES = 200;

/** A sink the seam hands assembled log entries to. */
export interface LogSink {
  handleEntry: (entry: LogEntry) => void;
  /** Awaitable durability hook, used by `AgentLog.flush()`. */
  flush?: () => Promise<void>;
  /** Best-effort synchronous durability hook, used by exit paths. */
  flushSync?: () => void;
  /**
   * Directory this sink writes to, when it is a file sink. Surfaced by `getFileSinkDir()` — the
   * seam does not decide it, because a sink that cannot write (no `appendFile`) must not report a
   * directory.
   *
   * The timeline is FLAT (`<root>/.agents/logs/agent.log`, rotated in place): subagent entries go
   * to the same file with a `taskCallId` scope, so nothing places a child beside a parent any more.
   */
  dir?: string;
}

// ============================================================================
// AgentLog Class
// ============================================================================

/**
 * AgentLog - persistence-only event timeline for agent operations.
 *
 * Every accepted entry is serialized and streamed straight to the attached
 * file sink (JSONL, one entry per line). There is no queryable in-memory
 * history: the log file is the single source of log observability. Entries
 * emitted before a sink is bound are retained in a small bounded buffer and
 * drained into the first sink that attaches.
 *
 * Features:
 * 1. **Structured entries** - LogEntry with level, category, data, error, run id
 * 2. **Run scoping** - the run id travels on the event envelope; the seam never stores it
 * 3. **Disk persistence** - JSONL file sink with size-based rotation
 */
export class AgentLog {
  private enabled = true;
  private minLevel: LogLevel = "debug";

  /** Profile/task attribution stamped onto every assembled entry. */
  private scope: LogScope = { profile: "root" };

  /** Active file sink's per-entry consumer, or null when no sink is attached. */
  private sinkEntry: ((entry: LogEntry) => void) | null = null;

  /** Active sink's awaitable flush, or null when no sink is attached. */
  private sinkFlush: (() => Promise<void>) | null = null;

  /** Active sink's synchronous flush, or null when no sink is attached. */
  private sinkFlushSync: (() => void) | null = null;

  /**
   * Entries emitted before a sink was bound, in emission order. Drained into the
   * first sink that attaches, and bounded by {@link MAX_PENDING_LOG_ENTRIES}. Empty in
   * steady state — every entry goes straight to the sink once one is bound.
   */
  private pendingEntries: LogEntry[] = [];
  /** Entries dropped by the pending cap. Reported once when the buffer is drained. */
  private pendingDropped = 0;
  /** One line for the first entry whose construction threw (a broken `data` getter, etc.). */
  private entryBuildFailureReported = false;
  /** One line for the first sink whose `handleEntry` threw (a host/diagnostic sink bug). */
  private sinkFailureReported = false;

  /**
   * Report a sink that threw from `handleEntry`.
   *
   * Kept separate from {@link entryBuildFailureReported}: the two failures have different causes
   * (our builder vs. the host's sink) and used to share one boolean, so a sink bug permanently
   * silenced the construction diagnostic and vice versa.
   */
  private reportSinkFailure(error: unknown): void {
    if (this.sinkFailureReported) return;
    this.sinkFailureReported = true;
    console.warn("[agent] log sink threw while handling an entry; entries are still accepted:", error);
  }

  /**
   * Hand an entry to a sink without letting a host sink defect escape.
   *
   * The LIVE path and the pending-buffer DRAIN are two call sites of the same host callback; the
   * drain used to call `handleEntry` raw, so a throwing sink rejected `attachSink` and could abort
   * bootstrap — the exact failure the live-path guard was added for.
   */
  private safeHandle(handle: (entry: LogEntry) => void, entry: LogEntry): void {
    try {
      handle(entry);
    } catch (error) {
      this.reportSinkFailure(error);
    }
  }

  private static readonly levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  /** Set by the host explicitly; an env-level replay must not overwrite it. */
  private explicitMinLevel = false;

  constructor(options?: { enabled?: boolean; minLevel?: LogLevel; scope?: LogScope }) {
    if (options?.enabled !== undefined) this.enabled = options.enabled;
    if (options?.minLevel) {
      this.minLevel = options.minLevel;
      this.explicitMinLevel = true;
    }
    if (options?.scope) this.scope = options.scope;
  }

  // ============================================================================
  // Configuration
  // ============================================================================

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
    this.explicitMinLevel = true;
  }

  /**
   * Apply the process-level `AGENT_LOG_LEVEL` knob.
   *
   * Unlike {@link setMinLevel} this is advisory: a host that set a level explicitly keeps it, so a
   * later sink bind (a subagent, a session switch) cannot silently undo the host's choice.
   */
  applyEnvMinLevel(level: LogLevel): void {
    if (!this.explicitMinLevel) this.minLevel = level;
  }

  /**
   * Whether an entry at `level` would be kept.
   *
   * Exposed so a producer can skip building an expensive payload (the bridge used to
   * `JSON.stringify` every tool input/output BEFORE the seam dropped the row). Policy still owns
   * the decision; this only tells a caller whether it is worth constructing.
   */
  isLevelEnabled(level: LogLevel): boolean {
    return this.shouldLog(level);
  }

  /**
   * Set this agent's profile/task attribution for subsequent entries.
   */
  setScope(scope: LogScope): void {
    this.scope = scope;
  }

  private shouldLog(level: LogLevel): boolean {
    if (!this.enabled) return false;
    return AgentLog.levelPriority[level] >= AgentLog.levelPriority[this.minLevel];
  }

  // ============================================================================
  // Logging Methods
  // ============================================================================

  private log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    options?: {
      data?: Record<string, unknown>;
      error?: Error;
      tags?: string[];
      /** Originating bus event type (Event→Log bridge). */
      event?: string;
      /**
       * Run id from the originating event envelope. The envelope is the ONLY source: the seam keeps
       * no run state, so a consumer cannot disagree with the producer about which run an entry
       * belongs to (absent outside a run).
       */
      run?: string | null;
      /** Session the event was emitted for, from the same envelope (absent when unknown). */
      sessionId?: string | null;
    }
  ): LogEntry | null {
    if (!this.shouldLog(level)) return null;

    // Entry construction (redaction, truncation, a getter on `data`) runs on the agent's own path.
    // `sink.handleEntry` is guarded, but a direct writer (the subagent mirror, the extension
    // fallback) has no bus wildcard above it — one throwing getter must not turn a diagnostic into
    // a run failure.
    try {
      const entry: LogEntry = {
        scope: { ...this.scope },
        id: generateLogId(),
        timestamp: Date.now(),
        level,
        category,
        // Bounded HERE because this is the one builder every writer passes through. The Event→Log
        // bridge was the only guard, so the specialized handlers — `extension:log` (an extension's
        // arbitrary string), `session:diagnostic`, memory — could write a single JSONL line of any
        // size, and a provider body returned by an extension turned the timeline into an unreadable
        // blob. `data` is bounded by `redactLogValue`'s own cap (it is not routed through the
        // bridge's `summarizePayload`).
        message: truncateText(redactSecrets(message), MAX_LOG_MESSAGE_CHARS),
      };

      // The one builder every writer passes through: redact direct writers too, not just the bridge.
      if (options?.data) entry.data = redactLogValue(options.data) as Record<string, unknown>;
      if (options?.tags) entry.tags = options.tags.map((tag) => truncateText(redactSecrets(tag), 200));
      if (options?.event) entry.event = options.event;
      if (options?.run) entry.run = options.run;
      if (options?.sessionId) entry.sessionId = options.sessionId;
      if (options?.error) {
        entry.error = {
          name: options.error.name,
          // Bound at the ONE builder every writer passes through. The bridge had this, but the
          // specialized handlers (`compaction:*-error`, `session:diagnostic`, the subagent mirror)
          // wrote the provider's raw body here unmodified, so one failed summary produced a
          // multi-megabyte JSONL line on those paths.
          message: truncateText(redactSecrets(options.error.message), MAX_LOG_MESSAGE_CHARS),
          // Bounded too: the stack starts with `${name}: ${message}`, so leaving it raw undid the
          // message bound (a provider body in the message became one MB-scale line again).
          stack:
            options.error.stack === undefined
              ? undefined
              : truncateText(redactSecrets(options.error.stack), MAX_LOG_STACK_CHARS),
        };
      }

      // Persistence-only: hand the entry to the attached sink, or retain it (bounded)
      // until one attaches. Bootstrap emits before the session sink exists, and those
      // entries are the ones that explain how bootstrap went.
      if (this.sinkEntry) {
        // Separately guarded (`safeHandle`): `attachSink` accepts any `LogSink`, and a throwing sink
        // used to be caught by the CONSTRUCTION catch below — reported as "could not build log
        // entry" and, because that reporter fires once per process, every later entry vanished
        // silently. The pending-buffer DRAIN goes through the same helper.
        this.safeHandle(this.sinkEntry, entry);
      } else {
        this.pendingEntries.push(entry);
        if (this.pendingEntries.length > MAX_PENDING_LOG_ENTRIES) {
          // The cap drops the OLDEST entries — which at bootstrap are the earliest extension/MCP
          // failures, the ones a reader most needs. The loss itself is now recorded (see
          // `attachSink`), so "the log starts mid-bootstrap" is distinguishable from "nothing went
          // wrong".
          this.pendingEntries.shift();
          this.pendingDropped += 1;
        }
      }

      return entry;
    } catch (error) {
      // One diagnostic must not become the run failure. Report the first construction failure once
      // per process; a broken `data` getter would otherwise fail on every entry silently.
      if (!this.entryBuildFailureReported) {
        this.entryBuildFailureReported = true;
        console.warn(`[agent] could not build log entry (${level}/${category}):`, error);
      }
      return null;
    }
  }

  debug(category: LogCategory, message: string, data?: Record<string, unknown>, tags?: string[]): LogEntry | null {
    return this.log("debug", category, message, { data, tags });
  }

  info(category: LogCategory, message: string, data?: Record<string, unknown>, tags?: string[]): LogEntry | null {
    return this.log("info", category, message, { data, tags });
  }

  warn(category: LogCategory, message: string, data?: Record<string, unknown>, tags?: string[]): LogEntry | null {
    return this.log("warn", category, message, { data, tags });
  }

  error(
    category: LogCategory,
    message: string,
    error?: Error,
    data?: Record<string, unknown>,
    tags?: string[]
  ): LogEntry | null {
    return this.log("error", category, message, { data, error, tags });
  }

  /**
   * Write an entry stamped with the originating bus event type — the typed
   * Event→Log path (see {@link bridgeTelemetryToAgentLog}). Direct log calls
   * should use debug/info/warn/error instead.
   */
  eventEntry(
    level: LogLevel,
    category: LogCategory,
    eventType: string,
    message: string,
    data?: Record<string, unknown>,
    error?: Error,
    run?: string | null,
    sessionId?: string | null
  ): LogEntry | null {
    return this.log(level, category, message, {
      data,
      error,
      event: eventType,
      ...(run !== undefined ? { run } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
  }

  // ============================================================================
  // File Sink (disk persistence)
  // ============================================================================

  private fileSinkDir: string | null = null;

  /**
   * Attach a sink: entries are handed to `handleEntry` from here on, and the pending buffer
   * (bootstrap entries, bounded by {@link MAX_PENDING_LOG_ENTRIES}) is drained into it first, in
   * emission order. `sinkFlush` / `sinkFlushSync` are the sink's durability hooks used by the
   * seam's flush paths. Replaces any previous sink.
   */
  attachSink(sink: LogSink): void {
    // A replacement must land the previous sink's pending batch first: the seam re-points, it
    // cannot release the old sink, and a host that used `attachFileSink` (the embedded fallback)
    // before the manager bound its own would otherwise lose every line written in between.
    if (this.sinkEntry) this.sinkFlushSync?.();
    // Bind FIRST: a drain can synchronously trigger a writer (persist-error -> diagnostic ->
    // bridge -> log). With the sink assigned only at the end, such an entry landed in the just-
    // cleared buffer and was never drained by a second attach.
    this.sinkEntry = sink.handleEntry;
    this.sinkFlush = sink.flush ?? null;
    this.sinkFlushSync = sink.flushSync ?? null;
    this.fileSinkDir = sink.dir ?? null;
    // Drain entries emitted before this sink existed (bootstrap), before anything emitted from
    // here on — so binding a sink never loses the diagnostics that explain how the bind
    // happened. Cleared on drain: a later re-attach must not replay them.
    if (this.pendingEntries.length > 0 || this.pendingDropped > 0) {
      const retained = this.pendingEntries;
      const dropped = this.pendingDropped;
      this.pendingEntries = [];
      this.pendingDropped = 0;
      // Say that the buffer overflowed BEFORE replaying it: the dropped entries are the oldest,
      // so the marker is the first line the reader sees and explains the gap that follows.
      //
      // The marker needs a slot of its own, so the oldest SURVIVING entry goes too. That entry is
      // part of the gap the reader is being told about, and reporting only `dropped` made the count
      // disagree with the first id that actually survived. The marker is a `warn` like any other
      // entry, so the level knob applies to it (writing it unfiltered put a warn line in a file the
      // operator asked to contain only errors); when it is filtered out, no slot is consumed.
      const markerSlot = retained.length > 0 ? 1 : 0;
      const lostTotal = dropped + markerSlot;
      if (dropped > 0 && this.shouldLog("warn")) {
        this.safeHandle(sink.handleEntry, {
          scope: { ...this.scope },
          id: generateLogId(),
          timestamp: Date.now(),
          level: "warn",
          category: "system",
          message: `Log buffer overflowed before the session sink was bound; ${lostTotal} earliest ${
            lostTotal === 1 ? "entry was" : "entries were"
          } dropped (cap ${MAX_PENDING_LOG_ENTRIES}).`,
          data: { dropped: lostTotal, cap: MAX_PENDING_LOG_ENTRIES },
          tags: ["log-buffer"],
        });
        if (markerSlot > 0) retained.shift();
      }
      // The level is applied by whoever binds the persisted sink (the log extension calls
      // `setMinLevel` immediately before this), so the drain must honour it too: entries accepted
      // while the seam defaulted to `debug` used to land regardless of `AGENT_LOG_LEVEL`, making
      // the one volume knob ineffective exactly for the bootstrap diagnostics it was meant to
      // filter.
      for (const entry of retained) {
        if (this.shouldLog(entry.level)) this.safeHandle(sink.handleEntry, entry);
      }
    }
  }

  /**
   * Detach the active sink (used by the log extension's disposer).
   *
   * Pass the sink's `handleEntry` to make the detach conditional on *that* sink still being the
   * active one. Without it, a stale handle from a binding that has since been superseded would
   * unbind the live sink and silently swallow every later entry. Guarding here rather than at each
   * call site keeps `attachFileSink`'s handle and the log extension's detach on one implementation.
   */
  detachSink(ifStillBound?: (entry: LogEntry) => void): void {
    if (ifStillBound && this.sinkEntry !== ifStillBound) return;
    this.sinkEntry = null;
    this.sinkFlush = null;
    this.sinkFlushSync = null;
    this.fileSinkDir = null;
  }

  /**
   * Directory the active sink writes to, or null when none is attached.
   *
   * Retained as seam state for diagnostics/tests that need to know WHERE the timeline lives. It is
   * no longer used for placement: the timeline is one flat file per workspace.
   */
  getFileSinkDir(): string | null {
    return this.fileSinkDir;
  }

  /**
   * Convenience: attach this log's JSONL file sink at `options.dir`.
   *
   * The implementation lives in the log extension (`createJsonlFileSink`), but the handle is kept
   * on the seam so the module that owns the log still owns the one-call way to persist it — that is
   * what keeps the 76 call sites and the log validators independent of the extension wiring.
   * Prefer `createLogExtension(...).attachSink(log, options)` in production paths, which also
   * records the sink for teardown.
   *
   * Applies `AGENT_LOG_LEVEL` exactly like the extension path: this is the documented fallback for
   * embedded hosts without an agent manager, and leaving the level out here made the one volume
   * knob silently ineffective for them (every debug row landed). A later explicit `setMinLevel`
   * still wins.
   */
  attachFileSink(options: AgentLogFileSinkOptions): () => void {
    const level = configuredLogLevel();
    if (level) this.applyEnvMinLevel(level);
    // `attachSink` flushes the previous sink before re-pointing the seam (see its note): this is
    // the fallback path (embedded hosts call it directly), so the pending batch is landed there.
    const sink = createJsonlFileSink(options);
    // A null sink means the env cannot append. Leave the seam UNBOUND instead of attaching a no-op:
    // an inert sink drained the pending buffer into nothing, made `hasSink()` report true, and
    // suppressed both the "no sink was bound before teardown" warning and any persist error. An
    // unbound seam keeps the entries buffered (bounded) so a later sink can still receive them.
    if (!sink) return () => {};
    this.attachSink(sink);
    // The documented embedded-host fallback must join the crash/exit guards too. Production paths
    // register through `AgentLogBinding`, but a host that calls this directly had its final batch
    // (usually the fault that is killing the process) dropped on `process.on("exit")` because
    // `flushActiveAgentLogsSync()` iterates that registry. The Set is idempotent, so the binding's
    // own register is harmless.
    registerActiveAgentLog(this);
    return () => {
      void sink.detach().catch(() => undefined);
      // Unregister only while THIS sink is still the bound one: a host may attach a second sink
      // (the superseded handle is then inert), and unconditionally dropping the log from the
      // crash/exit registry made the live sink lose its final batch.
      const wasBound = this.sinkEntry === sink.handleEntry;
      this.detachSink(sink.handleEntry);
      if (wasBound) unregisterActiveAgentLog(this);
    };
  }

  /**
   * Flush buffered entries to the attached sink and await the write. No-op when
   * no sink is attached.
   */
  async flush(): Promise<void> {
    await this.sinkFlush?.();
  }

  /**
   * Synchronously flush buffered entries. Best-effort: when the runtime lacks sync fs primitives
   * (a remote CoreEnv) it falls back to an async write that an exit handler usually cannot
   * complete, so the final batch is not guaranteed on such a host. Safe to call from `process.on`
   * handlers and teardown paths; ordinary teardown still awaits `flush()`.
   */
  flushSync(): void {
    this.sinkFlushSync?.();
  }

  /** Whether any sink has been attached (false during a bootstrap that never reached binding). */
  hasSink(): boolean {
    return this.sinkEntry !== null;
  }

  /** Entries still retained because no sink has been attached (bootstrap diagnostics). */
  getPendingEntryCount(): number {
    return this.pendingEntries.length;
  }

  /**
   * Entries dropped because the pending buffer overflowed before any sink was bound.
   *
   * Reported at teardown when the log never got a sink at all: the overflow marker is written by
   * `attachSink`, so a log that never binds one would otherwise lose the count with the object.
   */
  getPendingDroppedCount(): number {
    return this.pendingDropped;
  }
}
