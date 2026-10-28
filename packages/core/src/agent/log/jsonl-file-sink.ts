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

import { logEntrySchema } from "./schemas.js";

import type { AgentLogFileSinkOptions, LogEntry } from "../agent-log/types.js";

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
/** Default log file name inside the bound directory. */
export const DEFAULT_LOG_FILENAME = "agent.log";

export interface LogFileSink {
  handleEntry: (entry: LogEntry) => void;
  /** Awaitable flush of the pending batch. */
  flush: () => Promise<void>;
  /** Best-effort synchronous flush for exit paths that cannot await. */
  flushSync: () => void;
  /** Land the pending batch and stop the timer. Idempotent. */
  detach: () => void;
  /** Directory written to — **absent** on an inert sink, so callers never record a dead path. */
  dir?: string;
}

/** A sink that does nothing — used when the environment cannot write. */
function inertSink(): LogFileSink {
  const noop = (): void => {};
  return { handleEntry: noop, flush: async () => {}, flushSync: noop, detach: noop };
}

/** Build a JSONL file sink writing to `options.dir`. */
export function createJsonlFileSink(options: AgentLogFileSinkOptions): LogFileSink {
  let fs: ReturnType<typeof getEnv>["fs"] | null;
  try {
    // The owning runtime's env when supplied; ambient only for standalone/legacy callers.
    fs = (options.env ?? getEnv()).fs;
  } catch {
    return inertSink(); // CoreEnv not registered
  }
  const envFs = fs;
  const appendFile = envFs.appendFile;
  if (!appendFile) return inertSink(); // no append support

  const dir = options.dir;
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
  /** Whether the session-boundary divider has been decided for this sink. `false` means the
   * caller asked for a continuation (a temporary re-point), so no divider is ever written. */
  let boundaryWritten = options.sessionBoundary === false;

  /** Shift segments `{file}.{maxFiles-1}` → drop, ..., `{file}` → `{file}.1`, then truncate. */
  const rotate = async (): Promise<void> => {
    const oldest = `${filePath}.${maxFiles - 1}`;
    if (await envFs.exists(oldest)) await envFs.remove(oldest);
    for (let i = maxFiles - 2; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      if (await envFs.exists(from)) {
        const content = await envFs.readFile(from);
        await envFs.writeFile(to, content);
        await envFs.remove(from);
      }
    }
    if (await envFs.exists(filePath)) {
      const content = await envFs.readFile(filePath);
      await envFs.writeFile(`${filePath}.1`, content);
    }
    await envFs.writeFile(filePath, "");
  };

  const flushBatch = async (): Promise<void> => {
    if (buffer.length === 0) return;
    flushInFlight = true;
    const lines = buffer;
    buffer = [];
    try {
      await envFs.mkdir(dir);
      const existed = await envFs.exists(filePath);
      if (!existed) {
        await envFs.writeFile(filePath, "");
      }
      // Reused log file (session resumed/continued): mark the new launch with a clearly
      // visible divider before the first batch of this session.
      if (!boundaryWritten) {
        boundaryWritten = true;
        if (existed) {
          lines.unshift(`---------- ${new Date().toISOString()} new session ----------`);
        }
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
    } catch (error) {
      // Non-fatal, but not silent: put the batch back at the HEAD so the next flush retries in
      // order, and say why. A failed append used to vanish with no trace at all.
      buffer = [...lines, ...buffer];
      let dropped = 0;
      if (buffer.length > MAX_RETRY_BUFFER_LINES) {
        dropped = buffer.length - MAX_RETRY_BUFFER_LINES;
        buffer = buffer.slice(dropped);
      }
      console.error(
        `[agent] log batch write failed: ${errorMessage(error)}` +
          (dropped > 0 ? ` (dropped ${dropped} oldest buffered lines)` : "")
      );
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
      console.error(
        `[agent] log entry rejected by the persisted schema (${entry.level}/${entry.category}):`,
        parsed.error.issues[0]?.message
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
    } catch (error) {
      console.error(`[agent] log entry is not serializable (${entry.level}/${entry.category}):`, errorMessage(error));
      return;
    }
    schedule();
  };

  /**
   * Synchronous best-effort write of the pending buffer, for crash/exit paths that cannot await an
   * async flush. Requires sync fs primitives (`appendFileSync`); otherwise falls back to an async
   * flush. Skips rotation — the goal is to land the final lines, not to enforce size.
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
      if (!boundaryWritten) {
        boundaryWritten = true;
        if (envFs.existsSync?.(filePath)) {
          lines.unshift(`---------- ${new Date().toISOString()} new session ----------`);
        }
      }
      appendFileSync(filePath, lines.join("\n") + "\n");
    } catch {
      // Non-fatal: best-effort final flush on a crash path.
    }
  };

  return {
    handleEntry,
    flush,
    flushSync,
    dir,
    detach: () => {
      disposed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // If an async batch is in flight, leave the buffer for the queued flush. Otherwise land
      // it synchronously, then queue any remainder (a sync-unaware runtime).
      if (!flushInFlight) flushSync();
      void flush();
    },
  };
}
