import { errorMessage } from "@codent/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { z } from "zod";

import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

// ============================================================================
// Schemas
// ============================================================================

const initSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

// ============================================================================
// Line Buffer — wraps stdout and provides buffered readLine()
// ============================================================================

class LineBuffer {
  private buffer: string[] = [];
  private resolvers: Array<(line: string) => void> = [];
  private closed = false;

  constructor(stream: Readable) {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line: string) => {
      if (this.resolvers.length > 0) {
        this.resolvers.shift()!(line);
      } else {
        this.buffer.push(line);
      }
    });

    rl.on("close", () => {
      this.closed = true;
      for (const resolve of this.resolvers) {
        resolve("");
      }
      this.resolvers.length = 0;
    });
  }

  async readLine(): Promise<string | null> {
    if (this.buffer.length > 0) return this.buffer.shift()!;
    if (this.closed) return null;
    return new Promise<string>((resolve) => this.resolvers.push(resolve));
  }
}

// ============================================================================
// Session Management
// ============================================================================

interface McpSession {
  process: ChildProcess;
  reader: LineBuffer;
}

const sessions = new Map<string, McpSession>();

function cleanupSession(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);

  try {
    session.process.kill("SIGKILL");
  } catch {
    // Process may already be dead
  }
}

// Cleanup all sessions on server shutdown (no-op if already destroyed)
let cleanupRegistered = false;
function ensureCleanupOnExit(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = () => {
    for (const [id] of sessions) cleanupSession(id);
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

// ============================================================================
// Routes
// ============================================================================

export const mcpRoutes = new Hono()
  // POST /init — spawn a stdio process for an MCP server
  .post("/init", zValidator("json", initSchema), async (c) => {
    try {
      const { command, args, env } = c.req.valid("json");
      const id = randomUUID();

      const child = spawn(command, args ?? [], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Fail fast when the binary does not exist / cannot execute — spawn
      // errors arrive asynchronously (ENOENT), so wait for either the
      // successful 'spawn' event or the 'error' event before answering.
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      // Clean up on error/exit
      child.on("error", () => cleanupSession(id));
      child.on("exit", () => cleanupSession(id));

      const reader = new LineBuffer(child.stdout!);

      // Error output goes to server logs for debugging
      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(`[mcp:${id}] ${chunk.toString()}`);
      });

      sessions.set(id, { process: child, reader });
      ensureCleanupOnExit();

      return c.json({ id });
    } catch (err) {
      const message = errorMessage(err);
      return c.json({ error: true, message }, 500);
    }
  })

  // POST /:id/message — send a JSON-RPC message to an MCP server
  .post("/:id/message", async (c) => {
    const { id } = c.req.param();
    const session = sessions.get(id);
    if (!session || session.process.killed) {
      return c.json({ error: "Session not found or already terminated" }, 404);
    }

    const body = await c.req.json();
    const message = body.message;

    if (!message || typeof message !== "object") {
      return c.json({ error: "Invalid message" }, 400);
    }

    try {
      // Write JSON-RPC message to stdin
      session.process.stdin!.write(JSON.stringify(message) + "\n");

      // Notifications (no 'id' field) don't expect a response
      if (message.id === undefined || message.id === null) {
        return c.json({ responses: [] });
      }

      // Read lines until we get a response matching the request ID
      const responses: unknown[] = [];
      while (true) {
        const line = await session.reader.readLine();
        if (line === null) break; // stream closed

        try {
          const parsed = JSON.parse(line);
          responses.push(parsed);
          if (parsed && typeof parsed === "object" && parsed.id === message.id) break;
        } catch {
          // Skip invalid JSON lines
        }
      }

      return c.json({ responses });
    } catch (err) {
      const message = errorMessage(err);
      return c.json({ error: true, message }, 500);
    }
  })

  // DELETE /:id — cleanup an MCP server session
  .delete("/:id", async (c) => {
    const { id } = c.req.param();
    cleanupSession(id);
    return c.json({ ok: true });
  });
