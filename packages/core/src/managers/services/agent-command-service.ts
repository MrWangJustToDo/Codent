/**
 * The command source of the background-work trunk: the per-agent command-job registry, durable
 * restore, background start / poll / kill, and the `<background_jobs>` pointer.
 *
 * This used to be three responsibilities spread across `ManagedAgent` (lazy registry + change
 * listener + section builder), the registry itself, and the turn-context middleware. The service is
 * the single owner of the registry lifecycle; the middleware remains the delivery layer for the
 * one-shot completion notification.
 *
 * Since background *tasks* became a second kind, the list / pending / delivered / publish half lives
 * on the trunk (`BackgroundWorkService` + `BackgroundWorkSource`) and this class implements the
 * source port (`kind: COMMAND_JOB_KIND`). What stays here is what only a command has: a child process to
 * spawn and kill, a durable record to restore per session, incremental poll cursors, and the
 * `<background_jobs>` pointer those cursors back.
 *
 * The registry is created lazily because the agent is built before `ensureSessionData()` mints the
 * disk session id; both the env and the owner id are getters for that reason.
 */

import { COMMAND_JOB_KIND, settledTerminalStatus } from "../../agent/jobs/background-work.js";
import { CommandJobRegistry } from "../../agent/tools/builtin/shell/jobs/registry.js";
import { truncateString } from "../../agent/tools/shared/output-limits.js";
import {
  collectRunCommandToolCallIds,
  formatBackgroundJobsSection,
  TURN_CONTEXT_KINDS,
} from "../../agent/turn-context";
import { errorMessage } from "../../utils/errors.js";

import type {
  BackgroundWorkChangeSink,
  BackgroundWorkCompletion,
  BackgroundWorkSource,
} from "../../agent/jobs/background-work.js";
import type {
  CommandJobChangeListener,
  CommandJobPollResult,
  CompletedCommandJob,
} from "../../agent/tools/builtin/shell/jobs/registry.js";
import type {
  AgentCommandPort,
  StartBackgroundInput,
  StartBackgroundResult,
  KillCommandResult,
} from "../../agent/tools/runtime/command-service.js";
import type { TurnContextSection } from "../../agent/turn-context/turn-context-message.js";
import type { ResolvedCoreEnv } from "../../env";
import type { SessionJobSummary } from "../../runtime-types/session-payloads.js";
import type { ModelMessage } from "@tanstack/ai";

export interface AgentCommandServiceOptions {
  /** Resolved lazily; the agent's runtime env may not exist when the service is constructed. */
  env: () => ResolvedCoreEnv;
  /** The disk session that owns the jobs; resolved lazily for the same reason. */
  ownerSessionId: () => string | undefined | null;
}

export class AgentCommandService implements AgentCommandPort, BackgroundWorkSource {
  readonly kind = "command" as const;

  private registryInstance?: CommandJobRegistry;
  /** Set before session reset/agent destroy; rejects late starts and callback resurrection. */
  private closing = false;
  /**
   * The trunk's change sink. A stable listener rather than a per-registration closure, so it can be
   * replaced (or cleared) after the registry already exists without leaking a stale one.
   */
  private changeSink: BackgroundWorkChangeSink | null = null;
  private readonly registryListener: CommandJobChangeListener = (change) => {
    this.changeSink?.(change.finished);
  };

  constructor(private readonly options: AgentCommandServiceOptions) {}

  /** Attach (or detach) the trunk's change sink; late binding, so it may arrive after the registry. */
  setChangeSink(sink: BackgroundWorkChangeSink | null): void {
    this.changeSink = sink;
    this.registryInstance?.setChangeListener(sink ? this.registryListener : null);
  }

  /** The registry tools use. Creates it (and its change listener) on first access. */
  private registry(): CommandJobRegistry {
    if (this.closing) throw new Error("AgentCommandService is closed");
    if (!this.registryInstance) {
      const registry = new CommandJobRegistry(this.options.env(), {
        ownerSessionId: this.options.ownerSessionId,
      });
      registry.setChangeListener(this.changeSink ? this.registryListener : null);
      this.registryInstance = registry;
    }
    return this.registryInstance;
  }

  /** Start a background command and attach its lifecycle to the owned registry. */
  async startBackground(input: StartBackgroundInput): Promise<StartBackgroundResult> {
    if (this.closing) throw new Error("AgentCommandService is closed");
    await this.ready();
    if (this.closing) throw new Error("AgentCommandService is closed");
    // Capture the registry for the whole command lifetime. A late stdout/stderr/exit
    // callback must not recreate a destroyed registry after the agent is torn down.
    const registry = this.registry();
    const { command, toolCallId, cwd, env, coreEnv } = input;
    if (!coreEnv.startCommand) {
      throw new Error(
        "Background commands are not supported in this environment. " +
          "Omit run_in_background or use a local/node or playground CoreEnv that implements startCommand."
      );
    }
    const job = registry.create(command, toolCallId);
    let handleKill: (() => Promise<void>) | undefined;
    try {
      const handle = await coreEnv.startCommand(command, {
        cwd,
        env,
        onStdout: (chunk) => registry.appendStdout(job.id, chunk),
        onStderr: (chunk) => registry.appendStderr(job.id, chunk),
        onExit: (exitCode) => registry.markExited(job.id, exitCode),
      });
      handleKill = handle.kill;
      if (this.closing || registry.get(job.id) === undefined) {
        // The session was reset/destroyed while startCommand was awaiting. The
        // registry has already forgotten the job, so setKill would be a no-op and
        // the real child process would survive as an orphan.
        await handle.kill().catch(() => {});
        handleKill = undefined;
        throw new Error("Background command was cancelled because its session closed.");
      }
      registry.setKill(job.id, handle.kill, handle.pid);
    } catch (err) {
      if (handleKill && (this.closing || registry.get(job.id) === undefined)) {
        await handleKill().catch(() => {});
      } else {
        registry.markFailed(job.id, errorMessage(err));
      }
      throw err;
    }
    return { jobId: job.id, ...(job.logPath ? { cachedOutputPath: job.logPath } : {}) };
  }

  /** Poll one job, throwing the same unknown-id error the registry's callers relied on. */
  async poll(jobId: string): Promise<CommandJobPollResult> {
    await this.ready();
    const registry = this.registry();
    const result = registry.poll(jobId);
    if (!result) throw new Error(`Unknown background jobId: ${jobId}`);
    return result;
  }

  /** Stop a job and return the terminal state the tools render. */
  async kill(jobId: string): Promise<KillCommandResult> {
    await this.ready();
    const registry = this.registry();
    const existing = registry.get(jobId);
    if (!existing) throw new Error(`Unknown background jobId: ${jobId}`);
    const killed = await registry.kill(jobId);
    const after = registry.get(jobId);
    return {
      killed,
      status: after?.status ?? "killed",
      ...(after?.logPath ? { logPath: after.logPath } : {}),
    };
  }

  /** Non-creating read: a status snapshot must not mint a registry before any job exists. */
  list(): SessionJobSummary[] {
    return this.registryInstance?.list() ?? [];
  }

  /** Restore this session's durable job records once. */
  async ready(): Promise<void> {
    await this.registry().ready();
  }

  /**
   * The `<background_jobs>` section for the model-visible wire. Only jobs whose `run_command` call
   * is still in `messages` are listed; after compaction drops the call, re-listing it is noise.
   */
  async sectionFor(
    messages: readonly ModelMessage[],
    options: { excludeJobIds?: ReadonlySet<string> } = {}
  ): Promise<TurnContextSection | undefined> {
    await this.ready();
    const inContext = collectRunCommandToolCallIds(messages);
    const excluded = options.excludeJobIds;
    const rows = this.registry()
      .listForTurnContext()
      .filter((job) => job.toolCallId !== undefined && inContext.has(job.toolCallId) && !excluded?.has(job.jobId));
    const content = formatBackgroundJobsSection(rows);
    return content ? { key: TURN_CONTEXT_KINDS.backgroundJobs, content } : undefined;
  }

  /**
   * Peek the completion queue as trunk completions (the notification middleware marks them after
   * delivery). One mapping, here: the registry speaks `CompletedCommandJob`, the trunk speaks
   * `BackgroundWorkCompletion`, and this is the only place the two meet.
   */
  async pending(): Promise<BackgroundWorkCompletion[]> {
    const completed = await this.registry().collectCompleted({ markNotified: false });
    return completed.map((job) => ({
      id: job.id,
      kind: COMMAND_JOB_KIND,
      // The job id is what the tool result returned; the call id is what the model wrote. Both, so a
      // notification among several can be matched to the exact `run_command` result.
      ...(job.toolCallId ? { toolCallId: job.toolCallId } : {}),
      label: job.command,
      status: settledTerminalStatus(job.status),
      exitCode: job.exitCode,
      body: formatCommandBody(job),
    }));
  }

  /** Mark completions delivered after their synthetic message is persisted. */
  async markDelivered(completions: readonly BackgroundWorkCompletion[]): Promise<void> {
    await this.registry().markNotified(completions.map((completion) => completion.id));
  }

  /**
   * Session switch: drop this session's jobs and completion queue.
   *
   * The empty publication is the TRUNK's, not this source's: the facade clears the channel before it
   * resets any source, so that a switch cannot race a settling job into the target transcript.
   */
  async reset(_reason: string): Promise<void> {
    this.closing = true;
    await this.destroy();
  }

  /** Kill/destroy the registry (agent destroy); terminal un-notified records are preserved. */
  async destroy(): Promise<void> {
    this.closing = true;
    const registry = this.registryInstance;
    this.registryInstance = undefined;
    registry?.setChangeListener(null);
    await registry?.destroyAll();
  }
}

/**
 * Per-stream inline budget for a completion body (chars, tail-kept).
 *
 * The job's durable log holds everything, so the body is a PREVIEW whose pointer must survive: the
 * `log:` line is appended AFTER truncation and is never dropped. Keeping the tail is deliberate — the
 * interesting part of a background command's output is its end (the error, the last build lines).
 *
 * This is the command analogue of the tool-output contract (`maybeCacheOutput`): bound the inline
 * copy, always name the durable one. The shared renderer applies no cap of its own, so a body can
 * never be cut twice, and the second cut can never swallow the pointer.
 */
const COMMAND_BODY_TAIL_CHARS = 3000;

/**
 * The command half of a completion notification.
 *
 * Only the part a command can describe: the output tails and the durable log. The headline, the
 * label line and the tool-call binding are the trunk's (`background-middleware`), so both kinds are
 * shaped once. The reason a job cannot continue is already inside `stderr` (the restore path writes
 * it there), so it survives in the tail like any other error.
 *
 * Exported as the command-side half of the body contract: the notification renderer applies no cap,
 * so "what survives, and where the rest is" is asserted here rather than inferred from the wire.
 */
export function formatCommandBody(job: Pick<CompletedCommandJob, "stdout" | "stderr" | "logPath">): string {
  const lines: string[] = [];
  const stdout = truncateString(job.stdout, COMMAND_BODY_TAIL_CHARS, true).text;
  const stderr = truncateString(job.stderr, COMMAND_BODY_TAIL_CHARS, true).text;
  if (stdout) lines.push(`stdout:\n${stdout}`);
  if (stderr) lines.push(`stderr:\n${stderr}`);
  // Always last, and always after truncation: this is the only copy of what was cut.
  if (job.logPath) lines.push(`log: ${job.logPath} (full output)`);
  return lines.join("\n");
}
