/**
 * Agent Session HTTP plane — same contract as LocalAgentSession (REST + SSE).
 * Distinct from CoreEnv workspace routes under `/api/fs`, `/api/command`, etc.
 *
 * Remount support: the server keeps per-agent tool output buffers (fed by the
 * session's own `tool` channel subscription) and serves summary-stream
 * snapshots so a reconnecting client can reconstruct in-flight state.
 *
 * Runtime imports from `@codent/core` are dynamic so server dts bundling does not
 * pull TanStack AI types into the CoreEnv server entry.
 */

import { Hono } from "hono";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import { createMessagesDeltaWriter } from "../messages-delta.js";

import { readServerModelEnv } from "./provider.js";

import type { ModelsConfig, ModelsConfigEntry } from "@codent/core";

interface SummarySnapshotLike {
  key: string;
  [field: string]: unknown;
}

interface SessionLike {
  id: string;
  getSnapshot(): unknown;
  dispatch(command: unknown): Promise<unknown>;
  subscribe(
    handler: (event: { channel: string; payload?: unknown }) => void | Promise<void>,
    options?: { channels?: string[] }
  ): () => void;
  getSummaryStreamSnapshot?(key: string): SummarySnapshotLike | null;
  listSummaryStreamSnapshots?(): SummarySnapshotLike[];
}

const sessions = new Map<string, SessionLike>();

/**
 * Disconnect recovery: when the last SSE subscriber leaves, a run can keep
 * going (or park in `waiting`/`awaiting_user` with nobody able to answer).
 * After a grace period (covers the client's 500ms-30s reconnect backoff) a
 * still-active session gets `{ type: "stop" }` so the run is finalized, the
 * pump drains and the disk session ownership lock is releasable again.
 */
const SSE_STOP_GRACE_MS = 30_000;
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "thinking",
  "responding",
  "waiting",
  "awaiting_user",
  "compacting",
]);
const sseClients = new Map<string, number>();
const sseStopTimers = new Map<string, ReturnType<typeof setTimeout>>();

function snapshotStatus(snapshot: unknown): string | undefined {
  return (snapshot as { status?: string } | null | undefined)?.status;
}

function hasActiveRun(session: SessionLike): boolean {
  const status = snapshotStatus(session.getSnapshot());
  return status != null && ACTIVE_RUN_STATUSES.has(status);
}

function scheduleIdleStop(id: string, session: SessionLike): void {
  if (sseStopTimers.has(id)) return;
  const timer = setTimeout(() => {
    sseStopTimers.delete(id);
    if ((sseClients.get(id) ?? 0) > 0) return;
    if (!hasActiveRun(session)) return;
    diag(`no SSE subscribers for ${id} with active run — dispatching stop`);
    void session.dispatch({ type: "stop" }).catch(() => {});
  }, SSE_STOP_GRACE_MS);
  sseStopTimers.set(id, timer);
}

function clearIdleStop(id: string): void {
  const timer = sseStopTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    sseStopTimers.delete(id);
  }
}

/** Verbose per-request diagnostics — enable with AGENT_SESSION_DEBUG=1. */
const AGENT_SESSION_DEBUG = process.env.AGENT_SESSION_DEBUG === "1";

function diag(message: string): void {
  if (AGENT_SESSION_DEBUG) console.log(`[agent-diag] ${message}`);
}

/** Per-agent tool output buffers for client remount (cap per stream). */
const TOOL_BUFFER_CAP_BYTES = 256 * 1024;
interface ToolBufferEntry {
  stdout: string[];
  stderr: string[];
  stdoutBytes: number;
  stderrBytes: number;
}
const toolBuffers = new Map<string, Map<string, ToolBufferEntry>>();
const toolUnsubs = new Map<string, () => void>();

/**
 * Append a chunk under the byte cap by dropping oldest chunks. Storage is a
 * chunk array with lazy join — per-chunk cost stays independent of the
 * accumulated size (a plain `current + chunk` would re-copy the whole string).
 */
function appendCapped(chunks: string[], bytes: number, chunk: string): { chunks: string[]; bytes: number } {
  chunks.push(chunk);
  let total = bytes + chunk.length;
  while (total > TOOL_BUFFER_CAP_BYTES && chunks.length > 1) {
    const oldest = chunks[0];
    if (oldest === undefined) break;
    total -= oldest.length;
    chunks.shift();
  }
  return { chunks, bytes: total };
}

function attachToolBuffer(id: string, session: SessionLike): void {
  if (toolUnsubs.has(id)) return;
  const buffers = new Map<string, ToolBufferEntry>();
  toolBuffers.set(id, buffers);
  toolUnsubs.set(
    id,
    session.subscribe((event) => {
      if (event.channel !== "tool") return;
      const payload = event.payload as
        | { kind: "chunk"; chunk: { toolCallId: string; type: "stdout" | "stderr"; chunk: string } }
        | { kind: "clear"; toolCallId: string }
        | undefined;
      if (!payload) return;
      if (payload.kind === "clear") {
        buffers.delete(payload.toolCallId);
        return;
      }
      const entry = buffers.get(payload.chunk.toolCallId) ?? {
        stdout: [],
        stderr: [],
        stdoutBytes: 0,
        stderrBytes: 0,
      };
      if (payload.chunk.type === "stdout") {
        const next = appendCapped(entry.stdout, entry.stdoutBytes, payload.chunk.chunk);
        entry.stdout = next.chunks;
        entry.stdoutBytes = next.bytes;
      } else {
        const next = appendCapped(entry.stderr, entry.stderrBytes, payload.chunk.chunk);
        entry.stderr = next.chunks;
        entry.stderrBytes = next.bytes;
      }
      buffers.set(payload.chunk.toolCallId, entry);
    })
  );
}

function dropToolBuffer(id: string): void {
  toolUnsubs.get(id)?.();
  toolUnsubs.delete(id);
  toolBuffers.delete(id);
}

const createBodySchema = z.object({
  name: z.string().optional(),
  // Optional: when omitted (or empty), the server falls back to its own `.env`
  // provider so a `--remote-session` client needs no local keys or model.
  model: z.string().optional(),
  style: z.string().optional(),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  systemPrompt: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  maxConcurrentTasks: z.number().optional(),
  mcpConfigPath: z.string().optional(),
  extensionDirs: z.array(z.string()).optional(),
  continueSession: z.boolean().optional(),
  resumeSessionId: z.string().optional(),
  // Websearch secrets / provider preference for the server-side agent loop. Like the
  // model `apiKey` above, this is write-only: it is never echoed in the snapshot.
  toolConfig: z
    .object({
      websearch: z
        .object({
          braveApiKey: z.string().optional(),
          exaApiKey: z.string().optional(),
          parallelApiKey: z.string().optional(),
          tavilyApiKey: z.string().optional(),
          provider: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

async function loadCore() {
  return import("@codent/core");
}

/** Load the server's own models.json (`.agents/config/models.json`), if any. */
async function loadServerModelsConfig(): Promise<ModelsConfig | null> {
  const { loadModelsConfigFromFile } = await loadCore();
  try {
    return await loadModelsConfigFromFile();
  } catch {
    return null;
  }
}

/**
 * Resolve the server-side connection for a remote `model.set` command.
 *
 * A `--remote-session` client dispatches `model.set` WITHOUT `modelBaseURL`/
 * `modelApiKey` — upstream credentials never leave the server. The server picks
 * the connection from its own models.json (the direct entry containing the
 * model) or falls back to its `.env` provider; `modelInfo` comes from the same
 * resolveModelConfig pipeline used at session creation. Commands that DO carry
 * explicit connection fields pass through unchanged.
 */
async function resolveServerModelSetCommand(command: unknown): Promise<unknown> {
  const cmd = command as { type?: string; model?: string; modelStyle?: string } | null;
  if (cmd?.type !== "model.set" || !cmd.model?.trim()) return command;
  const raw = command as Record<string, unknown>;
  if (raw.modelBaseURL || raw.modelApiKey) return command;

  const { resolveModelConfig } = await loadCore();
  const config = await loadServerModelsConfig();
  const model = cmd.model;
  const entry = (config?.models ?? []).find(
    (e): e is Extract<ModelsConfigEntry, { type: "direct" }> => e.type === "direct" && !!e.models?.includes(model)
  );
  const { connection, modelInfo } = entry
    ? await resolveModelConfig({
        model,
        style: entry.style,
        baseURL: entry.baseURL,
        apiKey: entry.apiKey,
      })
    : await resolveModelConfig({
        ...readServerModelEnv(),
        model,
        ...(cmd.modelStyle ? { style: cmd.modelStyle as "openai" | "anthropic" } : {}),
      });
  if (!connection.baseURL) return command;
  return {
    ...raw,
    modelStyle: connection.style,
    modelBaseURL: connection.baseURL,
    ...(connection.apiKey ? { modelApiKey: connection.apiKey } : {}),
    modelInfo: raw.modelInfo ?? modelInfo ?? null,
  };
}

async function getSession(id: string): Promise<SessionLike | undefined> {
  const existing = sessions.get(id);
  if (existing) return existing;
  const { agentManager, createLocalAgentSession } = await loadCore();
  const managed = agentManager.getAgent(id);
  if (!managed) return undefined;
  const session = createLocalAgentSession({ managed, manager: agentManager }) as unknown as SessionLike;
  sessions.set(id, session);
  attachToolBuffer(id, session);
  return session;
}

export const agentSessionRoutes = new Hono()
  // Catalog list — mirrors Local `AgentSessionHost.list()`.
  .get("/", async (c) => {
    const { agentManager } = await loadCore();
    const entries = agentManager.getAgents().map((managed) => ({
      agentId: managed.id,
      name: managed.name,
      ...(managed.parentId ? { parentId: managed.parentId } : {}),
      status: managed.getStatus(),
      ...(managed.getSessionData?.()?.id ? { sessionId: managed.getSessionData()!.id } : {}),
      createdAt: managed.createdAt,
      updatedAt: managed.updatedAt,
    }));
    return c.json({ agents: entries });
  })
  // Selectable model list for `--remote-session` clients (`/models` command).
  // Mirrors the sanitized `/api/provider/info` contract: styles + model ids
  // only — upstream baseURL/apiKey never leave the server, because `model.set`
  // resolution happens server-side (resolveServerModelSetCommand).
  .get("/models", async (c) => {
    const config = await loadServerModelsConfig();
    const envConnection = readServerModelEnv();
    const entries = (config?.models ?? [])
      .filter((e): e is Extract<ModelsConfigEntry, { type: "direct" }> => e.type === "direct")
      .map((e) => ({ style: e.style, models: e.models ?? [] }));
    // The server's own default — its `.env` model, the connection `POST /api/agent`
    // resolves when a client names none — must always be offered. It used to be offered
    // only when models.json was absent, so a models.json listing other ids advertised a
    // list in which a session could not select the model it would actually run.
    const envModel = envConnection.model?.trim();
    if (envModel && !entries.some((e) => e.models.includes(envModel))) {
      // Appended rather than prepended: `active.entryIndex` is recorded against the
      // ids models.json declares, and inserting ahead of them would shift every one.
      entries.push({ style: envConnection.style, models: [envModel] });
    }
    const active =
      config?.active ??
      // No recorded selection: the server's own model is what a session started now
      // would use, so that is what the client should show as current.
      (envModel
        ? { entryIndex: entries.findIndex((e) => e.models.includes(envModel)), model: envModel }
        : { entryIndex: 0 });
    return c.json({ entries, active });
  })
  .post("/", async (c) => {
    const body = createBodySchema.parse(await c.req.json());
    const { agentManager, buildDefaultSystemPrompt, createLocalAgentSessionHost, resolveModelConfig } =
      await loadCore();
    // Explicit client model wins; otherwise use the server's own `.env` provider
    // so a `--remote-session` client can leave model configuration on the server.
    const explicitModel = body.model?.trim();
    const { connection, modelInfo } = explicitModel
      ? await resolveModelConfig({
          model: body.model,
          style: body.style as "openai" | "anthropic" | undefined,
          baseURL: body.baseURL,
          apiKey: body.apiKey,
        })
      : await resolveModelConfig(readServerModelEnv());
    if (!connection.model?.trim()) {
      return c.json(
        {
          error: true,
          message:
            "No model configured: pass `model` in the request body, or set MODEL / API_KEY / BASE_URL in the server .env (see --remote-session).",
        },
        400
      );
    }
    const host = createLocalAgentSessionHost({ manager: agentManager });
    const { session } = await host.create({
      name: body.name || "remote",
      model: connection.model,
      systemPrompt: body.systemPrompt || (await buildDefaultSystemPrompt()),
      maxIterations: body.maxIterations,
      ...(body.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: body.maxConcurrentTasks } : {}),
      mcpConfigPath: body.mcpConfigPath,
      extensionDirs: body.extensionDirs,
      modelStyle: connection.style,
      modelBaseURL: connection.baseURL,
      modelApiKey: connection.apiKey,
      modelInfo,
      continueSession: body.continueSession,
      resumeSessionId: body.resumeSessionId,
      ...(body.toolConfig ? { toolConfig: body.toolConfig } : {}),
    });
    sessions.set(session.id, session as unknown as SessionLike);
    attachToolBuffer(session.id, session as unknown as SessionLike);
    // Redact secrets: `body` now carries toolConfig (websearch API keys) alongside the model
    // apiKey, so never stringify the whole payload — only its non-secret shape.
    const { apiKey: _apiKey, toolConfig: _toolConfig, ...safeBody } = body;
    diag(
      `POST /api/agent body=${JSON.stringify({ ...safeBody, toolConfig: body.toolConfig ? "[redacted]" : undefined })} ` +
        `-> id=${session.id} sessions.size=${sessions.size} ` +
        `inManager=${agentManager.getAgent(session.id)?.id ?? "NONE"}`
    );
    return c.json({ id: session.id, snapshot: (session as SessionLike).getSnapshot() });
  })
  .get("/:id/snapshot", compress(), async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    diag(`GET /:id/snapshot id=${id} inSessions=${sessions.has(id)} inManager=${session ? "yes" : "no"}`);
    if (!session) return c.json({ error: true, message: "Session not found" }, 404);
    return c.json(session.getSnapshot());
  })
  .get("/:id/summary-streams", compress(), async (c) => {
    const session = await getSession(c.req.param("id"));
    if (!session) return c.json({ error: true, message: "Session not found" }, 404);
    return c.json({ snapshots: session.listSummaryStreamSnapshots?.() ?? [] });
  })
  .get("/:id/tool-buffers", compress(), async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: true, message: "Session not found" }, 404);
    const buffers: Record<string, { stdout: string; stderr: string }> = {};
    for (const [toolCallId, entry] of toolBuffers.get(id) ?? []) {
      buffers[toolCallId] = { stdout: entry.stdout.join(""), stderr: entry.stderr.join("") };
    }
    return c.json({ buffers });
  })
  .post("/:id/command", async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    diag(`POST /:id/command id=${id} inSessions=${sessions.has(id)} inManager=${session ? "yes" : "no"}`);
    if (!session) return c.json({ error: true, message: "Session not found" }, 404);
    const command = await c.req.json();
    const result = await session.dispatch(await resolveServerModelSetCommand(command));
    return c.json(result);
  })
  .get("/:id/events", async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: true, message: "Session not found" }, 404);

    const channelsParam = c.req.query("channels");
    const channels = channelsParam
      ? channelsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    return streamSSE(c, async (stream) => {
      let closed = false;
      let released = false;
      // Subscriber bookkeeping: a reconnect cancels a pending idle-stop; the
      // last departure arms one (see SSE_STOP_GRACE_MS above).
      sseClients.set(id, (sseClients.get(id) ?? 0) + 1);
      clearIdleStop(id);
      const release = (): void => {
        if (released) return;
        released = true;
        const count = (sseClients.get(id) ?? 1) - 1;
        if (count <= 0) {
          sseClients.delete(id);
          if (hasActiveRun(session)) scheduleIdleStop(id, session);
        } else {
          sseClients.set(id, count);
        }
      };
      const writeFrame = async (channel: string, payload: unknown): Promise<void> => {
        if (closed) return;
        await stream.writeSSE({
          event: channel,
          data: JSON.stringify({ channel, payload, ts: Date.now() }),
        });
      };
      // `messages` payloads are delta-encoded by default: full arrays only as
      // baselines and safety nets, sparse patches in between (messages-delta.ts).
      // The writer runs in-process, so it diffs by message-object identity —
      // only changed messages are serialized per event.
      const delta = createMessagesDeltaWriter((payload) => {
        void writeFrame("messages", payload).catch(() => {});
      });
      const unsub = session.subscribe(
        async (event) => {
          if (closed) return;
          if (event.channel === "messages") {
            delta.push(event.payload as unknown[]);
            return;
          }
          await writeFrame(event.channel, event.payload);
        },
        channels ? { channels } : undefined
      );

      stream.onAbort(() => {
        closed = true;
        delta.close();
        unsub();
        release();
      });

      // Heartbeat: comment frames keep proxies from idling out the stream and
      // give the client a liveness signal (data-less blocks are ignored there).
      const heartbeat = setInterval(() => {
        if (!closed) void stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
      }, 15_000);

      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      clearInterval(heartbeat);
      unsub();
      release();
    });
  })
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    sessions.delete(id);
    clearIdleStop(id);
    dropToolBuffer(id);
    const { agentManager } = await loadCore();
    if (agentManager.getAgent(id)) {
      agentManager.destroyAgent(id);
    }
    return c.json({ ok: true });
  });
