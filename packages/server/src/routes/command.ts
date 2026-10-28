import { ExecutionError, errorMessage } from "@codent/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { getServerEnv } from "../server-runtime.js";

import type { CommandJobStatus, StartCommandHandle } from "@codent/core";

/**
 * The options a command route forwards, plus the CLIENT's abort signal.
 *
 * An `AbortSignal` cannot travel in a JSON body — and it does not need to: when the caller's request is
 * aborted (Esc in the CLI), this handler's `c.req.raw.signal` fires, and the host kills the child with it.
 * That is the same channel `/api/fetch/proxy` uses, and it is what makes Esc on a `--remote-env` search
 * stop the server-side `rg` instead of leaving it to run out its own deadline.
 *
 * `exec` (the simple-command primitive) is deliberately not wired: neither `CoreEnvExecOptions` nor the
 * Node implementation carries a signal, and nothing on the agent tool path calls it.
 */
function withClientAbort<T extends Record<string, unknown> | undefined>(
  options: T,
  signal: AbortSignal
): T & { signal: AbortSignal } {
  return { ...options, signal } as T & { signal: AbortSignal };
}

const runCommandSchema = z.object({
  command: z.string(),
  options: z
    .object({
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      timeout: z.number().int().min(0).optional(),
    })
    .optional(),
});

const execSchema = z.object({
  command: z.string(),
  options: z
    .object({
      cwd: z.string().optional(),
      timeout: z.number().int().min(0).optional(),
      env: z.record(z.string(), z.string().optional()).optional(),
    })
    .optional(),
});

const execFileSchema = z.object({
  file: z.string(),
  args: z.array(z.string()).default([]),
  options: z
    .object({
      cwd: z.string().optional(),
      timeout: z.number().int().min(0).optional(),
      env: z.record(z.string(), z.string().optional()).optional(),
    })
    .optional(),
});

const startCommandSchema = z.object({
  command: z.string(),
  options: z
    .object({
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

const commandOutputSchema = z.object({
  id: z.string(),
  sinceStdout: z.number().int().min(0).optional(),
  sinceStderr: z.number().int().min(0).optional(),
});

function handleCommandError(err: unknown): { body: Record<string, unknown>; status: 400 | 500 } {
  if (err instanceof ExecutionError) {
    return {
      body: { error: true, name: "ExecutionError", code: err.code, message: err.message },
      status: 400,
    };
  }
  const message = errorMessage(err);
  return { body: { error: true, name: "Error", code: "unknown", message }, status: 500 };
}

// ============================================================================
// Background Job Tracking
// ============================================================================

interface ServerJob {
  handle: StartCommandHandle;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  status: CommandJobStatus;
}

const serverJobs = new Map<string, ServerJob>();

export function destroyAllServerJobs(): void {
  for (const job of serverJobs.values()) {
    job.handle.kill().catch(() => {});
  }
  serverJobs.clear();
}

export const commandRoutes = new Hono()
  .post("/run", zValidator("json", runCommandSchema), async (c) => {
    try {
      const { command, options } = c.req.valid("json");
      const result = await getServerEnv().runCommand(command, withClientAbort(options, c.req.raw.signal));
      return c.json(result);
    } catch (err) {
      const { body, status } = handleCommandError(err);
      return c.json(body, status);
    }
  })
  .post("/exec", zValidator("json", execSchema), async (c) => {
    try {
      const { command, options } = c.req.valid("json");
      const result = await getServerEnv().exec(command, options);
      return c.json(result);
    } catch (err) {
      const { body, status } = handleCommandError(err);
      return c.json(body, status);
    }
  })
  .post("/exec-file", zValidator("json", execFileSchema), async (c) => {
    try {
      const { file, args, options } = c.req.valid("json");
      const coreEnv = getServerEnv();
      // Feature-detect rather than assume: a server whose environment has no process
      // runtime cannot exec, and the client falls back to the string path in that case.
      if (!coreEnv.execFile) {
        return c.json(
          {
            error: true,
            name: "Error",
            code: "unsupported",
            message: "Argument-vector execution not supported on this server.",
          },
          400
        );
      }
      const result = await coreEnv.execFile(file, args, withClientAbort(options, c.req.raw.signal));
      return c.json(result);
    } catch (err) {
      const { body, status } = handleCommandError(err);
      return c.json(body, status);
    }
  })
  .post("/start", zValidator("json", startCommandSchema), async (c) => {
    try {
      const { command, options } = c.req.valid("json");

      const coreEnv = getServerEnv();
      if (!coreEnv.startCommand) {
        return c.json(
          {
            error: true,
            name: "Error",
            code: "unsupported",
            message: "Background commands not supported on this server.",
          },
          400
        );
      }

      const id = crypto.randomUUID();

      const job: ServerJob = {
        handle: null as unknown as StartCommandHandle,
        stdout: "",
        stderr: "",
        exitCode: null,
        status: "running",
      };

      const handle = await coreEnv.startCommand(command, {
        cwd: options?.cwd,
        env: options?.env,
        onStdout: (chunk: string) => {
          job.stdout += chunk;
        },
        onStderr: (chunk: string) => {
          job.stderr += chunk;
        },
        onExit: (exitCode: number | null) => {
          job.exitCode = exitCode;
          job.status = exitCode === 0 ? "exited" : "failed";
        },
      });

      job.handle = handle;
      serverJobs.set(id, job);

      return c.json({ id, pid: handle.pid });
    } catch (err) {
      const { body, status } = handleCommandError(err);
      return c.json(body, status);
    }
  })
  .post("/output", zValidator("json", commandOutputSchema), async (c) => {
    try {
      const { id, sinceStdout, sinceStderr } = c.req.valid("json");

      const job = serverJobs.get(id);
      if (!job) {
        return c.json({ error: true, name: "Error", code: "not_found", message: `Job ${id} not found` }, 404);
      }

      const stdout = sinceStdout !== undefined ? job.stdout.slice(sinceStdout) : job.stdout;
      const stderr = sinceStderr !== undefined ? job.stderr.slice(sinceStderr) : job.stderr;

      return c.json({
        id,
        status: job.status,
        stdout,
        stderr,
        exitCode: job.exitCode,
        running: job.status === "running",
      });
    } catch (err) {
      const { body, status } = handleCommandError(err);
      return c.json(body, status);
    }
  })
  .delete("/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const job = serverJobs.get(id);
      if (!job) {
        return c.json({ error: true, name: "Error", code: "not_found", message: `Job ${id} not found` }, 404);
      }

      await job.handle.kill();
      job.status = "killed";
      serverJobs.delete(id);

      return c.json({ id, status: "killed", killed: true });
    } catch (err) {
      const { body, status } = handleCommandError(err);
      return c.json(body, status);
    }
  });
