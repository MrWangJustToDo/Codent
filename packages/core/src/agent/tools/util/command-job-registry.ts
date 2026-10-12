/**
 * In-memory registry for background shell jobs started via CoreEnv.startCommand.
 *
 * Output is retained in memory (head-trimmed, see the caps below) *and* tee'd to
 * a durable per-job log (`command-output-log.ts`), so early output survives
 * trimming and stays readable from surfaces that cannot poll a job.
 */

import { registerEnvTeardownHook } from "../../../env/teardown";
import { generateId } from "../../../utils/generate-id.js";

import { createCommandJobLogWriter, sweepStaleJobLogs } from "./command-output-log.js";

import type { CommandJobLogWriter } from "./command-output-log.js";

/**
 * Mirrors `CoreEnv`'s `CommandJobStatus` (`env-types.ts`), which is the one the host contract and
 * the published surface use. Declared structurally rather than imported so this module stays
 * dependency-free — but keep the union in sync if the CoreEnv contract grows a state.
 */
export type CommandJobStatus = "running" | "exited" | "killed" | "failed";

export interface CommandJobRecord {
  id: string;
  command: string;
  status: CommandJobStatus;
  stdout: string;
  stderr: string;
  /** Byte cursor for incremental stdout polls (UTF-16 code units / JS string length). */
  stdoutReadOffset: number;
  stderrReadOffset: number;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /**
   * Workspace-relative durable log holding this job's output, or `null` when the
   * host cannot append to files (logging degraded). Advertised to callers so a
   * surface that can only read files (e.g. the code-mode sandbox) can read it.
   */
  logPath: string | null;
  /** Adapter-provided kill (best-effort). */
  kill?: () => Promise<void>;
}

export interface CommandJobPollResult {
  jobId: string;
  status: CommandJobStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  running: boolean;
  /** Durable log holding this job's output, or `null` when unavailable. */
  logPath: string | null;
}

/** A finished background job surfaced to the model as a completion notification. */
/**
 * Max retained chars per stream once a job has finished (older output is
 * dropped from the head). Generous vs. the 2000-char completion notification
 * cap, so surfaced content is unaffected.
 */
const MAX_FINISHED_OUTPUT_CHARS = 64_000;
/** Max retained chars per stream for a running job (head-trimmed, never past
 * the unread region so incremental polling stays lossless). */
const MAX_RUNNING_OUTPUT_CHARS = 256_000;
/** Only trim a running stream once it exceeds this length (amortized slicing). */
const TRIM_THRESHOLD_CHARS = 512_000;
/** Max finished jobs kept before the oldest (already notified) are evicted. */
const MAX_FINISHED_JOBS = 50;

export interface CompletedCommandJob {
  id: string;
  command: string;
  status: CommandJobStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  endedAt: number | null;
}

export class CommandJobRegistry {
  private readonly jobs = new Map<string, CommandJobRecord>();

  /** Durable log writers for jobs where logging is available. */
  private readonly logs = new Map<string, CommandJobLogWriter>();

  /** Job ids already surfaced to the model as completion notifications (dedupe). */
  private readonly notifiedJobIds = new Set<string>();

  create(command: string): CommandJobRecord {
    const id = generateId("job");
    const startedAt = Date.now();
    // A write failure disables logging for this job — stop advertising the path.
    const stopAdvertising = () => {
      const current = this.jobs.get(id);
      if (current) current.logPath = null;
    };
    const log = createCommandJobLogWriter({ jobId: id, command, startedAt, onDisabled: stopAdvertising });
    if (log) this.logs.set(id, log);
    // Opportunistic safety net for logs left behind by an earlier run.
    void sweepStaleJobLogs();
    const record: CommandJobRecord = {
      id,
      command,
      status: "running",
      stdout: "",
      stderr: "",
      stdoutReadOffset: 0,
      stderrReadOffset: 0,
      exitCode: null,
      startedAt,
      endedAt: null,
      logPath: log?.path ?? null,
    };
    this.jobs.set(id, record);
    return record;
  }

  get(jobId: string): CommandJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  setKill(jobId: string, kill: () => Promise<void>): void {
    const job = this.jobs.get(jobId);
    if (job) job.kill = kill;
  }

  appendStdout(jobId: string, chunk: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return;
    job.stdout += chunk;
    this.trimStream(job, "stdout");
    this.logs.get(jobId)?.appendStdout(chunk);
  }

  appendStderr(jobId: string, chunk: string): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return;
    job.stderr += chunk;
    this.trimStream(job, "stderr");
    this.logs.get(jobId)?.appendStderr(chunk);
  }

  markExited(jobId: string, exitCode: number | null): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return;
    job.status = exitCode === 0 || exitCode === null ? "exited" : "exited";
    job.exitCode = exitCode ?? 1;
    job.endedAt = Date.now();
    this.afterFinished(job);
    this.finalizeLog(job);
  }

  markFailed(jobId: string, message?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (message) {
      job.stderr += (job.stderr ? "\n" : "") + message;
      this.logs.get(jobId)?.appendStderr(`${message}\n`);
    }
    job.status = "failed";
    job.exitCode = job.exitCode ?? 1;
    job.endedAt = Date.now();
    this.afterFinished(job);
    this.finalizeLog(job);
  }

  markKilled(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "killed";
    job.endedAt = Date.now();
    this.afterFinished(job);
    this.finalizeLog(job);
  }

  /** Record the terminal status in the job log (no-op when logging is off). */
  private finalizeLog(job: CommandJobRecord): void {
    const log = this.logs.get(job.id);
    if (!log) return;
    void log.finalize(job.status, job.exitCode, job.endedAt ?? Date.now());
  }

  /** Stop buffering and delete a job's log (record evicted / registry cleared). */
  private disposeLog(jobId: string): Promise<void> {
    const log = this.logs.get(jobId);
    if (!log) return Promise.resolve();
    this.logs.delete(jobId);
    return log.remove();
  }

  /**
   * Shrink memory footprint of a finished job: cap retained output and evict
   * the oldest already-notified finished jobs. Running jobs are untouched so
   * incremental poll semantics stay intact.
   */
  private afterFinished(job: CommandJobRecord): void {
    this.trimFinished(job);
    this.evictOldestFinished();
  }

  /**
   * Drop head output beyond {@link MAX_FINISHED_OUTPUT_CHARS} per stream.
   * Unlike {@link trimStream}, this may cut into the unread region: a finished
   * job that was never polled keeps only its tail (the completion notification
   * already caps surfaced output to 2000 chars).
   */
  private trimFinished(job: CommandJobRecord): void {
    if (job.stdout.length > MAX_FINISHED_OUTPUT_CHARS) {
      const cut = Math.max(job.stdoutReadOffset, job.stdout.length - MAX_FINISHED_OUTPUT_CHARS);
      job.stdout = job.stdout.slice(cut);
      job.stdoutReadOffset = Math.max(0, job.stdoutReadOffset - cut);
    }
    if (job.stderr.length > MAX_FINISHED_OUTPUT_CHARS) {
      const cut = Math.max(job.stderrReadOffset, job.stderr.length - MAX_FINISHED_OUTPUT_CHARS);
      job.stderr = job.stderr.slice(cut);
      job.stderrReadOffset = Math.max(0, job.stderrReadOffset - cut);
    }
  }

  /** Evict oldest finished jobs (already surfaced to the model) beyond the cap. */
  private evictOldestFinished(): void {
    const finished: string[] = [];
    for (const [id, job] of this.jobs) {
      if (job.status !== "running") finished.push(id);
    }
    let excess = finished.length - MAX_FINISHED_JOBS;
    if (excess <= 0) return;
    for (const id of finished) {
      if (excess <= 0) break;
      if (!this.notifiedJobIds.has(id)) continue;
      this.jobs.delete(id);
      this.notifiedJobIds.delete(id);
      void this.disposeLog(id);
      excess--;
    }
  }

  /**
   * Amortized head-trim for a running job's stream. Never cuts into the
   * unread region, so {@link poll} still returns everything since the last
   * read cursor.
   */
  private trimStream(job: CommandJobRecord, stream: "stdout" | "stderr"): void {
    const value = job[stream];
    if (value.length <= TRIM_THRESHOLD_CHARS) return;
    const offset = stream === "stdout" ? job.stdoutReadOffset : job.stderrReadOffset;
    const cut = Math.max(offset, value.length - MAX_RUNNING_OUTPUT_CHARS);
    if (cut <= 0) return;
    job[stream] = value.slice(cut);
    if (stream === "stdout") {
      job.stdoutReadOffset = Math.max(0, job.stdoutReadOffset - cut);
    } else {
      job.stderrReadOffset = Math.max(0, job.stderrReadOffset - cut);
    }
  }

  /**
   * Return unread stdout/stderr since last poll and advance cursors.
   */
  poll(jobId: string): CommandJobPollResult | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    const stdout = job.stdout.slice(job.stdoutReadOffset);
    const stderr = job.stderr.slice(job.stderrReadOffset);
    job.stdoutReadOffset = job.stdout.length;
    job.stderrReadOffset = job.stderr.length;

    return {
      jobId: job.id,
      status: job.status,
      stdout,
      stderr,
      exitCode: job.exitCode,
      running: job.status === "running",
      logPath: job.logPath,
    };
  }

  async kill(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === "running" && job.kill) {
      await job.kill();
    }
    if (job.status === "running") {
      this.markKilled(jobId);
    }
    return true;
  }

  /**
   * Drain the completion queue: every job that has finished but not yet been
   * notified to the model. Marks them notified (each job notified exactly once).
   *
   * Independent of {@link poll} — this does NOT advance the incremental read
   * cursors, so the model can still read full output via get_command_output.
   */
  collectCompleted(): CompletedCommandJob[] {
    const completed: CompletedCommandJob[] = [];
    for (const [id, job] of this.jobs) {
      if (job.status === "running") continue;
      if (this.notifiedJobIds.has(id)) continue;
      this.notifiedJobIds.add(id);
      completed.push({
        id: job.id,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
        stdout: job.stdout,
        stderr: job.stderr,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
      });
    }
    return completed;
  }

  /**
   * Kill and forget every job registered when the call started. Only the ids
   * captured here are removed: `clearCoreEnv()` fires this without awaiting, and
   * a job started in the meantime belongs to the next session and must stay
   * queryable/killable rather than be silently dropped.
   */
  async destroyAll(): Promise<void> {
    const ids = [...this.jobs.keys()];
    await Promise.all(ids.map((id) => this.kill(id)));
    for (const id of ids) {
      this.jobs.delete(id);
      this.notifiedJobIds.delete(id);
    }
    await Promise.all(ids.map((id) => this.disposeLog(id)));
  }

  clear(): void {
    const ids = [...this.jobs.keys()];
    for (const id of ids) {
      this.jobs.delete(id);
      this.notifiedJobIds.delete(id);
      void this.disposeLog(id);
    }
  }
}

/** Session-scoped registry (reset when CoreEnv is cleared). */
export const commandJobRegistry = new CommandJobRegistry();

/** Kill all background jobs and clear the registry (CoreEnv destroy / clear). */
export async function destroyAllCommandJobs(): Promise<void> {
  await commandJobRegistry.destroyAll();
}

// Teardown is registered rather than called: `env.ts` sits at the bottom of the layer
// stack and importing this module from there closes a cycle (this module → its log
// writer → env). The hook is fire-and-forget because `clearCoreEnv()` is synchronous.
registerEnvTeardownHook(() => {
  void commandJobRegistry.destroyAll();
});
