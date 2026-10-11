/**
 * Remote AgentSessionHost — implements the Host catalog surface
 * (create / connect / list / destroy) over the `/api/agent` HTTP plane.
 *
 * The host process constructs this when `--remote-session` is configured and
 * injects it into `createAgentFromConfig`; the UI layer stays Session-only.
 */

import { RemoteSessionClient } from "./remote-session-client.js";

import type { AgentSessionHost, AgentSessionSnapshot } from "@codent/core";

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
  }
  return (await response.json()) as T;
}

export interface RemoteAgentSessionHostOptions {
  baseUrl: string;
}

/** connect() reuses a snapshot hydrated within this window instead of refetching. */
const CONNECT_REFRESH_FRESH_MS = 10_000;

/**
 * Create a remote {@link AgentSessionHost} bound to an agent server.
 *
 * @param options.baseUrl - Agent server base URL (e.g. `"http://localhost:3100"`).
 */
export function createRemoteAgentSessionHost(options: RemoteAgentSessionHostOptions): AgentSessionHost {
  // Cache one client per agentId. `connect()` is called repeatedly by UI hooks
  // (e.g. on every snapshot re-read); returning a fresh shell each time resets
  // the snapshot to empty until hydration completes, which makes consumers
  // flicker between empty and full data. Instance identity is the cache key —
  // mirroring the Local host's handle-cache contract.
  const clients = new Map<string, RemoteSessionClient>();
  const client = (agentId: string): RemoteSessionClient => {
    let session = clients.get(agentId);
    if (!session) {
      session = new RemoteSessionClient({ baseUrl: options.baseUrl, agentId });
      clients.set(agentId, session);
    }
    return session;
  };

  return {
    async create(createOptions) {
      const response = await fetch(joinUrl(options.baseUrl, "/api/agent"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createOptions.name,
          model: createOptions.model,
          style: createOptions.modelStyle,
          baseURL: createOptions.modelBaseURL,
          apiKey: createOptions.modelApiKey,
          systemPrompt: createOptions.systemPrompt,
          maxIterations: createOptions.maxIterations,
          maxConcurrentTasks: createOptions.maxConcurrentTasks,
          mcpConfigPath: createOptions.mcpConfigPath,
          extensionDirs: createOptions.extensionDirs,
          continueSession: createOptions.continueSession,
          resumeSessionId: createOptions.resumeSessionId,
          // Websearch keys / provider preference for the server-side agent loop. The
          // server's create schema accepts this field (write-only; never echoed back).
          ...(createOptions.toolConfig ? { toolConfig: createOptions.toolConfig } : {}),
        }),
      });
      if (!response.ok) {
        // Surface the server's real error (e.g. 400 "No model configured")
        // instead of silently reading `data.id` as undefined, which would turn
        // every later call into a misleading 404 "Session not found".
        const text = await response.text().catch(() => "");
        let detail = text || response.statusText;
        try {
          const body = JSON.parse(text) as { message?: string };
          if (body.message) detail = body.message;
        } catch {
          // keep raw text
        }
        throw new Error(`Failed to create remote agent session (HTTP ${response.status}): ${detail}`);
      }
      const data = (await response.json()) as { id: string; snapshot: AgentSessionSnapshot };
      const session = new RemoteSessionClient({
        baseUrl: options.baseUrl,
        agentId: data.id,
        initialSnapshot: data.snapshot,
      });
      // Mirror the Local host's cache contract so a subsequent `connect()`
      // returns the same instance instead of a fresh shell needing a refresh.
      clients.set(data.id, session);
      return { session };
    },

    connect(agentId) {
      // Synchronous contract like the Local host — hydrate lazily; snapshot
      // failures surface on first use (getSnapshot returns a shell until then).
      const session = client(agentId);
      if (session.isTerminated()) {
        // Server reported this id as gone (404): evict so the caller (e.g. the
        // bridge resolver) falls through to create a fresh session instead of
        // reconnecting to a dead id forever.
        clients.delete(agentId);
        return null;
      }
      // `connect()` runs on every session lookup (resolveAgentSession), so an
      // unconditional refresh re-downloads the full transcript each time.
      // Subscribed clients stay live via SSE anyway; only refetch when the
      // cached snapshot is genuinely stale.
      if (session.isSnapshotStale(CONNECT_REFRESH_FRESH_MS)) {
        void session.refresh().catch(() => {});
      }
      return session;
    },

    async list() {
      const response = await fetch(joinUrl(options.baseUrl, "/api/agent"));
      const data = await readJson<{ agents: ReturnType<AgentSessionHost["list"]> }>(response);
      return data.agents;
    },

    async destroy(agentId) {
      await fetch(joinUrl(options.baseUrl, `/api/agent/${agentId}`), { method: "DELETE" });
      clients.delete(agentId);
    },
  };
}
