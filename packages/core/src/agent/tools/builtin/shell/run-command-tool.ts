import { DISCOVERY_TOOL_NAME } from "@tanstack/ai";
import { z } from "zod";

import { isAbortError, isTimeoutError } from "../../../../runtime-types/abort.js";
import { defineServerTool, isProjectedModelContent } from "../../runtime/define-tool.js";
import { maybeCacheOutput } from "../../shared/cache/tool-output-cache.js";
import { runCommandOutputSchema } from "../../shared/schemas.js";

import { OutputAccumulator } from "./jobs/output-accumulator.js";
import { analyzeCommand, createAnalysisContext } from "./safety/command-analyzer.js";
import { evaluateCommandApproval } from "./safety/command-approval-policy.js";

import type { AgentToolContext } from "../../runtime/tool-context.js";
import type { RunCommandOutput } from "../../shared/schemas.js";

const COMMAND_CANCELLED_NOTICE = "[Command cancelled by user.]";

/**
 * Foreground deadline applied when the model omits `timeout` (ms).
 *
 * Without it, a no-timeout command ran with no caller deadline, so the CoreEnv safety guard's 30s
 * floor became the de-facto limit — a legitimate build/test was killed and misreported as a
 * detached-descendant failure. A default keeps the run bounded while letting normal long commands
 * finish; the model can raise it per call, and `RUN_COMMAND_TIMEOUT_MS` overrides it for a workspace.
 */
const DEFAULT_RUN_COMMAND_TIMEOUT_MS = 300_000;

/** Resolve the foreground deadline to use when the caller did not pass `timeout`. */
export async function resolveDefaultCommandTimeout(env: {
  getEnv(): Promise<Record<string, string | undefined>>;
}): Promise<number> {
  try {
    const n = Number((await env.getEnv()).RUN_COMMAND_TIMEOUT_MS);
    if (Number.isFinite(n) && n >= 1000) return n;
  } catch {
    // Env unavailable (degraded / remote failure) — the constant is the answer.
  }
  return DEFAULT_RUN_COMMAND_TIMEOUT_MS;
}

/**
 * Human-readable reason for a deadline kill, rendered by the presenters (the UI, the model, the
 * compact summary) from the structured `timedOut` / `timeoutMs` fields.
 *
 * It is deliberately NOT smeared into `stderr`: that field stays the command's own output, and a
 * synthetic line there would render twice (once as `stderr:`, once as the presenter's line) and
 * misattribute our text to the program.
 */
export function commandTimeoutNotice(timeoutMs?: number): string {
  const bound = typeof timeoutMs === "number" ? ` after ${timeoutMs}ms` : "";
  return `[Command timed out${bound} — the output above is partial.]`;
}

/**
 * Build the normal `run_command` result for a command terminated at its deadline.
 *
 * Preserves the partial stdout/stderr (the point of not throwing) and reports `-1` (the schema's
 * "not finished" value, matching the cancel branch) with `success: false`. The REASON travels
 * structurally as `timedOut` + `timeoutMs` and every presenter names it (see
 * {@link commandTimeoutNotice}); `stderr` is left exactly as the command wrote it.
 */
export function buildTimedOutCommandResult(params: {
  command: string;
  stdout: string;
  stderr: string;
  timeoutMs: number;
  durationMs: number;
  cachedOutputPath: string | null;
}): RunCommandOutput {
  return {
    command: params.command,
    stdout: params.stdout,
    stderr: params.stderr,
    exitCode: -1,
    durationMs: params.durationMs,
    success: false,
    timedOut: true,
    timeoutMs: params.timeoutMs,
    cachedOutputPath: params.cachedOutputPath,
  };
}

export const createRunCommandTool = (options?: { subagentSafe?: boolean; context?: AgentToolContext }) => {
  const commandService = options?.context?.getCommandService();
  const subagentSafe = options?.subagentSafe ?? false;
  const streamSink = options?.context?.getStreamSink();
  // `RUN_COMMAND_TIMEOUT_MS` is resolved once per tool instance: the env is stable for the session,
  // and under `--remote-env` `coreEnv.getEnv()` is an HTTP round-trip we should not pay per command.
  let resolvedDefaultTimeout: number | undefined;
  const getDefaultTimeout = async (env: { getEnv(): Promise<Record<string, string | undefined>> }): Promise<number> => {
    if (resolvedDefaultTimeout === undefined) resolvedDefaultTimeout = await resolveDefaultCommandTimeout(env);
    return resolvedDefaultTimeout;
  };
  // Background execution is a MAIN-AGENT capability: the subagent tool set has neither
  // `get_command_output` nor `kill_command`, so a background command it starts could never be
  // polled or stopped (the execute path denies it). Describing that offer to the subagent was
  // false advertising — it invited a `run_in_background: true` call that could only throw, and it
  // named two tools the subagent does not have.
  const backgroundCopy = subagentSafe
    ? "Background commands are NOT available to subagents: there is no get_command_output or kill_command " +
      "to poll or stop a job, so run_in_background is denied. "
    : "Set run_in_background=true for long-lived processes (dev servers, watchers). A finished job is pushed back to you as a notification (an idle session is woken for it), so you never have to poll to wait — end the turn and report what you started; poll on demand with get_command_output when you need intermediate output, and stop it with kill_command. " +
      `get_command_output and kill_command are lazy tools — discover them via ${DISCOVERY_TOOL_NAME} before calling. ` +
      "Background jobs also append their output to a durable log file (cachedOutputPath) that can be read with read_file. ";

  return defineServerTool({
    name: "run_command",
    present: {
      category: "commands",
      detailed: true,
    },
    description:
      "Executes a shell command in the workspace environment. Returns stdout, stderr, exit code, and execution duration. " +
      "Foreground commands have a default deadline (~5 min) when no timeout is given; pass timeout to change it. " +
      backgroundCopy +
      "Large outputs are saved to disk — use read_file with the cachedOutputPath to read specific sections. " +
      (subagentSafe
        ? "Subagent commands are restricted: only read-only, project-internal commands are allowed; write, background, or external-path commands are denied."
        : "Commands are safety-checked before approval: read-only commands run automatically, while write or external-path commands require user approval."),
    inputSchema: z.object({
      command: z.string().describe("The shell command to execute."),
      cwd: z
        .string()
        .optional()
        .describe("The working directory to run the command in, relative to the project directory."),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables to set for the command execution."),
      timeout: z
        .number()
        .int({ message: "timeout: must be an integer (milliseconds)" })
        .min(1000, { message: "timeout: must be >= 1000ms (use ms, not seconds)" })
        .optional()
        .describe(
          "Foreground deadline in milliseconds. If omitted, a default (~5 min; overridable via RUN_COMMAND_TIMEOUT_MS) applies. The process tree is terminated when the deadline passes."
        ),
      run_in_background: z
        .boolean()
        .optional()
        .describe(
          subagentSafe
            ? "Not available to subagents: background commands are denied (there is no get_command_output or " +
                "kill_command to poll or stop the job)."
            : "When true, start the command in the background and return a jobId immediately. " +
                "A finished job is pushed back to you as a notification (an idle session is woken for it), so " +
                "don't poll to wait — end the turn and report what you started. " +
                "Poll on demand with get_command_output for intermediate output, and stop it with kill_command " +
                `(both lazy — discover them via ${DISCOVERY_TOOL_NAME} first). ` +
                "The job's output is also appended to a durable log file returned as cachedOutputPath — read it with read_file " +
                '(no trailing "[exit ...]" footer means the job is still running). ' +
                "Prefer for long-lived servers (e.g. npm run dev)."
        ),
    }),
    outputSchema: runCommandOutputSchema,
    needsApproval: !subagentSafe,
    execute: async ({ command, cwd, env, timeout, run_in_background }, { toolCallId, abortSignal, coreEnv }) => {
      // Hard safety policy for subagents (no approval UI): only read-only,
      // project-internal commands execute; anything else is denied with a
      // reason surfaced to the model (insufficient permissions).
      if (subagentSafe) {
        // Background is denied outright, before the analyzer: a subagent's tool set has neither
        // `get_command_output` nor `kill_command` (see `subagent-tools.ts`), so a job it starts is one
        // it can never poll or stop. The call returns a job id, the subagent's run ends, and the job
        // keeps running behind a session with no handle on it — which is why "the command itself is
        // read-only" must not be enough to allow it.
        if (run_in_background) {
          throw new Error(
            "Background commands are not available to subagents: they have no get_command_output or " +
              "kill_command, so a job they start cannot be polled or stopped. Run the command in the " +
              "foreground instead, or ask the main agent to run it in the background."
          );
        }
        const ctx = await createAnalysisContext(coreEnv);
        const absoluteCwd = cwd ? ctx.path.resolve(ctx.rootPath, cwd) : ctx.cwd;
        const report = await analyzeCommand(command, { ...ctx, cwd: absoluteCwd });
        // The env map is part of the command here too: a `PATH`/`LD_PRELOAD` override would run a
        // program the text never named, and a subagent has no approval UI to catch it.
        const decision = evaluateCommandApproval(report, { agentKind: "subagent", envOverrides: env });
        if (decision.action !== "allow") {
          throw new Error(decision.reason ?? "Command denied by safety policy.");
        }
      }

      if (run_in_background) {
        if (!commandService) {
          throw new Error("Background commands require an AgentToolContext with an AgentCommandService.");
        }
        const started = await commandService.startBackground({
          command,
          toolCallId,
          cwd,
          env,
          coreEnv,
        });

        return {
          command,
          stdout: "",
          stderr: "",
          exitCode: -1,
          durationMs: 0,
          success: true,
          jobId: started.jobId,
          status: "running" as const,
          runInBackground: true,
          cachedOutputPath: started.cachedOutputPath ?? null,
        };
      }

      const stdoutAccumulator = new OutputAccumulator();
      const stderrAccumulator = new OutputAccumulator();

      const encoder = new TextEncoder();
      const startTime = Date.now();

      // Give every foreground command an effective deadline, so a long one takes the real timeout
      // path (kill the process tree, settle as a typed timeout) instead of the safety guard's wall.
      const effectiveTimeout = timeout ?? (await getDefaultTimeout(coreEnv));

      // The user aborting the run is not a tool failure. CoreEnv surfaces it as an
      // ExecutionError("aborted") (native) or an equivalent throw (remote), which TanStack
      // would otherwise settle as `output-error` — a red cross on a row the USER stopped,
      // and no `cancelled` marker for the UI to read. Catch it and return a normal result
      // carrying `cancelled: true`, the same contract as the `task` tool's `aborted` flag;
      // `getInlineSummary` / `isCancelledToolCall` render both shapes as "cancelled". A deadline
      // expiry is handled below the same way (a typed timeout returns a normal result carrying the
      // partial output, since ExecutionError cannot); everything else still throws.
      let result;
      try {
        result = await coreEnv.runCommand(command, {
          cwd,
          env,
          timeout: effectiveTimeout,
          signal: abortSignal,
          onStdout: (chunk) => {
            stdoutAccumulator.append(encoder.encode(chunk));
            streamSink?.commandStdout(toolCallId, chunk);
          },
          onStderr: (chunk) => {
            stderrAccumulator.append(encoder.encode(chunk));
            streamSink?.commandStderr(toolCallId, chunk);
          },
        });
      } catch (err) {
        // A user abort is not a failure — return a normal "cancelled" result (see the comment above).
        if (isAbortError(err, abortSignal)) {
          stdoutAccumulator.finish();
          stderrAccumulator.finish();
          // A cancelled command's output is whatever the accumulator kept, so the note must say the
          // file holds a tail rather than the whole run.
          const stdoutSnapshot = stdoutAccumulator.snapshot();
          const stderrSnapshot = stderrAccumulator.snapshot();
          const stdoutResult = await maybeCacheOutput(coreEnv, stdoutSnapshot.content, `${toolCallId}-stdout`, {
            truncated: stdoutSnapshot.truncated,
          });
          const stderrResult = await maybeCacheOutput(coreEnv, stderrSnapshot.content, `${toolCallId}-stderr`, {
            truncated: stderrSnapshot.truncated,
          });
          return {
            command,
            stdout: stdoutResult.content,
            stderr: stderrResult.content + "\n\n" + COMMAND_CANCELLED_NOTICE,
            // No exit code exists for a killed process; -1 is the schema's "not finished"
            // value and `success: false` keeps the run from reading as a clean exit.
            exitCode: -1,
            durationMs: 0,
            success: false,
            cancelled: true,
            cachedOutputPath: stdoutResult.cachedOutputPath ?? stderrResult.cachedOutputPath ?? null,
          };
        }

        // A deadline is a failure, but not a reason to discard the work: the command may have
        // produced output before it was killed. `ExecutionError` carries no output fields (by
        // design), so the tool catches the typed timeout and returns a normal result carrying the
        // partial output — symmetric with the cancel branch above.
        if (isTimeoutError(err)) {
          stdoutAccumulator.finish();
          stderrAccumulator.finish();
          // Same as the cancel branch: a deadline kill leaves the accumulator's own view of the output.
          const stdoutSnapshot = stdoutAccumulator.snapshot();
          const stderrSnapshot = stderrAccumulator.snapshot();
          const stdoutResult = await maybeCacheOutput(coreEnv, stdoutSnapshot.content, `${toolCallId}-stdout`, {
            truncated: stdoutSnapshot.truncated,
          });
          const stderrResult = await maybeCacheOutput(coreEnv, stderrSnapshot.content, `${toolCallId}-stderr`, {
            truncated: stderrSnapshot.truncated,
          });
          return buildTimedOutCommandResult({
            command,
            stdout: stdoutResult.content,
            stderr: stderrResult.content,
            timeoutMs: effectiveTimeout,
            durationMs: Date.now() - startTime,
            cachedOutputPath: stdoutResult.cachedOutputPath ?? stderrResult.cachedOutputPath ?? null,
          });
        }

        throw err;
      }

      stdoutAccumulator.finish();
      stderrAccumulator.finish();

      // The cache file must hold the FULL output. It is advertised as such in the preview the model
      // reads ("Full output saved to …") and it is what `read_file` is told to open when the visible
      // output is a preview — so caching the accumulator's text wrote a *truncated* file, one that
      // stopped exactly where the display did.
      //
      // `result.stdout` is the host's own accumulation of every chunk (the local host joins them all,
      // and the HTTP plane returns its buffers verbatim), so it is the full text; the accumulator keeps
      // only a bounded tail (50KB / 2000 lines) to cap the agent's memory, and is the fallback for a
      // host that streams its chunks but returns nothing.
      const stdoutSnapshot = stdoutAccumulator.snapshot();
      const stderrSnapshot = stderrAccumulator.snapshot();
      const stdoutFull = result.stdout || stdoutSnapshot.content;
      const stderrFull = result.stderr || stderrSnapshot.content;

      const stdoutResult = await maybeCacheOutput(coreEnv, stdoutFull, `${toolCallId}-stdout`, {
        // Only the accumulator's own text is a bounded view; the host's buffers are the whole output.
        truncated: !result.stdout && stdoutSnapshot.truncated,
      });
      const stderrResult = await maybeCacheOutput(coreEnv, stderrFull, `${toolCallId}-stderr`, {
        truncated: !result.stderr && stderrSnapshot.truncated,
      });

      const cachedOutputPath = stdoutResult.cachedOutputPath ?? stderrResult.cachedOutputPath ?? null;

      return {
        command,
        stdout: stdoutResult.content,
        stderr: stderrResult.content,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        success: result.exitCode === 0,
        cachedOutputPath,
      };
    },
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: RunCommandOutput }) {
      if (isProjectedModelContent(output)) return output;
      if (output.runInBackground && output.jobId) {
        return [
          {
            type: "text" as const,
            content:
              `Started background job ${output.jobId} for: ${output.command}\n` +
              `Status: ${output.status ?? "running"}\n` +
              // The delivery contract, stated where the model reads it right after starting the job:
              // `background-middleware` pushes the completion, and an idle session is woken for it
              // (`ManagedAgent.wakeForBackgroundJobs`). The polling route is for intermediate output —
              // not for waiting, which is what the old text implied.
              `You do not need to poll to wait for it: its completion is pushed back to you as a notification ` +
              `(an idle session is woken for it), so end the turn and report what you started. ` +
              `get_command_output and kill_command are lazy tools — call ${DISCOVERY_TOOL_NAME} to get them, ` +
              `then poll on demand with get_command_output for jobId="${output.jobId}" (intermediate output/status) ` +
              `and use kill_command to stop the job when finished. ` +
              (output.cachedOutputPath
                ? `Full output is appended to ${output.cachedOutputPath} — read it with read_file ` +
                  `(a missing "[exit ...]" footer means the job is still running). `
                : ""),
          },
        ];
      }
      // A user abort is not a command result: without this the model reads `exit code: -1`
      // and diagnoses a crash that never happened. Mirror the task tool's contract, where
      // the cancel notice reaches the parent model rather than only a flag.
      if (output.cancelled) {
        return [
          {
            type: "text" as const,
            content:
              `[Command cancelled by user.] The run was stopped while this command was executing; ` +
              `the partial output below is what it produced before the stop.\n` +
              (output.stderr?.trim?.() ? `stderr:\n${output.stderr}\n` : "") +
              (output.stdout ?? ""),
          },
        ];
      }
      // A deadline is a failure with partial output: say so and show what the command produced,
      // rather than a bare `Exit code: -1` that reads like a crash (and would hide the output the
      // user watched being produced).
      if (output.timedOut) {
        return [
          { type: "text" as const, content: commandTimeoutNotice(output.timeoutMs) },
          ...(output.stderr?.trim?.() ? [{ type: "text" as const, content: `stderr:\n${output.stderr}` }] : []),
          { type: "text" as const, content: output.stdout },
        ];
      }
      return [
        { type: "text" as const, content: `Exit code: ${output.exitCode}` },
        ...(output.stderr?.trim?.() ? [{ type: "text" as const, content: `stderr:\n${output.stderr}` }] : []),
        { type: "text" as const, content: output.stdout },
      ];
    },
  });
};
