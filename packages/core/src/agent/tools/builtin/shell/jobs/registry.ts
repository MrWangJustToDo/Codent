/**
 * Registry for background shell jobs started via CoreEnv.startCommand.
 *
 * Output is retained in memory (head-trimmed, see the caps below) *and* tee'd to
 * a durable per-job log (`command-output-log.ts`), so early output survives
 * trimming and stays readable from surfaces that cannot poll a job.
 *
 * A per-job JSON record (`command-job-store.ts`) makes the job's identity, status and notification
 * state survive a process restart: `ready()` restores the owning session's records, a `running`
 * record from a dead process becomes interrupted, and `collectCompleted()` re-delivers a completion
 * that had not reached the model. The record is scoped to the disk session; a fork or `/new` gets a
 * new id and does not inherit another conversation's jobs.
 */

import { registerEnvTeardownHook } from "../../../../../env/teardown.js";
import { generateId } from "../../../../../utils/generate-id.js";

import { appendJobLogFooter, createCommandJobLogWriter, readJobLogFooter, sweepStaleJobLogs } from "./output-log.js";
import {
  readCommandJobRecords,
  removeCommandJobRecord,
  sweepStaleJobRecords,
  tailText,
  writeCommandJobRecord,
} from "./store.js";

import type { CommandJobLogWriter } from "./output-log.js";
import type { PersistedCommandJob } from "./store.js";
import type { ResolvedCoreEnv } from "../../../../../env";

/**
 * Mirrors `CoreEnv`'s `CommandJobStatus` (`env/types.ts`), which is the one the host contract and
 * the published surface use. Declared structurally rather than imported so this module stays
 * dependency-free — but keep the union in sync if the CoreEnv contract grows a state.
 */
export type CommandJobStatus = "running" | "exited" | "killed" | "failed";

export interface CommandJobRecord {
  id: string;
  /** The `run_command` tool call that started this job (absent for legacy/ambient jobs). */
  toolCallId?: string;
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
  /**
   * The disk session that STARTED this job. Snapshotted per job: `/new` / `/resume` can switch
   * the registry's current owner while a job is still running, and its record must stay filed under
   * the conversation that started it (not the one that happens to be current when it ends).
   */
  ownerSessionId?: string;
  /** OS/runtime process id, when the host exposed one (recovery metadata). */
  pid?: number;
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
  toolCallId?: string;
  command: string;
  status: CommandJobStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  endedAt: number | null;
  /** Durable log (full output) — the notification points the model at it after a resume. */
  logPath: string | null;
}

export interface CommandJobRegistryOptions {
  /**
   * The disk session that owns these jobs. Records are restored only for this id: a new session
   * (`/new`) or a fork must not inherit another conversation's background work. Omitted for the
   * ambient/standalone registry (no persistence).
   *
   * A **getter** is allowed because the registry is created while `createTools` builds the agent,
   * before `ensureSessionData()` mints/restores the id. Reading it lazily is what makes the first
   * background command after a resume persist under the right session.
   */
  ownerSessionId?: string | (() => string | undefined | null);
}

/**
 * Registries alive in this process. `clearCoreEnv()` is the one teardown that runs when a host
 * gives up the workspace, and a background job's child process outlives the agent that started it
 * unless something reaps it — this is that hook (see `env/teardown.ts` for why the direction is
 * inverted rather than `env/` importing this module).
 */
const liveRegistries = new Set<CommandJobRegistry>();
registerEnvTeardownHook(() => {
  for (const registry of [...liveRegistries]) {
    // Best-effort and intentionally not awaited: the hook is synchronous. `destroyAll` preserves
    // terminal un-notified records, so a subsequent resume can still deliver them.
    void registry.destroyAll().catch(() => undefined);
  }
});

export class CommandJobRegistry {
  /** Owning runtime's env, so durable job logs land under the runtime root. Ambient when omitted. */
  constructor(
    private readonly env?: ResolvedCoreEnv,
    private readonly options: CommandJobRegistryOptions = {}
  ) {
    liveRegistries.add(this);
  }

  private readonly jobs = new Map<string, CommandJobRecord>();
  /** Lazily restores durable records; tools/middleware await this before touching the registry. */
  private restorePromise?: Promise<void>;

  /** The owning session id, resolved lazily (see {@link CommandJobRegistryOptions.ownerSessionId}). */
  private get ownerSessionId(): string | undefined {
    const configured = this.options.ownerSessionId;
    return typeof configured === "function" ? (configured() ?? undefined) : configured;
  }
  /** Serialized record writes per job (create → terminal must not land out of order). */
  private readonly recordWrites = new Map<string, Promise<void>>();

  /** Durable log writers for jobs where logging is available. */
  private readonly logs = new Map<string, CommandJobLogWriter>();

  /** Job ids already surfaced to the model as completion notifications (dedupe). */
  private readonly notifiedJobIds = new Set<string>();

  /** Optional status observer (see {@link setChangeListener}). */
  private changeListener: CommandJobChangeListener | null = null;

  /**
   * Restore this session's durable job records (once). Call before `create`/`poll`/`collectCompleted`
   * in a host that has a session id; the ambient registry has nothing to restore.
   */
  ready(): Promise<void> {
    if (!this.restorePromise) {
      // Not resolvable yet (no env/owner): do NOT cache the empty result — a later call, after
      // `ensureSessionData()` has minted/restored the id, must still restore.
      if (!this.env || !this.ownerSessionId) return Promise.resolve();
      this.restorePromise = this.restore();
    }
    return this.restorePromise;
  }

  /**
   * Load the owning session's records. A `running` record means the process died: trust a terminal
   * footer if the log has one (the crash landed after finish, before the record update), otherwise
   * mark it failed/interrupted and close the log. Completed records stay queryable and, when not yet
   * notified, are picked up by {@link collectCompleted}.
   */
  private async restore(): Promise<void> {
    const owner = this.ownerSessionId;
    if (!this.env || !owner) return;
    let changed = false;
    const records = await readCommandJobRecords(this.env, owner);
    for (const persisted of records) {
      if (this.jobs.has(persisted.jobId)) continue;
      const job = this.fromPersisted(persisted);
      if (job.logPath && !(await this.env.fs.exists(job.logPath))) job.logPath = null;
      const footer = job.logPath ? await readJobLogFooter(job.logPath, this.env) : null;
      if (persisted.status === "running") {
        if (footer) {
          job.status = footer.status === "killed" ? "killed" : footer.status === "exited" ? "exited" : "failed";
          job.exitCode = footer.exitCode;
          job.endedAt = footer.endedAt ?? Date.now();
        } else {
          job.status = "failed";
          job.exitCode = null;
          job.endedAt = Date.now();
          job.stderr = `${job.stderr}${job.stderr ? "\n" : ""}Interrupted by a process restart.`;
          if (job.logPath) {
            await appendJobLogFooter(job.logPath, "interrupted", null, job.endedAt, this.env);
          }
        }
        // Return the persisted tail on the first poll; the log holds anything older.
        job.stdoutReadOffset = 0;
        job.stderrReadOffset = 0;
        await this.persist(job);
      } else if (job.logPath && !footer) {
        // The terminal record landed but the writer's footer did not (crash between the two). Make
        // the log consistent: its "no footer means running" contract must not outlive the process.
        await appendJobLogFooter(job.logPath, job.status, job.exitCode, job.endedAt ?? Date.now(), this.env);
      }
      if (persisted.notified) this.notifiedJobIds.add(job.id);
      this.jobs.set(job.id, job);
      changed = true;
    }
    if (changed) this.notifyChange();
    // Opportunistic sweep: records are tiny, but a long-lived workspace still accumulates them.
    void sweepStaleJobRecords(this.env);
  }

  private fromPersisted(persisted: PersistedCommandJob): CommandJobRecord {
    return {
      id: persisted.jobId,
      command: persisted.command,
      status: persisted.status === "running" ? "failed" : persisted.status,
      stdout: persisted.stdoutTail,
      stderr: persisted.stderrTail,
      stdoutReadOffset: 0,
      stderrReadOffset: 0,
      exitCode: persisted.exitCode,
      startedAt: persisted.startedAt,
      endedAt: persisted.endedAt,
      logPath: persisted.logPath,
      ownerSessionId: persisted.ownerSessionId,
      ...(persisted.toolCallId ? { toolCallId: persisted.toolCallId } : {}),
      ...(persisted.pid !== undefined ? { pid: persisted.pid } : {}),
    };
  }

  /**
   * Persist a job record, serialized per job so a slow create-write cannot overwrite the terminal
   * write that follows it. No-op for the ambient registry (no owner/env).
   */
  private persist(job: CommandJobRecord): Promise<void> {
    const owner = job.ownerSessionId ?? this.ownerSessionId;
    if (!this.env || !owner) return Promise.resolve();
    const record: PersistedCommandJob = {
      version: 1,
      jobId: job.id,
      ...(job.toolCallId ? { toolCallId: job.toolCallId } : {}),
      command: job.command,
      status: job.status,
      exitCode: job.exitCode,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      ownerSessionId: owner,
      ...(job.pid !== undefined ? { pid: job.pid } : {}),
      logPath: job.logPath,
      stdoutTail: tailText(job.stdout),
      stderrTail: tailText(job.stderr),
      notified: this.notifiedJobIds.has(job.id),
    };
    const previous = this.recordWrites.get(job.id) ?? Promise.resolve();
    const next = previous.then(() => writeCommandJobRecord(this.env as ResolvedCoreEnv, record)).catch(() => undefined);
    this.recordWrites.set(job.id, next);
    return next;
  }

  /** Remove a record after its pending writes settle (so a late write cannot recreate it). */
  private async removeRecord(jobId: string): Promise<void> {
    const pending = this.recordWrites.get(jobId);
    if (pending) await pending.catch(() => undefined);
    this.recordWrites.delete(jobId);
    if (this.env) await removeCommandJobRecord(this.env, jobId).catch(() => undefined);
  }

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

  /**
   * Internal rows for the `<background_jobs>` turn-context section: status, exit code and the
   * durable log path (metadata only — output stays in the log). Not the serialized `jobs` channel
   * payload, which deliberately stays summary-only.
   */
  listForTurnContext(): Array<{
    jobId: string;
    toolCallId?: string;
    command: string;
    status: CommandJobStatus;
    exitCode: number | null;
    logPath: string | null;
    startedAt: number;
  }> {
    return [...this.jobs.values()]
      .filter((job) => this.isCurrentOwner(job))
      .map((job) => ({
        jobId: job.id,
        ...(job.toolCallId ? { toolCallId: job.toolCallId } : {}),
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
        logPath: job.logPath,
        startedAt: job.startedAt,
      }));
  }

  /**
   * A job belongs to the conversation that started it. `/new`/`/resume` can switch the registry's
   * current owner while a job runs; it must not surface (or notify) in the new conversation.
   */
  private isCurrentOwner(job: CommandJobRecord): boolean {
    const current = this.ownerSessionId;
    return !job.ownerSessionId || !current || job.ownerSessionId === current;
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

  create(command: string, toolCallId?: string): CommandJobRecord {
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
    // Opportunistic safety net for logs/records left behind by an earlier run.
    void sweepStaleJobLogs(undefined, this.env);
    if (this.env) void sweepStaleJobRecords(this.env);
    const record: CommandJobRecord = {
      id,
      ...(toolCallId ? { toolCallId } : {}),
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
      ownerSessionId: this.ownerSessionId,
    };
    this.jobs.set(id, record);
    void this.persist(record);
    this.notifyChange();
    return record;
  }

  get(jobId: string): CommandJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  setKill(jobId: string, kill: () => Promise<void>, pid?: number): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.kill = kill;
    if (pid !== undefined) job.pid = pid;
    void this.persist(job);
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
    this.finish(job, exitCode === 0 ? "exited" : "failed", { exitCode });
  }

  markFailed(jobId: string, message?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.finish(job, "failed", { errorText: message });
  }

  markKilled(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    this.finish(job, "killed");
  }

  /**
   * The terminal transition every stop path shares: optional error text, status/exit code, log
   * footer, persistence and one change notification. The three `mark*` callers differ only in the
   * status and whether a code/text is known.
   */
  private finish(
    job: CommandJobRecord,
    status: CommandJobRecord["status"],
    options: { exitCode?: number | null; errorText?: string } = {}
  ): void {
    if (options.errorText) {
      job.stderr += (job.stderr ? "\n" : "") + options.errorText;
      this.logs.get(job.id)?.appendStderr(`${options.errorText}\n`);
    }
    job.status = status;
    if ("exitCode" in options) {
      job.exitCode = options.exitCode ?? 1;
    } else if (status === "failed") {
      job.exitCode = job.exitCode ?? 1;
    }
    job.endedAt = Date.now();
    this.afterFinished(job);
    this.finalizeLog(job);
    void this.persist(job);
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
    this.trimStreamValue(job, "stdout", MAX_FINISHED_OUTPUT_CHARS);
    this.trimStreamValue(job, "stderr", MAX_FINISHED_OUTPUT_CHARS);
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
      void this.removeRecord(id);
      excess--;
    }
  }

  /**
   * Amortized head-trim for a running job's stream. Never cuts into the
   * unread region, so {@link poll} still returns everything since the last
   * read cursor.
   */
  private trimStream(job: CommandJobRecord, stream: "stdout" | "stderr"): void {
    this.trimStreamValue(job, stream, MAX_RUNNING_OUTPUT_CHARS, TRIM_THRESHOLD_CHARS);
  }

  /**
   * The one head-trim arithmetic: keep the tail from `maxChars`, never before the read cursor,
   * and shift the cursor by what was dropped. `triggerChars` differs by call site (the running
   * stream trims amortized; a finished job trims at its cap).
   */
  private trimStreamValue(
    job: CommandJobRecord,
    stream: "stdout" | "stderr",
    maxChars: number,
    triggerChars: number = maxChars
  ): void {
    const value = job[stream];
    if (value.length <= triggerChars) return;
    const offset = stream === "stdout" ? job.stdoutReadOffset : job.stderrReadOffset;
    const cut = Math.max(offset, value.length - maxChars);
    if (cut <= 0) return;
    job[stream] = value.slice(cut);
    const nextOffset = Math.max(0, offset - cut);
    if (stream === "stdout") {
      job.stdoutReadOffset = nextOffset;
    } else {
      job.stderrReadOffset = nextOffset;
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
  async collectCompleted(options: { markNotified?: boolean } = {}): Promise<CompletedCommandJob[]> {
    await this.ready();
    const completed: CompletedCommandJob[] = [];
    for (const [id, job] of this.jobs) {
      if (job.status === "running") continue;
      if (this.notifiedJobIds.has(id)) continue;
      if (!this.isCurrentOwner(job)) continue;
      completed.push({
        id: job.id,
        ...(job.toolCallId ? { toolCallId: job.toolCallId } : {}),
        command: job.command,
        status: job.status,
        exitCode: job.exitCode,
        stdout: job.stdout,
        stderr: job.stderr,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        logPath: job.logPath,
      });
    }
    // Default callers drain-and-mark (the historical contract). The notification middleware passes
    // `markNotified: false`, injects/persists the notification, and only then marks — so a crash
    // between the two re-delivers the completion, and the synthetic message's content-hash id
    // dedupes it instead of dropping it.
    if (options.markNotified !== false) await this.markNotified(completed.map((job) => job.id));
    return completed;
  }

  /** Record completions as delivered (and persist the flag before a restart can lose it). */
  async markNotified(jobIds: readonly string[]): Promise<void> {
    if (jobIds.length === 0) return;
    for (const id of jobIds) this.notifiedJobIds.add(id);
    await Promise.all(
      jobIds
        .map((id) => this.jobs.get(id))
        .filter((job): job is CommandJobRecord => job !== undefined)
        .map((job) => this.persist(job))
    );
  }

  /**
   * Kill and forget every job registered when the call started. Only the ids
   * captured here are removed: `clearCoreEnv()` fires this without awaiting, and
   * a job started in the meantime belongs to the next session and must stay
   * queryable/killable rather than be silently dropped.
   */
  async destroyAll(): Promise<void> {
    const ids = [...this.jobs.keys()];
    // A graceful quit must not erase a completion the model has not seen: keep terminal,
    // un-notified records (and their logs) for the next resume. Running jobs are killed and
    // deleted; already-notified terminal jobs have no future consumer.
    const preserve = new Set(
      ids.filter((id) => {
        const job = this.jobs.get(id);
        return job !== undefined && job.status !== "running" && !this.notifiedJobIds.has(id);
      })
    );
    // Best-effort teardown: one rejected kill/log cleanup must not leave every other
    // job registered (and the reset path must still finish its bookkeeping).
    await Promise.allSettled(ids.map((id) => this.kill(id)));
    for (const id of ids) {
      this.jobs.delete(id);
      this.notifiedJobIds.delete(id);
    }
    const disposable = ids.filter((id) => !preserve.has(id));
    await Promise.allSettled(disposable.map((id) => this.disposeLog(id)));
    await Promise.allSettled(disposable.map((id) => this.removeRecord(id)));
    liveRegistries.delete(this);
    if (ids.length > 0) this.notifyChange();
  }

  clear(): void {
    const ids = [...this.jobs.keys()];
    for (const id of ids) {
      this.jobs.delete(id);
      this.notifiedJobIds.delete(id);
      void this.disposeLog(id);
      void this.removeRecord(id);
    }
    if (ids.length > 0) this.notifyChange();
  }
}
