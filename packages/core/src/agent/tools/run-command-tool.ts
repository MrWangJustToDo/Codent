import { DISCOVERY_TOOL_NAME } from "@tanstack/ai";
import { z } from "zod";

import { isAbortError, isTimeoutError } from "../../runtime-types/abort.js";

import { analyzeCommand, createAnalysisContext } from "./command-safety/command-analyzer.js";
import { evaluateCommandApproval } from "./command-safety/command-approval-policy.js";
import { defineServerTool, isProjectedModelContent } from "./runtime/define-tool.js";
import { commandJobRegistry } from "./util/command-job-registry.js";
import { OutputAccumulator } from "./util/output-accumulator.js";
import { emitStreamingChunk } from "./util/streaming-callback.js";
import { maybeCacheOutput } from "./util/tool-output-cache.js";
import { runCommandOutputSchema } from "./util/types.js";

import type { RunCommandOutput } from "./util/types.js";
import type { ManagedAgent } from "../../runtime-types/hosts.js";

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

export const createRunCommandTool = (options?: { subagentSafe?: boolean; managed?: ManagedAgent }) => {
  const registry = options?.managed?.getCommandJobRegistry() ?? commandJobRegistry;
  const subagentSafe = options?.subagentSafe ?? false;
  // `RUN_COMMAND_TIMEOUT_MS` is resolved once per tool instance: the env is stable for the session,
  // and under `--remote-env` `coreEnv.getEnv()` is an HTTP round-trip we should not pay per command.
  let resolvedDefaultTimeout: number | undefined;
  const getDefaultTimeout = async (env: { getEnv(): Promise<Record<string, string | undefined>> }): Promise<number> => {
    if (resolvedDefaultTimeout === undefined) resolvedDefaultTimeout = await resolveDefaultCommandTimeout(env);
    return resolvedDefaultTimeout;
  };
  return defineServerTool({
    name: "run_command",
    present: {
      category: "commands",
      detailed: true,
    },
    description:
      "Executes a shell command in the workspace environment. Returns stdout, stderr, exit code, and execution duration. " +
      "Foreground commands have a default deadline (~5 min) when no timeout is given; pass timeout to change it. " +
      "Set run_in_background=true for long-lived processes (dev servers, watchers); then poll with get_command_output and stop with kill_command. " +
      `get_command_output and kill_command are lazy tools — discover them via ${DISCOVERY_TOOL_NAME} before calling. ` +
      "Background jobs also append their output to a durable log file (cachedOutputPath) that can be read with read_file. " +
      "Large outputs are saved to disk — use read_file with the cachedOutputPath to read specific sections. " +
      (subagentSafe
        ? "Subagent commands are restricted: only read-only, project-internal commands are allowed; write or external-path commands are denied."
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
          "When true, start the command in the background and return a jobId immediately. " +
            "Use get_command_output to read output/status and kill_command to stop it (both lazy — " +
            `discover them via ${DISCOVERY_TOOL_NAME} first). ` +
            "The job's output is also appended to a durable log file returned as cachedOutputPath — read it with read_file " +
            '(no trailing "[exit ...]" footer means the job is still running). ' +
            "Prefer for long-lived servers (e.g. npm run dev)."
        ),
    }),
    outputSchema: runCommandOutputSchema,
    needsApproval: !subagentSafe,
    execute: async (
      { command, cwd, env, timeout, run_in_background },
      { toolCallId, abortSignal, agentId, coreEnv }
    ) => {
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
        const decision = evaluateCommandApproval(report, { agentKind: "subagent" });
        if (decision.action !== "allow") {
          throw new Error(decision.reason ?? "Command denied by safety policy.");
        }
      }

      if (run_in_background) {
        if (!coreEnv.startCommand) {
          throw new Error(
            "Background commands are not supported in this environment. " +
              "Omit run_in_background or use a local/node or playground CoreEnv that implements startCommand."
          );
        }

        const job = registry.create(command);

        try {
          const handle = await coreEnv.startCommand(command, {
            cwd,
            env,
            onStdout: (chunk) => {
              registry.appendStdout(job.id, chunk);
            },
            onStderr: (chunk) => {
              registry.appendStderr(job.id, chunk);
            },
            onExit: (exitCode) => {
              registry.markExited(job.id, exitCode);
            },
          });
          registry.setKill(job.id, handle.kill);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          registry.markFailed(job.id, message);
          throw err;
        }

        return {
          command,
          stdout: "",
          stderr: "",
          exitCode: -1,
          durationMs: 0,
          success: true,
          jobId: job.id,
          status: "running" as const,
          runInBackground: true,
          cachedOutputPath: job.logPath,
        };
      }

      const stdoutAccumulator = new OutputAccumulator({
        tempFilePrefix: `${toolCallId}-stdout`,
      });
      const stderrAccumulator = new OutputAccumulator({
        tempFilePrefix: `${toolCallId}-stderr`,
      });

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
            if (agentId) emitStreamingChunk(toolCallId, "stdout", chunk, { agentId });
          },
          onStderr: (chunk) => {
            stderrAccumulator.append(encoder.encode(chunk));
            if (agentId) emitStreamingChunk(toolCallId, "stderr", chunk, { agentId });
          },
        });
      } catch (err) {
        // A user abort is not a failure — return a normal "cancelled" result (see the comment above).
        if (isAbortError(err, abortSignal)) {
          stdoutAccumulator.finish();
          stderrAccumulator.finish();
          const stdoutRaw = stdoutAccumulator.snapshot().content;
          const stderrRaw = stderrAccumulator.snapshot().content;
          const stdoutResult = await maybeCacheOutput(coreEnv, stdoutRaw, `${toolCallId}-stdout`);
          const stderrResult = await maybeCacheOutput(coreEnv, stderrRaw, `${toolCallId}-stderr`);
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
          const stdoutResult = await maybeCacheOutput(
            coreEnv,
            stdoutAccumulator.snapshot().content,
            `${toolCallId}-stdout`
          );
          const stderrResult = await maybeCacheOutput(
            coreEnv,
            stderrAccumulator.snapshot().content,
            `${toolCallId}-stderr`
          );
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
      const stdoutFull = result.stdout || stdoutAccumulator.snapshot().content;
      const stderrFull = result.stderr || stderrAccumulator.snapshot().content;

      const stdoutResult = await maybeCacheOutput(coreEnv, stdoutFull, `${toolCallId}-stdout`);
      const stderrResult = await maybeCacheOutput(coreEnv, stderrFull, `${toolCallId}-stderr`);

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
              `get_command_output and kill_command are lazy tools — call ${DISCOVERY_TOOL_NAME} to get them, ` +
              `then use get_command_output with jobId="${output.jobId}" to read output/status ` +
              `and kill_command to stop the job when finished. ` +
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
