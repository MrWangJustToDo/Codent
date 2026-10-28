/**
 * Agent Session HTTP plane — same contract as LocalAgentSession (REST + SSE).
 * Distinct from CoreEnv workspace routes under `/api/fs`, `/api/command`, etc.
 *
 * Remount support: the server keeps per-agent command snapshots derived from each
 * agent's `AgentStreamHub` and serves task/compact summary snapshots so a reconnecting
 * client can reconstruct in-flight state.
 *
 * Runtime imports from `@codent/core` are dynamic so server dts bundling does not
 * pull TanStack AI types into the CoreEnv server entry.
 */

import { Hono } from "hono";
import { compress } from "hono/compress";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import { loadServerModelsConfig } from "../load-models-config.js";
import { createMessagesDeltaWriter } from "../messages-delta.js";
import { getServerEnv, getServerManager } from "../server-runtime.js";

import { readServerModelEnv } from "./provider.js";

import type {
  AgentSession,
  AgentSessionChannel,
  AgentSessionCommand,
  AgentSessionCreateOptions,
  McpServerConfig,
  ModelInfo,
  ModelsConfigEntry,
} from "@codent/core";

/**
 * `AgentSession` with only its snapshot payload erased.
 *
 * `AgentSessionSnapshot.messages` is `UIMessage[]` from `@tanstack/ai`, and this file
 * exports the Hono route object — whose type is *inferred* from its handlers. A
 * `getSnapshot(): AgentSessionSnapshot` reachable through those handlers makes the route
 * type unnameable without `@codent/core/node_modules/@tanstack/ai` (TS2742, "cannot be named
 * without a reference to … This is likely not portable"), which would break the emitted
 * declaration of a published entry (`@codent/server` → `dist/index.d.mts`).
 *
 * Only the snapshot is erased. `dispatch` / `subscribe` keep their core types, so a command
 * is still checked against the discriminated union and the `tool` channel payload is still
 * narrowed by its discriminant — the earlier hand-written `SessionLike` erased all of it and
 * needed `as unknown as` at every crossing.
 *
 * `AgentSession` still satisfies this (a snapshot is an `unknown`), so no cast is needed at
 * the `createLocalAgentSession` call site.
 */
interface SessionWithErasedSnapshot extends Omit<AgentSession, "getSnapshot"> {
  getSnapshot(): unknown;
}

const sessions = new Map<string, SessionWithErasedSnapshot>();

/**
 * Drop cache entries whose agent no longer exists in the manager. The map is only pruned by the
 * DELETE route, while an agent can be destroyed by other paths (`destroyAgent`, an owner-session
 * conflict, host teardown) — and a cached handle retains the whole agent graph.
 */
function pruneDeadSessions(): void {
  const manager = getServerManager();
  for (const id of [...sessions.keys()]) {
    if (!manager.getAgent(id)) sessions.delete(id);
  }
}

/**
 * Disconnect recovery: when the last SSE subscriber leaves, a run can keep
 * going (or park in `waiting`/`awaiting_user` with nobody able to answer).
 * After a grace period (covers the client's 500ms-30s reconnect backoff) a
 * still-active session gets `{ type: "stop" }` so the run is finalized, the
 * pump drains and the disk session ownership lock is releasable again.
 */
const SSE_STOP_GRACE_MS = 30_000;
// Statuses that still have a PRODUCER to release. A parked run (`waiting` / `awaiting_user`) has
// none: its only producer is the user, so an idle SSE timeout used to `stop` it and persist the
// pending approval as "Cancelled by user." — a 30s network blip silently answered a question the
// user never saw.
const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["running", "thinking", "responding", "compacting"]);
const sseClients = new Map<string, number>();
const sseStopTimers = new Map<string, ReturnType<typeof setTimeout>>();

function hasActiveRun(session: SessionWithErasedSnapshot): boolean {
  const status = (session.getSnapshot() as { status?: string } | null | undefined)?.status;
  return status != null && ACTIVE_RUN_STATUSES.has(status);
}

function scheduleIdleStop(id: string, session: SessionWithErasedSnapshot): void {
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
  // Loose here on purpose: `AgentConfigSchema` owns the bounds/enums, and a violation is mapped to
  // a 400 below. Duplicating them in this schema would be a second source of truth.
  temperature: z.number().optional(),
  maxTokens: z.number().int().optional(),
  reasoningEffort: z.string().optional(),
  compaction: z.record(z.string(), z.unknown()).optional(),
  skillDirs: z.array(z.string()).optional(),
  lazyToolsConfig: z.record(z.string(), z.unknown()).optional(),
  agentDocFilenames: z.array(z.string()).optional(),
  agentDocLoadOverride: z.boolean().optional(),
  extensionLlm: z
    .object({
      callsPerRun: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .optional(),
  mcpConfigPath: z.string().optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  extensionDirs: z.array(z.string()).optional(),
  builtins: z
    .object({
      lsp: z.boolean().optional(),
      skills: z.boolean().optional(),
      memory: z.boolean().optional(),
      mcp: z.boolean().optional(),
      codeMode: z.boolean().optional(),
    })
    .optional(),
  modelInfo: z.record(z.string(), z.unknown()).optional(),
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

/**
 * Resolve a model against the **server's** own connection.
 *
 * `--remote-session` clients never send upstream credentials — the server picks the connection from
 * its own models.json (the direct entry containing the model) or falls back to its `.env` provider.
 *
 * Shared by session creation and `model.set`, which used to disagree: creation trusted whatever
 * connection the request carried, so `--model X` alone (no `--base-url` / `--api-key`) sent the
 * client's resolved defaults — `https://api.openai.com/v1` with an empty key — and overrode the
 * server's provider. That is a 401 at best and the client's own key in plaintext at worst, and it is
 * the exact inverse of what `model.set` documented.
 */
async function resolveServerModelConnection(model: string, style?: "openai" | "anthropic") {
  const { resolveModelConfig } = await loadCore();
  const config = await loadServerModelsConfig();
  const entry = (config?.models ?? []).find(
    (e): e is Extract<ModelsConfigEntry, { type: "direct" }> => e.type === "direct" && !!e.models?.includes(model)
  );
  return entry
    ? await resolveModelConfig({ model, style: entry.style, baseURL: entry.baseURL, apiKey: entry.apiKey })
    : await resolveModelConfig({ ...readServerModelEnv(), model, ...(style ? { style } : {}) });
}

async function resolveServerModelSetCommand(command: AgentSessionCommand): Promise<AgentSessionCommand> {
  if (command.type !== "model.set" || !command.model?.trim()) return command;
  if (command.modelBaseURL || command.modelApiKey) return command;

  const style = command.modelStyle === "openai" || command.modelStyle === "anthropic" ? command.modelStyle : undefined;
  const { connection, modelInfo } = await resolveServerModelConnection(command.model, style);
  if (!connection.baseURL) return command;
  return {
    ...command,
    modelStyle: connection.style,
    modelBaseURL: connection.baseURL,
    ...(connection.apiKey ? { modelApiKey: connection.apiKey } : {}),
    modelInfo: command.modelInfo ?? modelInfo ?? null,
  };
}

async function getSession(id: string): Promise<SessionWithErasedSnapshot | undefined> {
  const existing = sessions.get(id);
  if (existing) {
    // Evicting is not enough: returning the entry we just deleted would hand this request a
    // handle to an agent the manager no longer owns (and keep it alive for one more call).
    if (getServerManager().getAgent(id)) return existing;
    sessions.delete(id);
  }
  const { createLocalAgentSession } = await loadCore();
  const manager = getServerManager();
  const managed = manager.getAgent(id);
  if (!managed) return undefined;
  const session = createLocalAgentSession({ managed, manager });
  sessions.set(id, session);
  return session;
}

/** Command snapshots for a root and its live child agents. */
function listCommandSnapshots(rootId: string) {
  const manager = getServerManager();
  const root = manager.getAgent(rootId);
  if (!root) return [];
  // Task children use `autoDestroy: false`, and a session switch aborts but does not destroy them.
  // Scope the walk to the active disk session: otherwise a remount of the new conversation seeds
  // its command buffers from the old child's stream hub.
  return [root, ...manager.getAllSubagents(rootId, root.getSessionData()?.id)].flatMap((agent) =>
    (agent.getStreamHub().listSnapshots() ?? []).filter((snapshot) => snapshot.source === "command")
  );
}

export const agentSessionRoutes = new Hono()
  // Catalog list — mirrors Local `AgentSessionHost.list()`.
  .get("/", async (c) => {
    const manager = getServerManager();
    const entries = manager.getAgents().map((managed) => ({
      agentId: managed.id,
      name: managed.name,
      ...(managed.parentId ? { parentId: managed.parentId } : {}),
      status: managed.getStatus(),
      ...(managed.getSessionData?.()?.id ? { activeSessionId: managed.getSessionData()!.id } : {}),
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
    const {
      buildDefaultSystemPrompt,
      createLocalAgentSessionHost,
      MAX_AGENT_ITERATIONS,
      resolveModelConfig,
      resolveModelConnection,
    } = await loadCore();
    // The bound is core's single `MAX_AGENT_ITERATIONS`. This check exists for the MESSAGE (it
    // names the bound); every other schema violation — here, in `AgentConfigSchema`, or in the
    // compaction schema — is a 400 through the app's one `ZodError` boundary.
    if (body.maxIterations !== undefined && body.maxIterations > MAX_AGENT_ITERATIONS) {
      return c.json({ error: true, message: `maxIterations must be between 1 and ${MAX_AGENT_ITERATIONS}.` }, 400);
    }
    // Where the connection comes from, in order of authority:
    //   1. a USABLE connection in the request — an apiKey, or a baseURL the user actually chose.
    //      A `--remote-session --model X` client with local keys is a direct-provider client by
    //      design, so it keeps them;
    //   2. the SERVER's provider for a named model that arrived without one — the case above when
    //      the client has NO key: `resolveModelConnection` always fills the provider DEFAULT
    //      (`https://api.openai.com/v1` for openai style), so "no apiKey + a default URL" is not a
    //      connection the user made, it is the client's env default. Trusting it produced a 401 on
    //      the first request and overrode the server's own provider;
    //   3. the server's `.env` provider when the client named no model at all.
    const explicitModel = body.model?.trim();
    const clientStyle = body.style as "openai" | "anthropic" | undefined;
    const clientBaseURL = body.baseURL?.trim();
    // The default for the client's style, read from core's one env→connection mapping rather than a
    // copied URL table, so a new provider default cannot silently become "user-supplied".
    const defaultBaseURL = clientBaseURL
      ? resolveModelConnection({ style: clientStyle ?? "openai", model: explicitModel ?? "" }).baseURL
      : undefined;
    const clientBaseURLKey = clientBaseURL?.replace(/\/+$/, "");
    const clientSuppliedConnection =
      Boolean(body.apiKey?.trim()) || (clientBaseURLKey !== undefined && clientBaseURLKey !== defaultBaseURL);
    const { connection, modelInfo } = !explicitModel
      ? await resolveModelConfig(readServerModelEnv())
      : clientSuppliedConnection
        ? await resolveModelConfig({
            model: body.model,
            style: clientStyle,
            baseURL: body.baseURL,
            apiKey: body.apiKey,
          })
        : await resolveServerModelConnection(explicitModel, clientStyle);
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
    const manager = getServerManager();
    const host = createLocalAgentSessionHost({ manager });
    // Annotated deliberately: `host.create()` returns the real `AgentSession`, and leaving that
    // inferred would make this route object's type unnameable without `@tanstack/ai`
    // (see SessionWithErasedSnapshot).
    const { session }: { session: SessionWithErasedSnapshot } = await host.create({
      name: body.name || "remote",
      model: connection.model,
      // Every session setting comes from the REQUEST body or the built-in default. The server's
      // own `.agents/config/models.json` supplies provider entries (via `loadServerModelsConfig`,
      // for the `/models` plane) — not session config: a server serves many clients, so its file
      // must not decide their prompts or budgets.
      systemPrompt: body.systemPrompt || (await buildDefaultSystemPrompt(undefined, getServerEnv())),
      // No `providerMode` in the body: the server owns the connection, so `applyPersistedModel`
      // takes the non-remote branch and adopts a resumed session's persisted model — which the
      // server itself wrote through `model.set`, so that is the intended choice.
      maxIterations: body.maxIterations,
      ...(body.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: body.maxConcurrentTasks } : {}),
      mcpConfigPath: body.mcpConfigPath,
      ...(body.mcpServers ? { mcpServers: body.mcpServers as Record<string, McpServerConfig> } : {}),
      extensionDirs: body.extensionDirs,
      ...(body.builtins ? { builtins: body.builtins } : {}),
      modelStyle: connection.style,
      modelBaseURL: connection.baseURL,
      modelApiKey: connection.apiKey,
      modelInfo: (body.modelInfo as ModelInfo | undefined) ?? modelInfo,
      continueSession: body.continueSession,
      resumeSessionId: body.resumeSessionId,
      ...(body.toolConfig ? { toolConfig: body.toolConfig } : {}),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.maxTokens !== undefined ? { maxTokens: body.maxTokens } : {}),
      ...(body.reasoningEffort
        ? { reasoningEffort: body.reasoningEffort as AgentSessionCreateOptions["reasoningEffort"] }
        : {}),
      ...(body.compaction
        ? { compaction: body.compaction as NonNullable<AgentSessionCreateOptions["compaction"]> }
        : {}),
      ...(body.skillDirs ? { skillDirs: body.skillDirs } : {}),
      ...(body.lazyToolsConfig
        ? { lazyToolsConfig: body.lazyToolsConfig as NonNullable<AgentSessionCreateOptions["lazyToolsConfig"]> }
        : {}),
      ...(body.agentDocFilenames ? { agentDocFilenames: body.agentDocFilenames } : {}),
      ...(body.agentDocLoadOverride !== undefined ? { agentDocLoadOverride: body.agentDocLoadOverride } : {}),
      ...(body.extensionLlm ? { extensionLlm: body.extensionLlm } : {}),
    });
    sessions.set(session.id, session);
    // Redact secrets: `body` now carries toolConfig (websearch API keys) alongside the model
    // apiKey, so never stringify the whole payload — only its non-secret shape.
    const { apiKey: _apiKey, toolConfig: _toolConfig, ...safeBody } = body;
    diag(
      `POST /api/agent body=${JSON.stringify({ ...safeBody, toolConfig: body.toolConfig ? "[redacted]" : undefined })} ` +
        `-> id=${session.id} sessions.size=${sessions.size} ` +
        `inManager=${manager.getAgent(session.id)?.id ?? "NONE"}`
    );
    return c.json({ id: session.id, snapshot: session.getSnapshot() });
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
    return c.json({
      snapshots: (session.listAgentStreamSnapshots?.() ?? []).filter((snapshot) => snapshot.source !== "command"),
    });
  })
  .get("/:id/tool-buffers", compress(), async (c) => {
    const id = c.req.param("id");
    const session = await getSession(id);
    if (!session) return c.json({ error: true, message: "Session not found" }, 404);
    // Command output is a projection of the same stream hub the SSE channel uses —
    // there is no second server-side tool buffer to keep in sync.
    const buffers: Record<string, { stdout: string; stderr: string }> = {};
    for (const snapshot of listCommandSnapshots(id)) {
      if (!snapshot.toolCallId) continue;
      const channel = snapshot.channel === "stderr" ? "stderr" : "stdout";
      const text = snapshot.lines.map((line) => `${line}\n`).join("") + snapshot.pendingLine;
      const entry = buffers[snapshot.toolCallId] ?? { stdout: "", stderr: "" };
      entry[channel] = text;
      buffers[snapshot.toolCallId] = entry;
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
    // `?channels=` is untrusted URL text; narrow it to the protocol's channel names (core's
    // list, not a copy). An unknown name is rejected rather than dropped: dropping it would
    // narrow to an empty list, and core reads an empty list as "use the defaults" — i.e. the
    // client would silently receive *every* channel it did not ask for. Previously an unknown
    // name was passed through and matched nothing, so the client silently got no events at all.
    let channels: AgentSessionChannel[] | undefined;
    if (channelsParam) {
      const { AGENT_SESSION_CHANNELS } = await loadCore();
      const known = new Set<string>(AGENT_SESSION_CHANNELS);
      const requested = channelsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // `?channels=,` parses to an empty list. Core reads `[]` as "use every default channel",
      // which is the opposite of a caller that named no channel, so reject it explicitly.
      if (requested.length === 0) {
        return c.json({ error: true, message: "channels must name at least one channel" }, 400);
      }
      const unknown = requested.filter((s) => !known.has(s));
      if (unknown.length > 0) {
        return c.json({ error: true, message: `Unknown channel(s): ${unknown.join(", ")}` }, 400);
      }
      channels = requested.filter((s): s is AgentSessionChannel => known.has(s));
    }

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
            delta.push(event.payload);
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
    const manager = getServerManager();
    if (manager.getAgent(id)) {
      manager.destroyAgent(id);
      // `destroyAgent` is synchronous: teardown (and releasing the disk-session claim) runs
      // asynchronously. Answering before it settles made an immediate re-create/resume of the
      // same agent id fail with "already active in another live session".
      await manager.settleTeardowns?.();
    }
    pruneDeadSessions();
    return c.json({ ok: true });
  });
