import { DISCOVERY_TOOL_NAME } from "@tanstack/ai";
import { z } from "zod";

import { isAbortError } from "../../runtime-types/abort.js";

import { analyzeCommand, createAnalysisContext } from "./command-safety/command-analyzer.js";
import { evaluateCommandApproval } from "./command-safety/command-approval-policy.js";
import { defineServerTool } from "./runtime/define-tool.js";
import { commandJobRegistry } from "./util/command-job-registry.js";
import { OutputAccumulator } from "./util/output-accumulator.js";
import { emitStreamingChunk } from "./util/streaming-callback.js";
import { maybeCacheOutput } from "./util/tool-output-cache.js";
import { runCommandOutputSchema } from "./util/types.js";

import type { RunCommandOutput } from "./util/types.js";

const COMMAND_CANCELLED_NOTICE = "[Command cancelled by user.]";

export const createRunCommandTool = (options?: { subagentSafe?: boolean }) => {
  const subagentSafe = options?.subagentSafe ?? false;
  return defineServerTool({
    name: "run_command",
    present: {
      category: "commands",
      detailed: true,
    },
    description:
      "Executes a shell command in the workspace environment. Returns stdout, stderr, exit code, and execution duration. " +
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
        .describe("Timeout in milliseconds (foreground only). If the command takes longer, it will be terminated."),
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
        const ctx = await createAnalysisContext();
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

        const job = commandJobRegistry.create(command);

        try {
          const handle = await coreEnv.startCommand(command, {
            cwd,
            env,
            onStdout: (chunk) => {
              commandJobRegistry.appendStdout(job.id, chunk);
            },
            onStderr: (chunk) => {
              commandJobRegistry.appendStderr(job.id, chunk);
            },
            onExit: (exitCode) => {
              commandJobRegistry.markExited(job.id, exitCode);
            },
          });
          commandJobRegistry.setKill(job.id, handle.kill);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          commandJobRegistry.markFailed(job.id, message);
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

      // The user aborting the run is not a tool failure. CoreEnv surfaces it as an
      // ExecutionError("aborted") (native) or an equivalent throw (remote), which TanStack
      // would otherwise settle as `output-error` — a red cross on a row the USER stopped,
      // and no `cancelled` marker for the UI to read. Catch it and return a normal result
      // carrying `cancelled: true`, the same contract as the `task` tool's `aborted` flag;
      // `getInlineSummary` / `isCancelledToolCall` render both shapes as "cancelled".
      // Everything else still throws, so genuine failures keep their error row.
      let result;
      try {
        result = await coreEnv.runCommand(command, {
          cwd,
          env,
          timeout,
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
        if (!isAbortError(err, abortSignal)) throw err;

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

      stdoutAccumulator.finish();
      stderrAccumulator.finish();

      // Prefer streamed accumulation; fall back to CommandResult buffers when the
      // CoreEnv implementation does not invoke onStdout/onStderr (e.g. older remotes).
      const stdoutRaw = stdoutAccumulator.snapshot().content || result.stdout || "";
      const stderrRaw = stderrAccumulator.snapshot().content || result.stderr || "";

      const stdoutResult = await maybeCacheOutput(coreEnv, stdoutRaw, `${toolCallId}-stdout`);
      const stderrResult = await maybeCacheOutput(coreEnv, stderrRaw, `${toolCallId}-stderr`);

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
      return [
        { type: "text" as const, content: `Exit code: ${output.exitCode}` },
        ...(output.stderr?.trim?.() ? [{ type: "text" as const, content: `stderr:\n${output.stderr}` }] : []),
        { type: "text" as const, content: output.stdout },
      ];
    },
  });
};
