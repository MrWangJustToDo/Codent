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
import type { ResolvedCoreEnv } from "../../../env";

/**
 * Mirrors `CoreEnv`'s `CommandJobStatus` (`env/types.ts`), which is the one the host contract and
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

/**
 * Serializable per-job summary — everything a status surface needs and nothing more.
 *
 * Deliberately excludes `stdout` / `stderr` / `kill`: this shape is emitted on the
 * unified bus and projected onto the session `jobs` channel, so it crosses process
 * boundaries (remote session, server) and is replayed to late subscribers. Output
 * stays reachable through `get_command_output` / the job's log file.
 */
export interface CommandJobSummary {
  jobId: string;
  command: string;
  status: CommandJobStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}

/** Listener invoked with the full job list whenever the registry's membership or a job's
 * lifecycle state changes. Output appends do NOT notify (see the class doc). */
export type CommandJobChangeListener = (jobs: CommandJobSummary[]) => void;

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
  /** Owning runtime's env, so durable job logs land under the runtime root. Ambient when omitted. */
  constructor(private readonly env?: ResolvedCoreEnv) {}

  private readonly jobs = new Map<string, CommandJobRecord>();

  /** Durable log writers for jobs where logging is available. */
  private readonly logs = new Map<string, CommandJobLogWriter>();

  /** Job ids already surfaced to the model as completion notifications (dedupe). */
  private readonly notifiedJobIds = new Set<string>();

  /** Optional status observer (see {@link setChangeListener}). */
  private changeListener: CommandJobChangeListener | null = null;

  /**
   * Watch job membership and lifecycle changes. The listener receives the full,
   * serializable {@link list} snapshot on every change — deliberately NOT on output
   * appends, which are far too frequent to broadcast and carry nothing a status
   * surface needs.
   *
   * Registered by the owning agent so job transitions reach the unified bus; the
   * registry itself stays bus-free (it is also constructed ambient/standalone).
   */
  setChangeListener(listener: CommandJobChangeListener | null): void {
    this.changeListener = listener;
  }

  /** Serializable status list (no output, no kill handles). */
  list(): CommandJobSummary[] {
    const out: CommandJobSummary[] = [];
    for (const job of this.jobs.values()) {
      out.push({
        jobId: job.id,
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
      });
    }
    return out;
  }

  /** Broadcast the current status list. No-op without a listener. */
  private notifyChange(): void {
    this.changeListener?.(this.list());
  }

  create(command: string): CommandJobRecord {
    const id = generateId("job");
    const startedAt = Date.now();
    // A write failure disables logging for this job — stop advertising the path.
    const stopAdvertising = () => {
      const current = this.jobs.get(id);
      if (current) current.logPath = null;
    };
    const log = createCommandJobLogWriter({
      jobId: id,
      command,
      startedAt,
      onDisabled: stopAdvertising,
      ...(this.env ? { env: this.env } : {}),
    });
    if (log) this.logs.set(id, log);
    // Opportunistic safety net for logs left behind by an earlier run.
    void sweepStaleJobLogs(undefined, this.env);
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
    this.notifyChange();
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
    // The ternary here read `… ? "exited" : "exited"`, so a job that FAILED was recorded as a clean
    // finish — and the completion notification maps `exited` to "completed", so the model was told a
    // failing command had completed. A `null` code (the child was signalled, so there is no status) is
    // not success either, and `exitCode` below keeps the non-zero value that says so.
    job.status = exitCode === 0 ? "exited" : "failed";
    job.exitCode = exitCode ?? 1;
    job.endedAt = Date.now();
    this.afterFinished(job);
    this.finalizeLog(job);
    this.notifyChange();
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
    this.notifyChange();
  }

  markKilled(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "killed";
    job.endedAt = Date.now();
    this.afterFinished(job);
    this.finalizeLog(job);
    this.notifyChange();
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

  /**
   * Evict oldest finished jobs (already surfaced to the model) beyond the cap.
   *
   * Runs inside a terminal transition, whose caller broadcasts once afterwards — so
   * an eviction never needs a notification of its own.
   */
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

  /**
   * Kill a job. Returns whether this call actually stopped a running job.
   *
   * `false` covers both "no such job" and "it was not running" — the caller's message is the same
   * ("was not running"), and returning `true` for a finished job made `kill_command` claim it had
   * killed something that had already ended.
   */
  async kill(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    const wasRunning = job.status === "running";
    if (wasRunning && job.kill) {
      await job.kill();
    }
    if (wasRunning) {
      this.markKilled(jobId);
    }
    return wasRunning;
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
    if (ids.length > 0) this.notifyChange();
  }

  clear(): void {
    const ids = [...this.jobs.keys()];
    for (const id of ids) {
      this.jobs.delete(id);
      this.notifiedJobIds.delete(id);
      void this.disposeLog(id);
    }
    if (ids.length > 0) this.notifyChange();
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
