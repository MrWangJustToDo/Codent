/**
 * HTTP client implementing {@link AgentSession} (REST + SSE).
 * Keeps a local snapshot cache so `getSnapshot()` stays synchronous like Local.
 *
 * Remount + resilience:
 * - tool chunks / summary events are cached client-side; on (re)subscribe the
 *   cache is seeded from `/tool-buffers` + `/summary-streams`.
 * - the SSE connection auto-reconnects with exponential backoff and re-syncs
 *   (full snapshot + seeds) after each reconnect.
 * - server heartbeat comments (`ping`) double as liveness signals; a silent
 *   stream for `HEARTBEAT_TIMEOUT_MS` triggers a reconnect.
 */

import { hydrateToolPresentations } from "@codent/core";

import type {
  AgentSession,
  AgentSessionCommand,
  AgentSessionCommandResult,
  AgentSessionEvent,
  AgentSessionSnapshot,
  AgentSessionSubscribeOptions,
  AgentSessionSubscriber,
  SummaryStreamSnapshot,
} from "@codent/core";

export interface RemoteSessionClientOptions {
  baseUrl: string;
  agentId: string;
  /** Initial snapshot; when omitted the client starts from a shell and hydrates via {@link refresh}. */
  initialSnapshot?: AgentSessionSnapshot;
  fetchImpl?: typeof fetch;
}

function emptySnapshot(agentId: string): AgentSessionSnapshot {
  const emptyTokens = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  return {
    agentId,
    name: "",
    status: "idle",
    error: "",
    pendingApprovalCount: 0,
    mode: "normal",
    lastStreamDurationMs: 0,
    messages: [],
    queues: { steer: [], followUp: [] },
    // UsageChangeSnapshot shape — the shell must stay valid before first resync.
    usage: {
      total: { ...emptyTokens },
      window: { ...emptyTokens },
      percent: 0,
      contextFillTokens: 0,
      billedInputTokens: 0,
      tokenLimit: 0,
      cost: 0,
    },
    todos: [],
    todosTitle: null,
    plan: { phase: "off" },
    autoMode: false,
    mcp: { servers: [] },
    extensions: { extensions: [] },
    toolDescriptors: [],
    interactions: { approvals: [], askUser: [] },
    iteration: { current: 0, max: 0 },
    jobs: { jobs: [] },
    subagents: [],
  } as unknown as AgentSessionSnapshot;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
/** No SSE traffic (incl. heartbeats) for this long → treat the stream as dead. */
const HEARTBEAT_TIMEOUT_MS = 45_000;
/** A snapshot younger than this is reused instead of re-downloaded (full transcript). */
const RESYNC_FRESH_MS = 2_000;

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

type ToolBufferMap = Map<string, { stdout: string; stderr: string }>;

function applySummaryEvent(cache: Map<string, SummaryStreamSnapshot>, payload: unknown): void {
  const event = payload as
    | { type: "reset"; key: string; source: SummaryStreamSnapshot["source"]; seq: number }
    | { type: "append"; key: string; chunk: string; seq: number }
    | { type: "end"; key: string; seq: number };
  if (!event?.key) return;
  const current: SummaryStreamSnapshot = cache.get(event.key) ?? {
    key: event.key,
    source: "source" in event ? event.source : "task",
    seq: 0,
    lines: [],
    pendingLine: "",
    status: "active",
  };
  if (event.type === "append") {
    const text = current.pendingLine + event.chunk;
    const parts = text.split("\n");
    current.pendingLine = parts.pop() ?? "";
    current.lines = [...current.lines, ...(parts.length ? parts : [])];
  } else if (event.type === "end") {
    if (current.pendingLine) {
      current.lines = [...current.lines, current.pendingLine];
      current.pendingLine = "";
    }
    current.status = "ended";
  } else if (event.type === "reset") {
    current.lines = [];
    current.pendingLine = "";
    current.status = "active";
  }
  current.seq = event.seq;
  cache.set(event.key, current);
}

/**
 * JSON transport turns the Date-typed UIMessage `createdAt` into an ISO
 * string; TanStack's wire conversion calls `createdAt.toISOString()` and
 * would crash on the string form. Revive before caching.
 */
function reviveMessageTimestamps(messages: AgentSessionSnapshot["messages"]): void {
  for (const message of messages) {
    const raw = (message as { createdAt?: unknown }).createdAt;
    if (typeof raw === "string") {
      const revived = new Date(raw);
      if (!Number.isNaN(revived.getTime())) {
        (message as { createdAt?: Date }).createdAt = revived;
      }
    }
  }
}

/** Wire form of a `messages` payload (server encoding: messages-delta.ts). */
type MessagesEnvelope =
  | { kind: "full"; messages: AgentSessionSnapshot["messages"] }
  | {
      kind: "patch";
      upserted: Array<{ index: number; message: AgentSessionSnapshot["messages"][number] }>;
      removed: string[];
    };

/**
 * Merge a `messages` wire payload into the cached array.
 *
 * - `{kind:"full"}` — baseline (re)build; revives timestamps.
 * - `{kind:"patch"}` — remove `removed` ids, then splice `upserted` at their
 *   indices (ascending; replace-in-place when the id already occupies a slot).
 * - plain array — legacy form from pre-envelope servers.
 *
 * Unknown kinds report `unknownKind` so the caller can resync. Exported under
 * the ForTests alias for validation scripts (same convention as
 * parseAgentSessionSseBlockForTests).
 */
export function applyMessagesPayloadForTests(
  current: AgentSessionSnapshot["messages"],
  payload: unknown
): { messages: AgentSessionSnapshot["messages"]; unknownKind: boolean } {
  if (Array.isArray(payload)) {
    reviveMessageTimestamps(payload);
    return { messages: payload, unknownKind: false };
  }
  if (!payload || typeof payload !== "object") {
    return { messages: current, unknownKind: true };
  }
  const kind = (payload as { kind?: unknown }).kind;
  if (kind === "full") {
    const messages = (payload as Extract<MessagesEnvelope, { kind: "full" }>).messages;
    reviveMessageTimestamps(messages);
    return { messages, unknownKind: false };
  }
  if (kind === "patch") {
    let messages = current;
    const { upserted = [], removed = [] } = payload as Partial<Extract<MessagesEnvelope, { kind: "patch" }>>;
    if (removed.length > 0) {
      const gone = new Set(removed);
      messages = messages.filter((message) => !gone.has(message.id));
    }
    const ordered = [...upserted].sort((a, b) => a.index - b.index);
    for (const { index, message } of ordered) {
      reviveMessageTimestamps([message]);
      const next = [...messages];
      const existing = next.findIndex((candidate) => candidate.id === message.id);
      if (existing >= 0) next[existing] = message;
      else next.splice(Math.min(Math.max(index, 0), next.length), 0, message);
      messages = next;
    }
    return { messages, unknownKind: false };
  }
  return { messages: current, unknownKind: true };
}

function applyToolEvent(buffers: ToolBufferMap, payload: unknown): void {
  const event = payload as
    | { kind: "chunk"; chunk: { toolCallId: string; type: "stdout" | "stderr"; chunk: string } }
    | { kind: "clear"; toolCallId: string };
  if (!event?.kind) return;
  if (event.kind === "clear") {
    buffers.delete(event.toolCallId);
    return;
  }
  const entry = buffers.get(event.chunk.toolCallId) ?? { stdout: "", stderr: "" };
  entry[event.chunk.type] += event.chunk.chunk;
  buffers.set(event.chunk.toolCallId, entry);
}

function applyEvent(
  snapshot: AgentSessionSnapshot,
  event: AgentSessionEvent,
  summaryCache: Map<string, SummaryStreamSnapshot>,
  toolBuffers: ToolBufferMap
): AgentSessionSnapshot {
  switch (event.channel) {
    case "state":
      return {
        ...snapshot,
        status: event.payload.status,
        ...(event.payload.name !== undefined ? { name: event.payload.name } : {}),
        error: event.payload.error,
        pendingApprovalCount: event.payload.pendingApprovalCount,
        retry: event.payload.retry ?? undefined,
        // Model / effort travel on the retained state channel so a live switch
        // refreshes the cached snapshot (e.g. `/models` reads `modelInfo` to offer depths).
        model: event.payload.model,
        modelInfo: event.payload.modelInfo ?? undefined,
        reasoningEffort: event.payload.reasoningEffort ?? undefined,
        // The run duration is set at the END of a run, when no other channel fires, so it has to
        // ride this event. Without it the footer's "Completed in 1.2s" only appeared after an
        // unrelated full resync — `dispatch()` deliberately does not refetch the snapshot.
        lastStreamDurationMs: event.payload.lastStreamDurationMs,
        // On-disk session identity (agent identity is the connection, not this).
        ...(event.payload.sessionId ? { sessionId: event.payload.sessionId } : {}),
      };
    case "lifecycle": {
      // Keep task phases fresh between snapshot refetches — subagent summaries
      // otherwise only update on commands.
      if (event.payload.type === "subagent:phase") {
        const phase = event.payload.payload.phase;
        const subagentId = event.payload.payload.subagentId;
        const parentTaskToolCallId = event.payload.payload.parentTaskToolCallId;
        if (!phase) return snapshot;
        return {
          ...snapshot,
          subagents: snapshot.subagents.map((entry) =>
            entry.id === subagentId || (parentTaskToolCallId && entry.parentTaskToolCallId === parentTaskToolCallId)
              ? { ...entry, taskPhase: phase }
              : entry
          ),
        };
      }
      return snapshot;
    }
    case "queues":
      return { ...snapshot, queues: event.payload };
    case "usage":
      return { ...snapshot, usage: event.payload };
    case "todos":
      return { ...snapshot, todos: event.payload.items, todosTitle: event.payload.title };
    case "plan":
      return { ...snapshot, plan: event.payload };
    case "summary":
      applySummaryEvent(summaryCache, event.payload);
      return snapshot;
    case "tool":
      applyToolEvent(toolBuffers, event.payload);
      return snapshot;
    case "extensions":
      return { ...snapshot, extensions: event.payload };
    case "tool-presentation":
      // The owning process decided how its tools fold and label; adopt it before rendering.
      hydrateToolPresentations(event.payload.descriptors);
      return { ...snapshot, toolDescriptors: event.payload.descriptors };
    case "mcp":
      return { ...snapshot, mcp: event.payload };
    case "mode":
      return { ...snapshot, mode: event.payload.mode, autoMode: event.payload.autoMode };
    case "interaction":
      return { ...snapshot, interactions: event.payload };
    case "iteration":
      return { ...snapshot, iteration: event.payload };
    case "jobs":
      return { ...snapshot, jobs: event.payload };
    case "subagents":
      return { ...snapshot, subagents: event.payload.subagents };
    default:
      return snapshot;
  }
}

/**
 * Bind to an existing remote agent id (fetches initial snapshot).
 */
export async function connectRemoteSession(
  baseUrl: string,
  agentId: string,
  fetchImpl: typeof fetch = fetch
): Promise<RemoteSessionClient> {
  const response = await fetchImpl(joinUrl(baseUrl, `/api/agent/${agentId}/snapshot`));
  const initialSnapshot = await readJson<AgentSessionSnapshot>(response);
  return new RemoteSessionClient({ baseUrl, agentId, initialSnapshot, fetchImpl });
}

/**
 * Create a remote agent session and return a client bound to its id.
 */
export async function createRemoteSession(
  baseUrl: string,
  body: {
    model: string;
    style?: "openai" | "anthropic";
    baseURL?: string;
    apiKey?: string;
    name?: string;
    systemPrompt?: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<RemoteSessionClient> {
  const response = await fetchImpl(joinUrl(baseUrl, "/api/agent"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson<{ id: string; snapshot: AgentSessionSnapshot }>(response);
  return new RemoteSessionClient({
    baseUrl,
    agentId: data.id,
    initialSnapshot: data.snapshot,
    fetchImpl,
  });
}

export class RemoteSessionClient implements AgentSession {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private snapshot: AgentSessionSnapshot;
  /** When the snapshot was last (re)hydrated in full; 0 = never (shell only). */
  private lastSyncAt = 0;
  /** Shared in-flight resync so concurrent callers fetch the transcript once. */
  private resyncInFlight: Promise<void> | null = null;
  private readonly summaryCache = new Map<string, SummaryStreamSnapshot>();
  private readonly toolBufferCache: ToolBufferMap = new Map();
  /**
   * Set once the server reports this agent id no longer exists (HTTP 404
   * "Session not found"). Terminated clients stop reconnecting and fail fast:
   * `dispatch` returns `not_found`, and the host evicts them so a stale
   * journal mapping heals into a fresh session instead of reconnecting forever.
   */
  private terminated = false;
  private terminatedReason = "";

  constructor(options: RemoteSessionClientOptions) {
    this.id = options.agentId;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.snapshot = options.initialSnapshot ?? emptySnapshot(options.agentId);
    reviveMessageTimestamps(this.snapshot.messages);
    if (this.snapshot.toolDescriptors.length > 0) hydrateToolPresentations(this.snapshot.toolDescriptors);
    if (options.initialSnapshot) this.lastSyncAt = Date.now();
  }

  /** Whether the server reported this session as gone (404). */
  isTerminated(): boolean {
    return this.terminated;
  }

  private markTerminated(reason: string): void {
    if (this.terminated) return;
    this.terminated = true;
    this.terminatedReason = reason;
    console.error(`[RemoteSessionClient] session ${this.id} terminated: ${reason}`);
  }

  /** Refetch full snapshot + remount seeds. Used for lazy connect and manual resync. */
  async refresh(): Promise<void> {
    if (this.terminated) return;
    await this.resync();
  }

  /** True when the cached snapshot is missing or older than `freshnessMs`. */
  isSnapshotStale(freshnessMs = RESYNC_FRESH_MS): boolean {
    return !this.terminated && Date.now() - this.lastSyncAt > freshnessMs;
  }

  getSnapshot(): AgentSessionSnapshot {
    return this.snapshot;
  }

  getSummaryStreamSnapshot(key: string): SummaryStreamSnapshot | null {
    return this.summaryCache.get(key) ?? null;
  }

  /** Latest buffered tool output per toolCallId (client-side remount source). */
  getToolBuffers(): Record<string, { stdout: string; stderr: string }> {
    return Object.fromEntries(this.toolBufferCache);
  }

  async dispatch(command: AgentSessionCommand): Promise<AgentSessionCommandResult> {
    if (this.terminated) {
      return { ok: false, code: "not_found", error: this.terminatedReason || "Session not found on server" };
    }
    try {
      const response = await this.fetchImpl(joinUrl(this.baseUrl, `/api/agent/${this.id}/command`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (response.status === 404) {
        this.markTerminated("Session not found on server");
        return { ok: false, code: "not_found", error: "Session not found on server" };
      }
      // State changes propagate via the subscribed channels (state/messages/
      // usage/todos/plan/...) — no full-snapshot refetch per command.
      return await readJson<AgentSessionCommandResult>(response);
    } catch (error) {
      // Transport failure. The server resolves `send`-style commands only when
      // the whole run has finished, so a run outlasting the HTTP headers
      // timeout (~300s, UND_ERR_HEADERS_TIMEOUT) lands here. The run keeps
      // going server-side and streams over SSE; rejecting instead would crash
      // fire-and-forget callers with an unhandled rejection.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[RemoteSessionClient] dispatch transport error: ${message}`);
      return { ok: false, code: "failed", error: message };
    }
  }

  /**
   * Fetch full snapshot + remount seeds. Used at subscribe start, reconnects,
   * and lazy connect. Concurrent callers share one fetch — `host.connect()`
   * fires an eager refresh while the first subscribe may resync immediately
   * after; without dedupe that re-downloads the transcript twice.
   */
  private resync(): Promise<void> {
    if (this.resyncInFlight) return this.resyncInFlight;
    const run = this.doResync().finally(() => {
      this.resyncInFlight = null;
    });
    this.resyncInFlight = run;
    return run;
  }

  private async doResync(): Promise<void> {
    const snapRes = await this.fetchImpl(joinUrl(this.baseUrl, `/api/agent/${this.id}/snapshot`));
    if (snapRes.status === 404) {
      this.markTerminated("Session not found on server");
      throw new Error("Session not found on server (404)");
    }
    this.snapshot = await readJson<AgentSessionSnapshot>(snapRes);
    reviveMessageTimestamps(this.snapshot.messages);
    if (this.snapshot.toolDescriptors.length > 0) hydrateToolPresentations(this.snapshot.toolDescriptors);
    this.lastSyncAt = Date.now();

    try {
      const sumRes = await this.fetchImpl(joinUrl(this.baseUrl, `/api/agent/${this.id}/summary-streams`));
      const data = await readJson<{ snapshots: SummaryStreamSnapshot[] }>(sumRes);
      this.summaryCache.clear();
      for (const snapshot of data.snapshots ?? []) this.summaryCache.set(snapshot.key, snapshot);
    } catch {
      // Optional route — ignore failures.
    }
    try {
      const bufRes = await this.fetchImpl(joinUrl(this.baseUrl, `/api/agent/${this.id}/tool-buffers`));
      const data = await readJson<{ buffers: Record<string, { stdout: string; stderr: string }> }>(bufRes);
      this.toolBufferCache.clear();
      for (const [key, value] of Object.entries(data.buffers ?? {})) this.toolBufferCache.set(key, value);
    } catch {
      // Optional route — ignore failures.
    }
  }

  subscribe(handler: AgentSessionSubscriber, options?: AgentSessionSubscribeOptions): () => void {
    const stopController = new AbortController();
    let attempt = 0;
    let stopped = false;

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const connectLoop = async (): Promise<void> => {
      let firstConnect = true;
      while (!stopped && !stopController.signal.aborted) {
        // Per-connection controller so the liveness watchdog can kill a dead
        // stream without tearing down the whole subscription.
        const connection = new AbortController();
        const onStop = () => connection.abort();
        stopController.signal.addEventListener("abort", onStop, { once: true });

        try {
          // The snapshot is often already fresh: host.create returns it inline
          // and host.connect() fires an eager refresh (deduped via resync()).
          // A redundant resync re-downloads the whole transcript — skip it on
          // the very first connect. Reconnects always resync to heal any
          // frames missed while the stream was down.
          if (!firstConnect || this.isSnapshotStale()) await this.resync();
          firstConnect = false;
          const channels = options?.channels?.length ? `?channels=${options.channels.join(",")}` : "";
          const url = joinUrl(this.baseUrl, `/api/agent/${this.id}/events${channels}`);
          const response = await this.fetchImpl(url, {
            headers: { Accept: "text/event-stream" },
            signal: connection.signal,
          });
          if (!response.ok || !response.body) {
            throw new Error(`SSE failed: HTTP ${response.status}`);
          }

          attempt = 0;
          let lastActivityAt = Date.now();

          const watchdog = setInterval(() => {
            if (Date.now() - lastActivityAt > HEARTBEAT_TIMEOUT_MS) {
              connection.abort(); // dead stream — catch below schedules a reconnect
            }
          }, 5_000);
          connection.signal.addEventListener("abort", () => clearInterval(watchdog), { once: true });

          try {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (!connection.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              lastActivityAt = Date.now();
              buffer += decoder.decode(value, { stream: true });
              const parts = buffer.split("\n\n");
              buffer = parts.pop() ?? "";
              for (const part of parts) {
                const event = parseSseBlock(part);
                if (!event) continue; // heartbeat comments / keep-alives land here
                if (event.channel === "messages") {
                  // Wire encoding is a full/patch envelope (messages-delta.ts);
                  // merge into the cached array and hand subscribers the full
                  // merged list — same contract as LocalAgentSession.
                  const result = applyMessagesPayloadForTests(this.snapshot.messages, event.payload);
                  if (result.unknownKind) {
                    // Unrecognized envelope — rebuild from snapshot + seeds.
                    void this.resync().catch(() => {});
                    continue;
                  }
                  if (result.messages !== this.snapshot.messages) {
                    this.snapshot = { ...this.snapshot, messages: result.messages };
                  }
                  handler({ ...event, payload: this.snapshot.messages });
                  continue;
                }
                this.snapshot = applyEvent(this.snapshot, event, this.summaryCache, this.toolBufferCache);
                handler(event);
              }
            }
          } finally {
            clearInterval(watchdog);
            stopController.signal.removeEventListener("abort", onStop);
          }
        } catch (error) {
          if (stopped || stopController.signal.aborted) return;
          if (this.terminated) {
            // Session no longer exists server-side — stop reconnecting. The host
            // evicts terminated clients, so a stale journal mapping heals into a
            // fresh session on the next command instead of spamming retries.
            console.error(`[RemoteSessionClient] SSE stopped — ${this.terminatedReason}`);
            return;
          }
          console.error("[RemoteSessionClient] SSE error — reconnecting", error);
        }

        if (stopped || stopController.signal.aborted) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt += 1;
        await sleep(delay);
      }
    };

    void connectLoop();

    return () => {
      stopped = true;
      stopController.abort();
    };
  }

  async close(): Promise<void> {
    await this.fetchImpl(joinUrl(this.baseUrl, `/api/agent/${this.id}`), { method: "DELETE" });
  }
}

function parseSseBlock(block: string): AgentSessionEvent | null {
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    }
  }
  if (!data) return null;
  try {
    return JSON.parse(data) as AgentSessionEvent;
  } catch {
    return null;
  }
}

/**
 * @internal Exported for validators that assert an event actually mutates the cached snapshot.
 *
 * The remote plane has its own failure mode — a channel that never updates a field the UI reads,
 * so the value only moves on a full `resync()`. A validator that only inspects `AGENT_EVENT_META`,
 * `AGENT_SESSION_CHANNELS` or the SSE frame cannot see that; it has to run the reducer.
 */
export function applyEventForTests(
  snapshot: AgentSessionSnapshot,
  event: AgentSessionEvent,
  summaryCache = new Map<string, SummaryStreamSnapshot>(),
  toolBuffers = new Map()
): AgentSessionSnapshot {
  return applyEvent(snapshot, event, summaryCache, toolBuffers);
}

/** @internal Exported for validate:agent-session-http */
export function parseAgentSessionSseBlockForTests(block: string): AgentSessionEvent | null {
  return parseSseBlock(block);
}
