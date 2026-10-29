import { createSequentialIdGenerator } from "../../utils/generate-id.js";
import { createJsonlFileSink } from "../log/jsonl-file-sink.js";

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
 * The cap only has to exceed a bootstrap's emission count (~15 today); it is not a
 * history buffer, and nothing reads it back for queried entries.
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
 * 2. **Run scoping** - entries logged during an agent run share one `run` id
 * 3. **Disk persistence** - JSONL file sink with size-based rotation
 */
export class AgentLog {
  private enabled = true;
  private minLevel: LogLevel = "debug";

  /** Short run id stamped onto entries while an agent run is in flight. */
  private currentRun: string | null = null;

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
   * Set the active run id: entries logged while set are stamped with `run`.
   * Pass `null` to leave run scope (bootstrap/idle entries carry no `run`).
   */
  setRun(run: string | null): void {
    this.currentRun = run;
  }

  /** Set this agent's profile/task attribution for subsequent entries. */
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
    if (this.currentRun) entry.run = this.currentRun;
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
      if (this.pendingEntries.length > MAX_PENDING_LOG_ENTRIES) this.pendingEntries.shift();
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
    error?: Error
  ): LogEntry | null {
    return this.log(level, category, message, { data, error, event: eventType });
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
    if (this.pendingEntries.length > 0) {
      const retained = this.pendingEntries;
      this.pendingEntries = [];
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
   */
  attachFileSink(options: AgentLogFileSinkOptions): () => void {
    const sink = createJsonlFileSink(options);
    this.attachSink(sink);
    return () => {
      sink.detach();
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
