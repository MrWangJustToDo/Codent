/**
 * Durable per-job log for background shell jobs.
 *
 * The in-memory registry is head-trimmed (see `command-job-registry.ts`) and is
 * not reachable from surfaces that can only read files — the code-mode sandbox
 * exposes `read_file` but not `get_command_output`. Background output is
 * therefore also tee'd to `.agents/cache/command-jobs/<jobId>.log`:
 *
 * - one file per job, chunks appended in arrival order, stderr lines marked
 * - header on creation, terminal footer once the job ends (no footer = running)
 * - **unbounded**: background output is always written to the file, never sized
 *   against a cap and never truncated. Disk growth is bounded by the 24 h stale
 *   sweep plus deletion with the job record, not by cutting the file, so
 *   `read_file` offsets stay valid for as long as the file exists
 * - every failure degrades silently (no path, no throw): logging must never
 *   affect the command result
 *
 * Deleting the file belongs to the job record (registry eviction / teardown);
 * files left behind by an earlier run are swept opportunistically by the shared
 * age sweep (`stale-file-sweep.ts`).
 */

import { getEnv } from "../../../../../env";
import { registerExtensionExitFlush } from "../../../../agent-log/lifecycle-guards.js";
import { COMMAND_JOB_CACHE_DIR, sweepWorkspaceCache } from "../../../shared/cache/workspace-cache.js";

import type { CoreEnvFs, ResolvedCoreEnv } from "../../../../../env";
import type { StaleSweepOptions } from "../../../shared/cache/stale-sweep.js";

// ============================================================================
// Constants
// ============================================================================

// The directory and the age are defined once for every workspace cache — see
// `tools/shared/cache/workspace-cache.ts` (logs and records share the directory, separated by suffix).
/** Buffered write interval — batches noisy streams into fewer filesystem writes. */
export const JOB_LOG_FLUSH_INTERVAL_MS = 250;

/** Per-line marker keeping stderr distinguishable from stdout in the log. */
const STDERR_MARK = "[stderr] ";

// ============================================================================
// Paths
// ============================================================================

/** Workspace-relative path of a job's log file. */
export function jobLogPath(jobId: string): string {
  return `${COMMAND_JOB_CACHE_DIR}/${jobId}.log`;
}

// ============================================================================
// Writer
// ============================================================================

export interface CommandJobLogWriter {
  readonly path: string;
  appendStdout(chunk: string): void;
  appendStderr(chunk: string): void;
  /** Flush pending output and append the terminal footer. Nothing is written after this. */
  finalize(status: string, exitCode: number | null, endedAt: number): Promise<void>;
  /** Stop buffering and delete the file (job eviction / teardown). */
  remove(): Promise<void>;
  /**
   * Synchronous best-effort flush for the process-exit path (there is no `await` there).
   *
   * A background job's log is the only evidence a hard exit left behind, and "no footer means the
   * job is still running" is a contract the agent reads back. Losing the last 250 ms of output (or
   * the footer) makes a finished job look live. Degrades to an async flush when the host has no
   * synchronous fs primitives.
   */
  flushSync?(): void;
}

export interface CommandJobLogWriterOptions {
  jobId: string;
  command: string;
  startedAt: number;
  /** Called when a write failed and this job's logging was disabled. */
  onDisabled?: () => void;
  /** Owning runtime's env, so the log lands under the runtime root. Ambient when omitted. */
  env?: ResolvedCoreEnv;
}

class FileJobLogWriter implements CommandJobLogWriter {
  readonly path: string;

  private readonly fs: CoreEnvFs;
  private readonly env: ResolvedCoreEnv | undefined;
  private readonly appendFile: (path: string, content: string) => Promise<void>;
  private readonly header: string;
  private readonly onDisabled: (() => void) | undefined;

  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private created = false;
  private finalized = false;
  private stopped = false;
  /** Whether the next stderr line begins at a line boundary (chunks split mid-line). */
  private stderrAtLineStart = true;
  /** Removes this writer's process-exit flush (see `flushSync`). */
  private exitFlushDisposer: (() => void) | undefined;

  constructor(options: CommandJobLogWriterOptions & { fs: CoreEnvFs }) {
    this.fs = options.fs;
    this.env = options.env;
    this.onDisabled = options.onDisabled;
    // The capability check happens in `createCommandJobLogWriter`, so the
    // assertion below only documents what the type cannot express.
    this.appendFile = options.fs.appendFile as (path: string, content: string) => Promise<void>;
    this.path = jobLogPath(options.jobId);
    this.header = `# ${options.command}\n# started ${new Date(options.startedAt).toISOString()}\n`;
    // A background job's log is the durable evidence of how it ended, and the 250ms batch timer is
    // lost on a hard exit. Registered in the SAME exit path the agent log uses — it writes the file
    // directly rather than through the logger, so the two registrations do not depend on each
    // other's order — and owned per job so eviction/finalize can unregister it.
    this.exitFlushDisposer = registerExtensionExitFlush(() => this.flushSync(), {
      ownerId: `job-log:${this.path}`,
    });
  }

  appendStdout(chunk: string): void {
    if (!chunk) return;
    this.enqueue(chunk);
  }

  appendStderr(chunk: string): void {
    if (!chunk) return;
    this.enqueue(this.markStderrLines(chunk));
  }

  async finalize(status: string, exitCode: number | null, endedAt: number): Promise<void> {
    if (this.finalized || this.stopped) return;
    this.finalized = true;
    const footer = `[exit ${exitCode ?? "n/a"} · ${status} · finished ${new Date(endedAt).toISOString()}]\n`;
    if (this.pending.length > 0 && !this.pending[this.pending.length - 1].endsWith("\n")) {
      this.pending.push("\n");
    }
    this.pending.push(footer);
    this.clearTimer();
    await this.flush();
    // The file is complete: release the process-exit closure. A parked session evicts finished jobs
    // without calling `remove()`, and the registry is a process-global Map — an undisposed closure
    // per job would accumulate (with its buffer and fs binding) for the life of the process.
    this.exitFlushDisposer?.();
    this.exitFlushDisposer = undefined;
  }

  /**
   * Synchronous best-effort flush for the exit path.
   *
   * Land the buffered batch with the host's sync primitives when it has them, otherwise fall back to
   * the async flush an exit will usually not complete.
   *
   * Only an ALREADY-created file is written here. Creating it would race the async path's truncating
   * `writeFile(header)` (a sync write landing inside that await is then erased), so the first-batch
   * window falls back to the async flush. Hard-exit coverage therefore starts at the first tick
   * (≤250ms), not at the very first chunk — write order is not something the exit path may trade.
   */
  flushSync(): void {
    if (this.stopped) return;
    this.clearTimer();
    const appendFileSync = this.fs.appendFileSync;
    if (!appendFileSync || !this.created) {
      void this.flush();
      return;
    }
    const batch = this.pending;
    this.pending = [];
    if (batch.length === 0) return;
    try {
      appendFileSync(this.path, batch.join(""));
    } catch {
      // Put the batch back so the ordinary teardown flush can still land it.
      this.pending = [...batch, ...this.pending];
    }
  }

  async remove(): Promise<void> {
    this.stopped = true;
    this.finalized = true;
    this.pending = [];
    this.clearTimer();
    this.exitFlushDisposer?.();
    this.exitFlushDisposer = undefined;
    // Let an in-flight flush settle before deleting: otherwise its append could
    // recreate the file right after removal.
    await this.chain.catch(() => {});
    await removeJobLog(this.path, this.env);
  }

  /**
   * Prefix every stderr line with {@link STDERR_MARK}. Chunk boundaries are
   * tracked so a chunk splitting a line does not produce a broken marker; empty
   * lines are left unmarked.
   */
  private markStderrLines(chunk: string): string {
    const parts = chunk.split("\n");
    let result = "";
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const line = parts[i];
      if (this.stderrAtLineStart && line.length > 0) {
        result += STDERR_MARK;
        this.stderrAtLineStart = false;
      }
      result += line;
      if (!isLast) {
        result += "\n";
        this.stderrAtLineStart = true;
      }
    }
    return result;
  }

  private enqueue(text: string): void {
    if (this.stopped || this.finalized) return;
    this.pending.push(text);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, JOB_LOG_FLUSH_INTERVAL_MS);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Serialized flush: header first (truncating), then the buffered batch. */
  private flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    this.chain = this.chain
      .then(async () => {
        if (this.stopped) return;
        try {
          if (!this.created) {
            await this.fs.mkdir(COMMAND_JOB_CACHE_DIR);
            // Re-check after the await: an exit-path `flushSync` may have created and written the
            // file while we were waiting for mkdir. Truncating then would erase its batch.
            if (!this.created) {
              await this.fs.writeFile(this.path, this.header);
              this.created = true;
            }
          }
          if (batch.length > 0) {
            await this.appendFile(this.path, batch.join(""));
          }
        } catch {
          this.stopSilently();
        }
      })
      .catch(() => this.stopSilently());
    return this.chain;
  }

  private stopSilently(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = [];
    this.clearTimer();
    this.exitFlushDisposer?.();
    this.exitFlushDisposer = undefined;
    // Let callers stop advertising a log path that will never be written.
    this.onDisabled?.();
  }
}

/**
 * Create a log writer for a background job, or `null` when this host cannot
 * append to files (logging then degrades to today's memory-only behaviour).
 */
export function createCommandJobLogWriter(options: CommandJobLogWriterOptions): CommandJobLogWriter | null {
  let fs: CoreEnvFs;
  try {
    // The owning runtime's env when supplied; ambient only for standalone/legacy callers.
    fs = (options.env ?? getEnv()).fs;
  } catch {
    return null; // CoreEnv not registered (validators, teardown) — degrade
  }
  if (!fs.appendFile) return null;
  return new FileJobLogWriter({ ...options, fs });
}

/** Best-effort delete of a job log. */
export async function removeJobLog(path: string, env?: ResolvedCoreEnv): Promise<void> {
  try {
    const fs = (env ?? getEnv()).fs;
    if (await fs.exists(path)) await fs.remove(path);
  } catch {
    // Non-fatal — stale logs are swept later.
  }
}

// ============================================================================
// Stale sweep
// ============================================================================

/**
 * Delete logs whose job can no longer be queried (older than `MAX_JOB_LOG_AGE_MS` in
 * `tools/shared/cache/workspace-cache.ts`). Runs at most once per process unless forced.
 * Age-based on purpose: concurrent sessions may share a workspace root, and a
 * live session's logs are never older than the threshold. Shares its walk with
 * the tool-output spill sweep (`stale-file-sweep.ts`) — same policy, and the
 * `.log` suffix keeps the two caches from ever deleting each other's files.
 */
export function sweepStaleJobLogs(options?: StaleSweepOptions, env?: ResolvedCoreEnv): Promise<number> {
  return sweepWorkspaceCache(env ?? getEnv(), "jobLog", options);
}

// ============================================================================
// Footer parsing / recovery
// ============================================================================

export interface JobLogFooter {
  /** `exited` | `failed` | `killed` | `interrupted` (recovery-only) */
  status: string;
  exitCode: number | null;
  endedAt: number | null;
}

/** Parse the terminal footer the writer appends (also used to recover a crashed process). */
export function parseJobLogFooter(text: string): JobLogFooter | null {
  const match = /\[exit (n\/a|-?\d+) · ([a-z]+) · finished ([^\]]+)\]\s*$/m.exec(text);
  if (!match) return null;
  const [, code, status, iso] = match;
  return {
    status,
    exitCode: code === "n/a" ? null : Number(code),
    endedAt: Number.isNaN(Date.parse(iso)) ? null : Date.parse(iso),
  };
}

/** Read the last few KB of a job log and parse its footer, or `null` when there is none. */
export async function readJobLogFooter(path: string, env?: ResolvedCoreEnv): Promise<JobLogFooter | null> {
  try {
    const fs = (env ?? getEnv()).fs;
    const stat = await fs.stat(path);
    const window = 4096;
    const start = Math.max(0, stat.size - window);
    const text = fs.readFileRange ? await fs.readFileRange(path, start, stat.size) : await fs.readFile(path);
    return parseJobLogFooter(text);
  } catch {
    return null;
  }
}

/**
 * Append a terminal footer to a log whose writer is gone (a crashed process). Best-effort: a
 * host without `appendFile` simply keeps the log open-ended, which still says "unknown".
 */
export async function appendJobLogFooter(
  path: string,
  status: string,
  exitCode: number | null,
  endedAt: number,
  env?: ResolvedCoreEnv
): Promise<void> {
  try {
    const fs = (env ?? getEnv()).fs;
    if (!fs.appendFile) return;
    const stat = await fs.stat(path);
    const start = Math.max(0, stat.size - 1);
    const tail = fs.readFileRange ? await fs.readFileRange(path, start, stat.size) : "";
    const prefix = tail && !tail.endsWith("\n") ? "\n" : "";
    await fs.appendFile(
      path,
      `${prefix}[exit ${exitCode ?? "n/a"} · ${status} · finished ${new Date(endedAt).toISOString()}]\n`
    );
  } catch {
    // Recovery is advisory; never fail the restore path.
  }
}
