import { createSequentialIdGenerator } from "../../utils/generate-id.js";
import { createJsonlFileSink } from "../log/jsonl-file-sink.js";

import { configuredLogLevel } from "./log-level-env.js";

import type { AgentLogFileSinkOptions, LogCategory, LogEntry, LogLevel, LogScope } from "./types.js";

// ============================================================================
// Log ID Generator
// ============================================================================

export const generateLogId = createSequentialIdGenerator("log");

/**
 * Entries retained while no sink is bound.
 *
 * Bootstrap logs before the session sink exists (`agent-factory.ts` emits the
 * extension load results and the bootstrap summary, then `AgentManager.createManagedAgent`
 * attaches the sink). With no retention those entries — including every extension
 * activation failure — were silently discarded. The buffer is drained into the first
 * sink that attaches, and capped so a session that never binds a sink (or binds one
 * only at the very end) cannot grow memory without bound.
 *
 * The cap only has to exceed a bootstrap's emission count. Measured (validate-bootstrap-log-binding:
 * one throwing extension + a documentation file + the search-directory note + the summary): **8 entries**, of which the
 * extension's own activation failure is one. 200 leaves two orders of magnitude of headroom for a
 * workspace with many extensions, so the cap is not the thing to raise if bootstrap ever grows —
 * the fix would be binding the sink earlier, not buffering more.
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
   * directory: core reads that value to place a subagent's log next to its parent's.
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

  private static readonly levelPriority: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(options?: { enabled?: boolean; minLevel?: LogLevel; scope?: LogScope }) {
    if (options?.enabled !== undefined) this.enabled = options.enabled;
    if (options?.minLevel) this.minLevel = options.minLevel;
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
    }
  ): LogEntry | null {
    if (!this.shouldLog(level)) return null;

    const entry: LogEntry = {
      scope: { ...this.scope },
      id: generateLogId(),
      timestamp: Date.now(),
      level,
      category,
      message,
    };

    if (options?.data) entry.data = options.data;
    if (options?.tags) entry.tags = options.tags;
    if (options?.event) entry.event = options.event;
    if (options?.run) entry.run = options.run;
    if (options?.error) {
      entry.error = {
        name: options.error.name,
        message: options.error.message,
        stack: options.error.stack,
      };
    }

    // Persistence-only: hand the entry to the attached sink, or retain it (bounded)
    // until one attaches. Bootstrap emits before the session sink exists, and those
    // entries are the ones that explain how bootstrap went.
    if (this.sinkEntry) {
      this.sinkEntry(entry);
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
    run?: string | null
  ): LogEntry | null {
    return this.log(level, category, message, { data, error, event: eventType, ...(run !== undefined ? { run } : {}) });
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
        sink.handleEntry({
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
        if (this.shouldLog(entry.level)) sink.handleEntry(entry);
      }
    }
    this.sinkEntry = sink.handleEntry;
    this.sinkFlush = sink.flush ?? null;
    this.sinkFlushSync = sink.flushSync ?? null;
    this.fileSinkDir = sink.dir ?? null;
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
   * Retained as seam state (rather than sink state) because core reads it to place a subagent's
   * log inside its parent session's directory.
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
    if (level) this.setMinLevel(level);
    const sink = createJsonlFileSink(options);
    this.attachSink(sink);
    return () => {
      void sink.detach();
      this.detachSink(sink.handleEntry);
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
}
