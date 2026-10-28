/**
 * Native shell command execution (with optional OS sandbox wrapping).
 */

import { ExecutionError, errorMessage } from "@codent/core";

import {
  annotateOsSandboxStderr,
  cleanupOsSandboxAfterCommand,
  ensureOsSandbox,
  wrapOsSandboxCommand,
} from "./os-sandbox.js";
import { spawnCommand, spawnDetachedCommand } from "./shell.js";

import type { RunCommandOptions, CommandResult, StartCommandHandle, StartCommandOptions } from "@codent/core";

type ResolvePath = (inputPath: string) => string;

/**
 * Map a failed `spawnCommand` to a `CommandResult`, or rethrow the typed abort/timeout errors.
 *
 * A safety kill (the last-resort guard for a process that never exits) is not a command failure:
 * the command's own stderr is preserved and the guard's reason is appended ALONGSIDE it — never
 * `stderr || reason`, which silently drops one of the two — and the exit code is `-1` (the schema's
 * "not finished" value), not a fabricated `1`. A generic spawn error keeps the previous `1`.
 *
 * Exported so the contract is directly testable: the guard bound is a process-wide constant, so
 * driving it end-to-end would need a 30s command.
 */
export function resolveRunFailure(params: {
  error: unknown;
  stdout: string;
  stderr: string;
  /** Caller timeout in milliseconds, for the timeout message. */
  timeoutMs?: number;
}): { stdout: string; stderr: string; exitCode: number } {
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  if (message === "aborted") {
    throw new ExecutionError("aborted", "Command aborted");
  }
  if (message.startsWith("timeout:")) {
    throw new ExecutionError("timeout", `Command timed out after ${params.timeoutMs ?? 0}ms`);
  }
  const safetyKill = message.startsWith("safety-timeout:");
  const reason = safetyKill ? message.slice("safety-timeout:".length) : `Error: ${message}`;
  const stderr = params.stderr.trim() ? `${params.stderr}\n\n${reason}` : reason;
  return { stdout: params.stdout, stderr, exitCode: safetyKill ? -1 : 1 };
}

/**
 * Execute a command in the workspace with native bash, optionally OS-sandboxed.
 */
export async function runNativeCommand(
  rootPath: string,
  resolvePath: ResolvePath,
  command: string,
  options: RunCommandOptions | undefined,
  useOsSandbox: boolean
): Promise<CommandResult> {
  const startTime = Date.now();
  const cwd = options?.cwd ? resolvePath(options.cwd) : rootPath;
  const mergedEnv = options?.env ? { ...process.env, ...options.env } : process.env;

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  let osSandbox = false;
  if (useOsSandbox) {
    osSandbox = await ensureOsSandbox(rootPath);
  }

  try {
    let commandToRun = command;
    let useShellString = false;

    if (osSandbox) {
      commandToRun = await wrapOsSandboxCommand(command);
      useShellString = true;
    }

    const result = await spawnCommand(commandToRun, {
      cwd,
      env: mergedEnv as NodeJS.ProcessEnv,
      timeout: options?.timeout ? Math.ceil(options.timeout / 1000) : undefined,
      signal: options?.signal,
      useShellString,
      onStdout: (chunk: string) => {
        stdoutChunks.push(chunk);
        options?.onStdout?.(chunk);
      },
      onStderr: (chunk: string) => {
        stderrChunks.push(chunk);
        options?.onStderr?.(chunk);
      },
    });

    const stdout = stdoutChunks.join("");
    let stderr = stderrChunks.join("");
    if (osSandbox) {
      stderr = annotateOsSandboxStderr(command, stderr);
    }

    return {
      stdout,
      stderr,
      exitCode: result.exitCode ?? 1,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const mapped = resolveRunFailure({
      error: err,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
      timeoutMs: options?.timeout,
    });

    return {
      ...mapped,
      stderr: osSandbox ? annotateOsSandboxStderr(command, mapped.stderr) : mapped.stderr,
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (osSandbox) {
      cleanupOsSandboxAfterCommand();
    }
  }
}

/**
 * Start a command in the background (does not await exit).
 * OS sandbox wrapping matches foreground when enabled.
 */
export async function startNativeCommand(
  rootPath: string,
  resolvePath: ResolvePath,
  command: string,
  options: StartCommandOptions | undefined,
  useOsSandbox: boolean
): Promise<StartCommandHandle> {
  const cwd = options?.cwd ? resolvePath(options.cwd) : rootPath;
  const mergedEnv = options?.env ? { ...process.env, ...options.env } : process.env;

  let osSandbox = false;
  if (useOsSandbox) {
    osSandbox = await ensureOsSandbox(rootPath);
  }

  let commandToRun = command;
  let useShellString = false;
  if (osSandbox) {
    commandToRun = await wrapOsSandboxCommand(command);
    useShellString = true;
  }

  const handle = await spawnDetachedCommand(commandToRun, {
    cwd,
    env: mergedEnv as NodeJS.ProcessEnv,
    useShellString,
    onStdout: options?.onStdout,
    onStderr: (chunk) => {
      const annotated = osSandbox ? annotateOsSandboxStderr(command, chunk) : chunk;
      options?.onStderr?.(annotated);
    },
  });

  void handle.exited
    .then((code) => {
      options?.onExit?.(code);
      if (osSandbox) cleanupOsSandboxAfterCommand();
    })
    .catch((err) => {
      options?.onStderr?.(errorMessage(err));
      options?.onExit?.(1);
      if (osSandbox) cleanupOsSandboxAfterCommand();
    });

  return { pid: handle.pid, kill: handle.kill };
}
