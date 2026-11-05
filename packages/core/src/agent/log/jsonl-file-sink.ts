/**
 * JSONL file sink for the log seam.
 *
 * Deliberately its own module, depending only on `env`, the local entry schema and the log entry
 * **types**: both the seam (`agent-log.ts`) and the log extension (`agent/log/extension.ts`) build
 * this sink, and routing it through either one would make the other import it and close a cycle
 * (`agent/agent-log ↔ agent/log`).
 *
 * The value-level direction is one way. This module imports `agent-log/` only for `LogEntry` /
 * `AgentLogFileSinkOptions` **types**; the schema it validates with is `./schemas.js`, which lives
 * here in `agent/log/` precisely so it does not become a second `agent-log` import — as a value that
 * would have been a runtime edge from `log/` into `agent-log/`, paired with `agent-log.ts`'s value
 * edge into this file. See the note in `schemas.ts`.
 *
 * Behaviour: one `LogEntry` per line, size-based rotation, writes coalesced behind a flush timer,
 * and a visible divider when re-attaching to a file that already has content (a resumed session
 * must not blend launches). Degrades silently when the environment lacks `appendFile` — the agent
 * must never fail because logging could not be wired up.
 */

import { getEnv } from "../../env";
import { utf8ByteLength } from "../../utils/bytes.js";
import { errorMessage } from "../../utils/errors.js";

import { sweepAgentLogs } from "./log-retention.js";
import { logEntrySchema } from "./schemas.js";

import type { ResolvedCoreEnv } from "../../env";
import type { AgentLogFileSinkOptions, LogEntry, LogPersistErrorInfo } from "../agent-log/types.js";

/** Rotate when the active file exceeds this size (5 MiB). */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** Keep at most this many rotated segments (including the active file). */
export const DEFAULT_LOG_MAX_FILES = 5;
/** Coalesce writes for this long before flushing (ms). */
export const DEFAULT_LOG_FLUSH_INTERVAL_MS = 250;
/**
 * Cap on the failed-batch retry buffer.
 *
 * The failure path puts the batch back at the HEAD and retries on the next tick. Without a bound,
 * a directory that stays unwritable (read-only, disk full, deleted) requeued every batch forever:
 * the log then grew without limit in memory — the one thing a non-fatal log write must not do —
 * and the run died from logging. Oldest lines are dropped first and the loss is reported.
 */
const MAX_RETRY_BUFFER_LINES = 2_000;
/**
 * Cap on the LIVE buffer, including a write that is slow rather than failing.
 *
 * The failure path had a bound; a slow `appendFile` (one HTTP request on a remote CoreEnv) did not.
 * A debug-level firehose could grow the buffer for the whole duration of that write.
 */
const MAX_LIVE_BUFFER_LINES = 5_000;
/** Consecutive automatic retries after a failed write before waiting for the next entry. */
const MAX_WRITE_RETRIES = 5;
/**
 * Minimum gap between persistence-failure reports.
 *
 * A permanently unwritable directory fails on every flush; without this, each attempt would emit a
 * diagnostic, which the log bridge would try to write, fail, and report again.
 */
const PERSIST_ERROR_REPORT_INTERVAL_MS = 60_000;
/** Default log file name inside the bound directory. */
export const DEFAULT_LOG_FILENAME = "agent.log";

export interface LogFileSink {
  handleEntry: (entry: LogEntry) => void;
  /** Awaitable flush of the pending batch. */
  flush: () => Promise<void>;
  /** Best-effort synchronous flush for exit paths that cannot await. */
  flushSync: () => void;
  /**
   * Land the pending batch and stop the timer. Idempotent.
   *
   * Awaitable on purpose: on a runtime without sync fs (a remote CoreEnv) the final batch can only
   * be written asynchronously, so a teardown that fires `detach()` and returns loses the tail.
   */
  detach: () => Promise<void>;
  /** Directory written to — **absent** on an inert sink, so callers never record a dead path. */
  dir?: string;
}

/** A sink that does nothing — used when the environment cannot write. */
function inertSink(): LogFileSink {
  const noop = (): void => {};
  return { handleEntry: noop, flush: async () => {}, flushSync: noop, detach: async () => {} };
}

/** Build a JSONL file sink writing to `options.dir`. */
export function createJsonlFileSink(options: AgentLogFileSinkOptions): LogFileSink {
  let env: ResolvedCoreEnv;
  try {
    // The owning runtime's env when supplied; ambient only for standalone/legacy callers.
    env = options.env ?? getEnv();
  } catch {
    return inertSink(); // CoreEnv not registered
  }
  const envFs = env.fs;
  const appendFile = envFs.appendFile;
  if (!appendFile) return inertSink(); // no append support

  const dir = options.dir;
  // Age-based retention for the whole log root (once per process per workspace). The active file is
  // kept by mtime, not by a directory exemption, so no `keepDir` is needed now that the timeline is
  // flat (legacy session subdirectories are still swept).
  void sweepAgentLogs(env);
  const filename = options.filename ?? DEFAULT_LOG_FILENAME;
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_LOG_MAX_FILES;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_LOG_FLUSH_INTERVAL_MS;
  const filePath = `${dir}/${filename}`;

  let buffer: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Serializes async flushes; a second flush must not overtake an older batch. */
  let flushChain: Promise<void> = Promise.resolve();
  /** True while `flushBatch` owns the buffer. `flushSync` must yield to it. */
  let flushInFlight = false;
  /** Consecutive failed writes; the retry timer is re-armed only up to a small cap. */
  let consecutiveFailures = 0;
  /** Last time a persistence failure was reported to the session (see the throttle constant). */
  let lastPersistErrorAt = 0;

  /**
   * Surface a persistence failure to the owning session, throttled.
   *
   * `console.error` stays (it is the only channel before an agent exists), but it is not a failure
   * signal a host can observe — so the sink also reports through the injected callback, which the
   * log extension turns into a `session:diagnostic`.
   */
  let lastEntryErrorAt = 0;
  /** Throttle per-entry schema/serialize reports (write-path has its own interval). */
  const reportEntryError = (message: string, info: Omit<LogPersistErrorInfo, "consecutiveFailures">): void => {
    const now = Date.now();
    if (now - lastEntryErrorAt >= PERSIST_ERROR_REPORT_INTERVAL_MS) {
      lastEntryErrorAt = now;
      console.error(message);
    }
    reportPersistError(info);
  };

  const reportPersistError = (info: Omit<LogPersistErrorInfo, "consecutiveFailures">): void => {
    const now = Date.now();
    if (now - lastPersistErrorAt < PERSIST_ERROR_REPORT_INTERVAL_MS) return;
    lastPersistErrorAt = now;
    try {
      options.onPersistError?.({ ...info, consecutiveFailures });
    } catch {
      // A reporter that throws must not turn a diagnostic into a failed run.
    }
  };

  /**
   * Move one log segment.
   *
   * `rename` is atomic and — the reason it matters here — never truncates a path another writer may
   * be appending to. The copy path (read → write → remove) is the fallback for hosts whose CoreEnv
   * has no `rename`; it is equivalent for the shifted segments, which nothing else writes.
   */
  const moveSegment = async (from: string, to: string, options: { active?: boolean } = {}): Promise<void> => {
    if (envFs.rename) {
      await envFs.rename(from, to);
      return;
    }
    const content = await envFs.readFile(from);
    await envFs.writeFile(to, content);
    if (!options.active) {
      await envFs.remove(from);
      return;
    }
    // The ACTIVE file may be appended to concurrently (`flushSync` on the exit path writes while
    // an async batch owns the rotation). Removing it after the copy would delete those bytes, so
    // re-read and leave only what arrived after the copied prefix in the active file. A genuine
    // atomic move is impossible without `rename`; this narrows the loss window from the whole copy
    // to the gap between the second read and the write, and never deletes unrecognized content.
    const current = await envFs.readFile(from);
    if (current === content) {
      await envFs.remove(from);
      return;
    }
    if (current.startsWith(content)) {
      await envFs.writeFile(from, current.slice(content.length));
      return;
    }
    // Replaced by something we did not read (or a concurrent truncation): leave it alone.
  };
  /**
   * Shift segments `{file}.{maxFiles-1}` → drop, ..., `{file}` → `{file}.1`.
   *
   * The active file is MOVED, not read + truncated. The old tail (`writeFile(filePath, "")`) is what
   * made a concurrent `flushSync` lose its batch: an exit-path append landing between the read and
   * the truncate was wiped. With a move, an append that lands before the rename is preserved in the
   * rotated segment and one that lands after creates a fresh active file — neither is lost.
   *
   * `maxFiles === 1` means "keep only the active file", so there is no segment to preserve; that case
   * still truncates in place (a host that asked for one file has accepted rotation by discard).
   */
  const rotate = async (): Promise<void> => {
    // `maxFiles: 1` means "keep only the active file". The generic shift still wrote
    // `agent.log.1` (its `oldest` was `.0` and its loop did not run), so a host that asked for
    // one file silently kept two.
    if (maxFiles <= 1) {
      await envFs.writeFile(filePath, "");
      return;
    }
    const oldest = `${filePath}.${maxFiles - 1}`;
    if (await envFs.exists(oldest)) await envFs.remove(oldest);
    for (let i = maxFiles - 2; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      if (await envFs.exists(from)) await moveSegment(from, `${filePath}.${i + 1}`);
    }
    if (await envFs.exists(filePath)) await moveSegment(filePath, `${filePath}.1`, { active: true });
  };

  const flushBatch = async (): Promise<void> => {
    if (buffer.length === 0) return;
    flushInFlight = true;
    const lines = buffer;
    buffer = [];
    try {
      await envFs.mkdir(dir);
      if (!(await envFs.exists(filePath))) {
        await envFs.writeFile(filePath, "");
      }
      const content = lines.join("\n") + "\n";
      const contentBytes = utf8ByteLength(content);
      // Rotate when the active file already meets maxBytes, or when the pending batch would push
      // it past the limit — so a large batch never leaves the active file over budget. Size comes
      // from stat (restart-safe).
      let currentBytes = 0;
      try {
        currentBytes = (await envFs.stat(filePath)).size;
      } catch {
        currentBytes = 0;
      }
      if (currentBytes > 0 && currentBytes + contentBytes >= maxBytes) {
        await rotate();
      }
      await appendFile(filePath, content);
      consecutiveFailures = 0;
    } catch (error) {
      // Non-fatal, but not silent: put the batch back at the HEAD so the next flush retries in
      // order, and say why. A failed append used to vanish with no trace at all.
      // A failed append may have written a prefix of the batch (ENOSPC/EIO mid-write), and the
      // whole batch is retried, so that prefix can appear twice. Knowing exactly how much landed
      // needs the pre-write file size (a stat on every flush); for a diagnostic log, a duplicated
      // line is preferable to losing the tail, so this is a deliberate trade-off.
      buffer = [...lines, ...buffer];
      let dropped = 0;
      if (buffer.length > MAX_RETRY_BUFFER_LINES) {
        dropped = buffer.length - MAX_RETRY_BUFFER_LINES;
        buffer = buffer.slice(dropped);
      }
      consecutiveFailures += 1;
      reportPersistError({ stage: "write", error: errorMessage(error), dropped });
      if (consecutiveFailures <= MAX_WRITE_RETRIES) {
        console.error(
          `[agent] log batch write failed: ${errorMessage(error)}` +
            (dropped > 0 ? ` (dropped ${dropped} oldest buffered lines)` : "")
        );
        // The timer that fired this flush was cleared and nothing else re-arms it, so without
        // this the final batch (often the fault lines) sat in memory until the next entry —
        // exactly when a quiet session needs the record. Bounded, so a permanently unwritable
        // directory stops retrying instead of logging forever.
        schedule();
      } else if (consecutiveFailures === MAX_WRITE_RETRIES + 1) {
        console.error(
          `[agent] log write failed ${consecutiveFailures} times in a row; buffered lines are dropped at the cap and writing resumes on the next entry`
        );
      }
    } finally {
      flushInFlight = false;
    }
  };

  const flush = (): Promise<void> => {
    // Chain rather than run concurrently. The buffer is captured by `flushBatch` when the
    // chained turn actually starts, so a queued turn writes the newest batch and an older
    // in-flight turn cannot be overtaken by a newer one.
    const run = flushChain.then(flushBatch);
    flushChain = run.catch(() => undefined);
    return run;
  };

  const schedule = (): void => {
    if (timer || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
  };

  const handleEntry = (entry: LogEntry): void => {
    if (disposed) return;
    // The persisted schema is the last gate before the bytes: an entry outside it is not written,
    // because a caller reading the file back cannot tell "this entry is malformed" from "this
    // never happened" once it is on disk. Reported, not thrown — the sink is on the agent's path.
    //
    // ⚠️ The cost is that a new `LogCategory` must be added to *both* the `LogCategory` union and
    // `schemas.ts`'s list; missing the second now drops the entries instead of writing them.
    const parsed = logEntrySchema.safeParse(entry);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? "invalid entry";
      reportEntryError(
        `[agent] log entry rejected by the persisted schema (${entry.level}/${entry.category}): ${reason}`,
        { stage: "schema", error: reason, dropped: 0 }
      );
      return;
    }
    // Serialize inside the guard, not after it: `JSON.stringify` throws on a `BigInt`, a circular
    // reference, or a `toJSON` that throws, and this function is called *synchronously* from
    // `AgentLog.log()` on the agent's own path. An unguarded throw would turn a diagnostic into a
    // run failure — the one thing log persistence must never do. Reported, never thrown.
    try {
      // Write the validated object. The schema is strict: an unknown top-level field rejects the
      // whole entry (safeParse above), so `parsed.data` is never a silently-stripped copy.
      buffer.push(JSON.stringify(parsed.data));
      if (buffer.length > MAX_LIVE_BUFFER_LINES) {
        const dropped = buffer.length - MAX_LIVE_BUFFER_LINES;
        buffer = buffer.slice(dropped);
        reportPersistError({ stage: "write", error: "live buffer cap reached", dropped });
      }
    } catch (error) {
      reportEntryError(
        `[agent] log entry is not serializable (${entry.level}/${entry.category}): ${errorMessage(error)}`,
        { stage: "serialize", error: errorMessage(error), dropped: 0 }
      );
      return;
    }
    schedule();
  };

  /**
   * Synchronous best-effort write of the pending buffer, for crash/exit paths that cannot await an
   * async flush.
   *
   * Requires sync fs primitives (`appendFileSync`). When the env has none (a remote CoreEnv exposes
   * only async fs), there is no way to land the batch before an exit handler returns, so this
   * degrades to an async flush that an exit will usually not complete — it does NOT promise the
   * final lines. The ordinary teardown path (`detach`) calls `flush()` afterwards, so only a hard
   * crash on such a runtime loses the tail. Skips rotation either way: the goal is to land the
   * final lines, not to enforce size.
   */
  const flushSync = (): void => {
    if (buffer.length === 0) return;
    // An async batch may own the write path. Skipping here (the old behaviour) meant an exit during
    // that window dropped the buffer entirely — including the `Fatal …` line the exit guard writes.
    // At exit the in-flight batch is not guaranteed to land at all, so landing the newer lines
    // synchronously is the only way not to lose them. The trade-off is that on a DESTROY (process
    // survives) the still-in-flight older batch can land after these newer lines; losing entries
    // silently is worse than a rare ordering inversion in a crash log.
    const appendFileSync = envFs.appendFileSync;
    if (!appendFileSync) {
      void flush();
      return;
    }
    const lines = buffer;
    buffer = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      envFs.mkdirSync?.(dir);
      appendFileSync(filePath, lines.join("\n") + "\n");
      consecutiveFailures = 0;
    } catch (error) {
      // Put the batch back so `detach()`'s follow-up async flush can land it while the process is
      // still alive (a hard crash has lost it either way). The previous swallow made a failed
      // final write indistinguishable from success and left the buffer empty. Bounded like the
      // async path; reported, never thrown.
      buffer = [...lines, ...buffer];
      if (buffer.length > MAX_RETRY_BUFFER_LINES) {
        buffer = buffer.slice(buffer.length - MAX_RETRY_BUFFER_LINES);
      }
      console.error(`[agent] log sync flush failed: ${errorMessage(error)}`);
      reportPersistError({ stage: "write-sync", error: errorMessage(error), dropped: 0 });
    }
  };

  return {
    handleEntry,
    flush,
    flushSync,
    dir,
    detach: async () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // If an async batch is in flight, leave the buffer for the queued flush. Otherwise land
      // it synchronously, then await the remainder (a sync-unaware runtime — a remote CoreEnv —
      // has no other way to get its final lines out).
      if (!flushInFlight) flushSync();
      await flush();
    },
  };
}
