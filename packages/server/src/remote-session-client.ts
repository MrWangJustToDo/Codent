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

import { AGENT_SESSION_CHANNELS, presentationFromInfo, errorMessage } from "@codent/core";

import { applyEvent, type ToolBufferMap } from "./remote-session-reducer.js";
import { emptySnapshot, mergeSummarySeeds, mergeToolSeeds, reviveMessageTimestamps } from "./remote-session-seed.js";

import type {
  AgentSession,
  AgentSessionChannel,
  AgentSessionCommand,
  AgentSessionCommandResult,
  AgentSessionCommandResultFor,
  AgentSessionEvent,
  AgentSessionSnapshot,
  AgentSessionSubscribeOptions,
  AgentSessionSubscriber,
  AgentStreamEvent,
  AgentStreamSnapshot,
  ToolPresentation,
} from "@codent/core";

export interface RemoteSessionClientOptions {
  baseUrl: string;
  agentId: string;
  /** Initial snapshot; when omitted the client starts from a shell and hydrates via {@link refresh}. */
  initialSnapshot?: AgentSessionSnapshot;
  fetchImpl?: typeof fetch;
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

/** One attached observer of the shared SSE stream. `channels: null` means "every channel". */
interface RemoteSubscriberEntry {
  readonly handler: AgentSessionSubscriber;
  readonly channels: Set<string> | null;
  readonly wantsSummary: boolean;
  errors: number;
}

export class RemoteSessionClient implements AgentSession {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private snapshot: AgentSessionSnapshot;
  /**
   * Bumped on every SSE application. `doResync` snapshots it before its HTTP round-trip and only
   * replaces the live state when nothing arrived meanwhile: events applied during that round-trip
   * are NEWER than the response, so overwriting would roll the client back and drop the last
   * messages patch (the server's delta baseline has already advanced, so it is never re-sent).
   */
  private snapshotVersion = 0;
  /** When the snapshot was last (re)hydrated in full; 0 = never (shell only). */
  private lastSyncAt = 0;
  /** Shared in-flight resync so concurrent callers fetch the transcript once. */
  private resyncInFlight: Promise<void> | null = null;
  /** Whether the remount seed caches (`summaryCache` / `toolBufferCache`) were ever hydrated. */
  private cachesSeeded = false;
  private readonly summaryCache = new Map<string, AgentStreamSnapshot>();
  /** Summary stream subscribers currently expecting cache refreshes (reconnect replay). */
  private readonly summarySubscribers = new Set<AgentSessionSubscriber>();
  private readonly toolBufferCache: ToolBufferMap = new Map();
  /** This session's tool descriptors; never a process-global hydration layer. */
  private readonly toolPresentations = new Map<string, ToolPresentation>();
  /**
   * Which live registrations are the seeded built-in (from `ToolPresentationInfo.origin`).
   *
   * Absent origin (a publisher that predates the field) means "unknown" — {@link isBuiltinTool}
   * answers `true` then, which keeps the host's pre-existing name-based rendering.
   */
  private readonly toolOrigins = new Map<string, "builtin" | "extension">();
  /**
   * Set once the server reports this agent id no longer exists (HTTP 404
   * "Session not found"). Terminated clients stop reconnecting and fail fast:
   * `dispatch` returns `not_found`, and the host evicts them so a stale
   * journal mapping heals into a fresh session instead of reconnecting forever.
   */
  private terminated = false;
  private terminatedReason = "";

  /**
   * Every subscriber shares ONE SSE connection.
   *
   * The reducer caches (`summaryCache`, `toolBufferCache`) are per-client state, so two connections
   * each applying the same frame appended a `tool` chunk twice and let `summary.reset` overwrite a
   * newer stream — correct-looking with one subscriber, corrupt with two. A single loop applies each
   * frame once and fans it out; the channel query is the union of what the live subscribers asked
   * for.
   */
  private readonly sseSubscribers = new Set<RemoteSubscriberEntry>();
  private sseLoop: Promise<void> | null = null;
  private sseConnection: AbortController | null = null;
  /** Channels the OPEN connection requested; null = every channel. */
  private sseChannels: string[] | null = null;
  private sseStopped = true;
  /** Set when a subscriber widens the union: reconnect now instead of after the backoff. */
  private sseRestartRequested = false;

  constructor(options: RemoteSessionClientOptions) {
    this.id = options.agentId;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.snapshot = options.initialSnapshot ?? emptySnapshot(options.agentId);
    reviveMessageTimestamps(this.snapshot.messages);
    this.setToolDescriptors(this.snapshot.toolDescriptors);
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
    // Same contract as the local session: a projection, so a host that mutates the returned array
    // cannot corrupt the cache (and the next messages patch) it was handed.
    return { ...this.snapshot, messages: [...this.snapshot.messages] };
  }

  private setToolDescriptors(descriptors: AgentSessionSnapshot["toolDescriptors"]): void {
    // A publisher that predates the field sends nothing; keep what we already learned.
    if (!Array.isArray(descriptors)) return;
    this.toolPresentations.clear();
    this.toolOrigins.clear();
    for (const descriptor of descriptors) {
      if (!descriptor?.name) continue;
      this.toolPresentations.set(descriptor.name, presentationFromInfo(descriptor));
      if (descriptor.origin) this.toolOrigins.set(descriptor.name, descriptor.origin);
    }
  }

  getAgentStreamSnapshot(key: string): AgentStreamSnapshot | null {
    return this.summaryCache.get(key) ?? null;
  }

  /** Session-scoped presentation from this client's snapshot/SSE descriptors. */
  getToolPresentation(name: string): ToolPresentation | undefined {
    const present = this.toolPresentations.get(name);
    // A publisher that omitted metadata serializes as `{ name }`; treat that as "no descriptor"
    // so the host can fall back to its static built-in table.
    return present && Object.keys(present).length > 0 ? present : undefined;
  }

  /** Whether the live tool under this name is the seeded built-in (unknown ⇒ true). */
  isBuiltinTool(name: string): boolean {
    return this.toolOrigins.get(name) !== "extension";
  }

  /** Latest buffered tool output per toolCallId (client-side remount source). */
  getToolBuffers(): Record<string, { stdout: string; stderr: string }> {
    return Object.fromEntries(this.toolBufferCache);
  }

  async dispatch<C extends AgentSessionCommand["type"]>(
    command: Extract<AgentSessionCommand, { type: C }>
  ): Promise<AgentSessionCommandResultFor<C>> {
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
      // usage/todos/plan/...) — no full-snapshot refetch per command. A session
      // switch is the exception: the server cleared its summary/tool remount
      // seeds, so our caches must be rebuilt from the new session's snapshot.
      const result = (await readJson<AgentSessionCommandResult>(response)) as AgentSessionCommandResultFor<C>;
      // `session.resume|clone|fork` answer with `uiMessages` whose `createdAt` was serialized as an
      // ISO string. Local returns real `Date`s; revive here so the contract is transport-independent.
      if (result.ok && result.data && typeof result.data === "object") {
        const uiMessages = (result.data as { uiMessages?: unknown }).uiMessages;
        if (Array.isArray(uiMessages)) reviveMessageTimestamps(uiMessages as AgentSessionSnapshot["messages"]);
      }
      if (
        result.ok &&
        (command.type === "session.new" ||
          command.type === "session.resume" ||
          command.type === "session.clone" ||
          command.type === "session.fork")
      ) {
        // A switch REPLACES the conversation: drop summary/tool entries that belonged to the
        // previous one (see `doResync`). A REFUSED switch changed nothing, so its caches must stay.
        await this.resync({ replaceCaches: true }).catch(() => undefined);
      }
      return result;
    } catch (error) {
      // Transport failure. `send` / `addToolResult` now resolve on ACCEPTANCE — core enqueues the
      // pump and returns — so a long run no longer lands here. Commands that legitimately await
      // work (`/compact`, `session.resume`, `plan.execute`) can still outlast the ~300s header
      // timeout; that work keeps going server-side and streams over SSE, so this stays a
      // recoverable failure instead of a rejection.
      const message = errorMessage(error);
      console.error(`[RemoteSessionClient] dispatch transport error: ${message}`);
      return { ok: false, code: "failed", error: message };
    }
  }

  /**
   * Fetch full snapshot + remount seeds. Used at subscribe start, reconnects,
   * and lazy connect. Concurrent callers share one fetch — `host.connect()`
   * fires an eager refresh while the first subscribe may resync immediately
   * after; without dedupe that re-downloads the transcript twice.
   *
   * `replaceCaches` is for a conversation switch: entries that belonged to the previous session are
   * dropped even when a live frame landed during the fetch (the seeds are then merged by seq/len).
   */
  private resync(options: { replaceCaches?: boolean } = {}): Promise<void> {
    if (this.resyncInFlight) {
      if (!options.replaceCaches) return this.resyncInFlight;
      // A switch must not piggyback on a plain refresh: run again after it settles.
      return this.resyncInFlight.then(() => this.resync({ replaceCaches: true }));
    }
    const run = this.doResync(options.replaceCaches === true).finally(() => {
      this.resyncInFlight = null;
    });
    this.resyncInFlight = run;
    return run;
  }

  private async doResync(replaceCaches: boolean): Promise<void> {
    const versionAtRequest = this.snapshotVersion;
    const snapRes = await this.fetchImpl(joinUrl(this.baseUrl, `/api/agent/${this.id}/snapshot`));
    if (snapRes.status === 404) {
      this.markTerminated("Session not found on server");
      throw new Error("Session not found on server (404)");
    }
    const snapshot = await readJson<AgentSessionSnapshot>(snapRes);
    // SSE applied a newer event while the snapshot was in flight: keep the live state. Replacing it
    // would lose that patch (the server will not resend it) and roll `state` back until the next
    // periodic full resync.
    if (this.snapshotVersion === versionAtRequest) {
      this.snapshot = snapshot;
      reviveMessageTimestamps(this.snapshot.messages);
      this.setToolDescriptors(this.snapshot.toolDescriptors);
    }
    this.lastSyncAt = Date.now();

    // The seed caches are NOT covered by `snapshotVersion` above: a summary/tool frame can land
    // between the version check and these fetches. Replacing unconditionally dropped it (the server
    // never resends it), so merge instead when that happened.
    const summaryVersion = this.snapshotVersion;
    try {
      const sumRes = await this.fetchImpl(joinUrl(this.baseUrl, `/api/agent/${this.id}/summary-streams`));
      const data = await readJson<{ snapshots: AgentStreamSnapshot[] }>(sumRes);
      mergeSummarySeeds(
        this.summaryCache,
        data.snapshots ?? [],
        replaceCaches || this.snapshotVersion === summaryVersion
      );
    } catch {
      // Optional route — ignore failures. On a session switch the old conversation's entries must
      // still go: leaving them lets `replaySummaryCache` re-emit the previous session's text.
      if (replaceCaches) this.summaryCache.clear();
    }
    const toolVersion = this.snapshotVersion;
    try {
      const bufRes = await this.fetchImpl(joinUrl(this.baseUrl, `/api/agent/${this.id}/tool-buffers`));
      const data = await readJson<{ buffers: Record<string, { stdout: string; stderr: string }> }>(bufRes);
      mergeToolSeeds(this.toolBufferCache, data.buffers ?? {}, replaceCaches || this.snapshotVersion === toolVersion);
    } catch {
      // Optional route — ignore failures. Same rule as the summary cache on a switch.
      if (replaceCaches) this.toolBufferCache.clear();
    }
    this.cachesSeeded = true;
    this.replaySummaryCache();
  }

  /**
   * Re-publish the re-seeded summary cache to already-mounted subscribers.
   *
   * A reconnect calls `doResync()` while the old SSE subscription is still alive. Replacing
   * `summaryCache` without an event leaves a mounted `useSummaryStream` rendering the pre-drop
   * text forever. Replay each snapshot as reset + append (+ end); subscribers filter by key.
   */
  private replaySummaryCache(): void {
    if (this.summarySubscribers.size === 0 || this.summaryCache.size === 0) return;
    const ts = Date.now();
    for (const snapshot of this.summaryCache.values()) {
      const base = {
        key: snapshot.key,
        source: snapshot.source,
        channel: snapshot.channel,
        ...(snapshot.toolCallId ? { toolCallId: snapshot.toolCallId } : {}),
        ...(snapshot.compactId ? { compactId: snapshot.compactId } : {}),
        ...(snapshot.label ? { label: snapshot.label } : {}),
        ...(snapshot.epoch ? { epoch: snapshot.epoch } : {}),
        seq: snapshot.seq,
      };
      this.emitSummary({ type: "reset", ...base, ts });
      const chunk = [...snapshot.lines, ...(snapshot.pendingLine ? [snapshot.pendingLine] : [])].join("\n");
      if (chunk) this.emitSummary({ type: "append", ...base, chunk, ts });
      if (snapshot.status === "ended") this.emitSummary({ type: "end", ...base, ts });
    }
  }

  private emitSummary(payload: AgentStreamEvent & { ts?: number }): void {
    const { ts = Date.now(), ...event } = payload;
    const message: AgentSessionEvent = { channel: "summary", payload: event as AgentStreamEvent, ts };
    for (const handler of this.summarySubscribers) handler(message);
  }

  subscribe(handler: AgentSessionSubscriber, options?: AgentSessionSubscribeOptions): () => void {
    const channels = options?.channels && options.channels.length > 0 ? new Set<string>(options.channels) : null;
    const entry: RemoteSubscriberEntry = {
      handler,
      channels,
      wantsSummary: channels === null || channels.has("summary"),
      errors: 0,
    };
    const hadSubscribers = this.sseSubscribers.size > 0;
    this.sseSubscribers.add(entry);
    if (entry.wantsSummary) this.summarySubscribers.add(handler);

    // The open stream is already filtered server-side, so a subscriber that needs a channel outside
    // the union must force a reconnect. The last unsubscribe stops the shared loop below.
    const widening = this.sseConnection !== null && !this.coversChannels(this.desiredChannels(), this.sseChannels);
    if (widening) {
      this.sseRestartRequested = true;
      this.sseConnection?.abort();
    }
    if (hadSubscribers && !widening) {
      // The server replays retained channels only to a NEW SSE connection. This subscriber joined an
      // already-open stream that already covers its channels, so replay the cached snapshot locally —
      // the same contract as `LocalAgentSession.subscribe` (a second subscriber still gets initial
      // state without a snapshot refetch).
      this.replayRetainedTo(entry);
    }
    this.startSseLoop();

    return () => {
      if (!this.sseSubscribers.delete(entry)) return;
      this.summarySubscribers.delete(handler);
      if (this.sseSubscribers.size === 0) this.stopSseLoop();
    };
  }

  /** Replay the cached retained channels to one late subscriber (no network round-trip). */
  private replayRetainedTo(entry: RemoteSubscriberEntry): void {
    const snapshot = this.snapshot;
    const deliver = (channel: AgentSessionChannel, payload: unknown): void => {
      this.deliverToEntry(entry, { channel, payload, ts: Date.now() } as AgentSessionEvent);
    };
    deliver("state", {
      status: snapshot.status,
      state: snapshot.state,
      name: snapshot.name,
      error: snapshot.error,
      pendingApprovalCount: snapshot.pendingApprovalCount,
      retry: snapshot.retry,
      model: snapshot.model,
      modelInfo: snapshot.modelInfo,
      reasoningEffort: snapshot.reasoningEffort,
      lastStreamDurationMs: snapshot.lastStreamDurationMs,
      lastFinishReason: snapshot.lastFinishReason,
      lastIteration: snapshot.lastIteration,
      sessionId: snapshot.activeSessionId,
    });
    deliver("messages", snapshot.messages);
    deliver("usage", snapshot.usage);
    deliver("todos", { items: snapshot.todos, title: snapshot.todosTitle });
    deliver("plan", snapshot.plan);
    deliver("mode", { mode: snapshot.mode, autoMode: snapshot.autoMode });
    deliver("extensions", snapshot.extensions);
    deliver("mcp", { servers: snapshot.mcp.servers });
    deliver("interaction", snapshot.interactions);
    deliver("iteration", snapshot.iteration);
    deliver("jobs", snapshot.jobs);
    deliver("subagents", { subagents: snapshot.subagents });
    deliver("queues", snapshot.queues);
    deliver("tool-presentation", { descriptors: snapshot.toolDescriptors });
  }

  private deliverToEntry(entry: RemoteSubscriberEntry, event: AgentSessionEvent): void {
    if (entry.channels && !entry.channels.has(event.channel)) return;
    try {
      entry.handler(event);
    } catch (error) {
      entry.errors += 1;
      if (entry.errors === 1) {
        console.error("[RemoteSessionClient] session subscriber threw; the event was dropped", error);
      }
    }
  }

  /**
   * Channel set the shared stream must carry.
   *
   * ALWAYS the protocol's full set, and the per-subscriber filter stays client-side
   * ({@link deliverToEntry}). The stream used to request only the union of subscriber channels,
   * which made `getSnapshot()`'s freshness depend on whether some component happened to subscribe —
   * a host reading `snapshot.subagents` / `model` without a matching subscriber saw the last
   * resync's value. It also had a coverage bug (`desiredChannels() === null` claimed to cover
   * everything, while the server's default set omits `extension-ui`), and every late subscriber
   * forced a reconnect + full resync.
   */
  private desiredChannels(): string[] {
    return [...AGENT_SESSION_CHANNELS];
  }

  private coversChannels(required: string[] | null, open: string[] | null): boolean {
    if (open === null) return true;
    if (required === null) return false;
    return required.every((channel) => open.includes(channel));
  }

  private startSseLoop(): void {
    const reviving = this.sseStopped;
    // Flip the stop flag BEFORE the "already running" check. A subscriber can arrive while the
    // previous loop is shutting down: flipping first lets that loop continue (or the finally below
    // restarts one if it already exited). Without this, an unsubscribe→subscribe in the same tick
    // left the new subscriber with no connection at all.
    this.sseStopped = false;
    if (this.sseLoop) {
      // `stopSseLoop` aborted the loop, so a reviving subscriber must reconnect immediately and the
      // abort must not be logged as a transport error.
      if (reviving) this.sseRestartRequested = true;
      return;
    }
    this.sseRestartRequested = false;
    const loop = this.runSseLoop()
      .catch((error) => {
        // The loop contains its own transient failures; a rejection here is a bug (not a dead
        // stream) and must not become an unhandled rejection in a host process.
        console.error("[RemoteSessionClient] SSE loop failed", error);
      })
      .finally(() => {
        if (this.sseLoop === loop) this.sseLoop = null;
        // A subscriber that arrived during shutdown has nobody left to start it. Never restart a
        // session the server has already reported gone: that would spin immediate retries forever.
        if (this.sseSubscribers.size > 0 && !this.sseStopped && !this.terminated) this.startSseLoop();
      });
    this.sseLoop = loop;
  }

  private stopSseLoop(): void {
    this.sseStopped = true;
    this.sseRestartRequested = false;
    this.sseConnection?.abort();
    this.sseConnection = null;
  }

  /**
   * Fan one already-applied frame out to the subscribers whose filter matches it.
   *
   * A subscriber is host code (a store setter, a UI update). It used to be called directly from the
   * reader loop, so a throw propagated into the transport catch and read as a dead connection: the
   * client resynced and reconnected every backoff interval while the event had ALREADY been applied
   * to `this.snapshot`, so the UI stayed stale. Contain it per subscriber, like the local `Emitter`.
   */
  private deliverToSubscribers(event: AgentSessionEvent): void {
    for (const entry of this.sseSubscribers) {
      this.deliverToEntry(entry, event);
    }
  }

  private async runSseLoop(): Promise<void> {
    let attempt = 0;
    let firstConnect = true;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    while (!this.sseStopped && this.sseSubscribers.size > 0) {
      const connection = new AbortController();
      this.sseConnection = connection;
      try {
        const channels = (this.sseChannels = this.desiredChannels());
        // Seed/refresh CONCURRENTLY with the stream. Awaiting it before opening the connection lost
        // every non-retained frame (tool chunks, summary appends, extension notices) emitted in that
        // window. The version guards in `doResync` make a frame racing the snapshot harmless.
        if (!firstConnect || this.isSnapshotStale() || !this.cachesSeeded) {
          void this.resync().catch((error) => {
            if (!this.terminated) console.error("[RemoteSessionClient] resync failed", error);
          });
        }
        firstConnect = false;
        const query = channels.length ? `?channels=${channels.join(",")}` : "";
        const url = joinUrl(this.baseUrl, `/api/agent/${this.id}/events${query}`);
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
                // Wire encoding is a full/patch envelope (messages-delta.ts); merge into the cached
                // array and hand subscribers the full merged list — same contract as LocalAgentSession.
                const result = applyMessagesPayloadForTests(this.snapshot.messages, event.payload);
                if (result.unknownKind) {
                  void this.resync().catch(() => {});
                  continue;
                }
                if (result.messages !== this.snapshot.messages) {
                  this.snapshot = { ...this.snapshot, messages: result.messages };
                  this.snapshotVersion += 1;
                }
                this.deliverToSubscribers({ ...event, payload: this.snapshot.messages });
                continue;
              }
              this.snapshot = applyEvent(this.snapshot, event, this.summaryCache, this.toolBufferCache);
              this.snapshotVersion += 1;
              if (event.channel === "tool-presentation") {
                this.setToolDescriptors(this.snapshot.toolDescriptors);
              }
              this.deliverToSubscribers(event);
            }
          }
        } finally {
          clearInterval(watchdog);
        }
      } catch (error) {
        if (this.sseStopped || this.sseSubscribers.size === 0) return;
        if (!this.sseRestartRequested) {
          if (this.terminated) {
            // Session no longer exists server-side — stop reconnecting. The host evicts terminated
            // clients, so a stale journal mapping heals into a fresh session instead of retrying.
            console.error(`[RemoteSessionClient] SSE stopped — ${this.terminatedReason}`);
            return;
          }
          console.error("[RemoteSessionClient] SSE error — reconnecting", error);
        }
      } finally {
        if (this.sseConnection === connection) this.sseConnection = null;
      }

      if (this.sseStopped || this.sseSubscribers.size === 0) return;
      if (this.sseRestartRequested) {
        // The channel union widened: reopen immediately with the new query, no backoff.
        this.sseRestartRequested = false;
        attempt = 0;
        continue;
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      await sleep(delay);
    }
  }

  async close(): Promise<void> {
    this.stopSseLoop();
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
  summaryCache = new Map<string, AgentStreamSnapshot>(),
  toolBuffers = new Map()
): AgentSessionSnapshot {
  return applyEvent(snapshot, event, summaryCache, toolBuffers);
}

/** @internal Exported for validate:agent-session-http */
export function parseAgentSessionSseBlockForTests(block: string): AgentSessionEvent | null {
  return parseSseBlock(block);
}
