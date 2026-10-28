import { ExecutionError, errorMessage } from "@codent/core";

import { toWebContainerSpawnCwd } from "./workspace-path.js";

import type {
  CommandResult,
  CoreEnvExecOptions,
  CoreEnvExecResult,
  RunCommandOptions,
  StartCommandHandle,
  StartCommandOptions,
} from "@codent/core";
import type { WebContainer, WebContainerProcess } from "@webcontainer/api";

/** WebContainer / jsh often emits CRLF; keep LF for Ink + consistent tool output. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function collectProcessOutput(
  wc: WebContainer,
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  options: { onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void; timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const process = await wc.spawn("jsh", ["-c", command], {
    cwd,
    env,
  });

  const stdoutChunks: string[] = [];
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let carry = "";

  const outputDone = process.output.pipeTo(
    new WritableStream<string>({
      write(chunk) {
        // Avoid splitting CRLF across chunks when notifying the UI stream.
        const combined = carry + chunk;
        if (combined.endsWith("\r")) {
          carry = "\r";
          const body = combined.slice(0, -1);
          if (body) {
            stdoutChunks.push(body);
            options.onStdout?.(normalizeNewlines(body));
          }
          return;
        }
        carry = "";
        stdoutChunks.push(combined);
        options.onStdout?.(normalizeNewlines(combined));
      },
    })
  );

  if (options.timeout && options.timeout > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      try {
        process.kill();
      } catch {
        // ignore
      }
    }, options.timeout);
  }

  try {
    const [exitCode] = await Promise.all([process.exit, outputDone]);
    if (timedOut) {
      throw new ExecutionError("timeout", `Command timed out after ${options.timeout}ms`);
    }
    if (carry) {
      stdoutChunks.push(carry);
      options.onStdout?.(normalizeNewlines(carry));
    }
    return {
      stdout: normalizeNewlines(stdoutChunks.join("")),
      stderr: "",
      exitCode: exitCode ?? 1,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function attachProcessOutput(process: WebContainerProcess, onStdout?: (chunk: string) => void): void {
  let carry = "";
  void process.output
    .pipeTo(
      new WritableStream<string>({
        write(chunk) {
          const combined = carry + chunk;
          if (combined.endsWith("\r")) {
            carry = "\r";
            const body = combined.slice(0, -1);
            if (body) onStdout?.(normalizeNewlines(body));
            return;
          }
          carry = "";
          onStdout?.(normalizeNewlines(combined));
        },
        close() {
          if (carry) onStdout?.(normalizeNewlines(carry));
        },
      })
    )
    .catch(() => {
      // Process killed or stream aborted — ignore.
    });
}

export async function runWebContainerCommand(
  wc: WebContainer,
  rootPath: string,
  command: string,
  options?: RunCommandOptions & { onChange?: () => void }
): Promise<CommandResult> {
  const start = Date.now();
  const cwd = toWebContainerSpawnCwd(rootPath, options?.cwd);
  try {
    const result = await collectProcessOutput(wc, command, cwd, options?.env, {
      onStdout: options?.onStdout,
      onStderr: options?.onStderr,
      timeout: options?.timeout,
    });
    options?.onChange?.();
    return {
      ...result,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    if (err instanceof ExecutionError) throw err;
    options?.onChange?.();
    return {
      stdout: "",
      stderr: errorMessage(err),
      exitCode: 1,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Start a WebContainer process without awaiting exit.
 */
export async function startWebContainerCommand(
  wc: WebContainer,
  rootPath: string,
  command: string,
  options?: StartCommandOptions & { onChange?: () => void }
): Promise<StartCommandHandle> {
  const cwd = toWebContainerSpawnCwd(rootPath, options?.cwd);
  const process = await wc.spawn("jsh", ["-c", command], {
    cwd,
    env: options?.env,
  });

  attachProcessOutput(process, options?.onStdout);

  void process.exit
    .then((code) => {
      options?.onExit?.(code ?? 1);
      options?.onChange?.();
    })
    .catch(() => {
      options?.onExit?.(1);
      options?.onChange?.();
    });

  return {
    kill: async () => {
      try {
        process.kill();
      } catch {
        // already exited
      }
    },
  };
}

export async function execWebContainerCommand(
  wc: WebContainer,
  rootPath: string,
  command: string,
  options?: CoreEnvExecOptions & { onChange?: () => void }
): Promise<CoreEnvExecResult> {
  const cwd = toWebContainerSpawnCwd(rootPath, options?.cwd);
  const env = options?.env
    ? Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] != null))
    : undefined;

  try {
    const result = await collectProcessOutput(wc, command, cwd, env, { timeout: options?.timeout });
    options?.onChange?.();
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
    };
  } catch (err) {
    if (err instanceof ExecutionError) throw err;
    options?.onChange?.();
    return {
      stdout: "",
      stderr: errorMessage(err),
      code: 1,
    };
  }
}
