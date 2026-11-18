/**
 * In-process AgentSession: projects the agent's scoped {@link AgentEventBus}
 * into session channels (one subscription, routed by `AGENT_EVENT_META.channel`).
 */

import { AGENT_EVENT_META as EVENT_META } from "../agent/agent-event-bus";
import { Emitter } from "../utils/emitter.js";
import { errorMessage } from "../utils/errors.js";
import { truncateText } from "../utils/text-truncation.js";

import { dispatchLocalAgentSessionCommand } from "./local-session-dispatch.js";
import { readLocalAgentSessionSnapshot } from "./local-session-snapshot.js";
import {
  DEFAULT_AGENT_SESSION_CHANNELS,
  type AgentSession,
  type AgentSessionChannel,
  type AgentSessionCommand,
  type AgentSessionCommandResultFor,
  type AgentSessionEvent,
  type AgentSessionSnapshot,
  type AgentSessionSubscribeOptions,
  type AgentSessionSubscriber,
} from "./types.js";

import type { AgentEvent, AgentEventMeta, AgentEventType } from "../agent/agent-event-bus";
import type { AgentManager } from "../managers/agent-manager.js";
import type { ManagedAgent } from "../managers/managed-agent.js";

/** Manager surface used by Local Session (AgentManager satisfies this). */
export type LocalAgentSessionManager = Pick<AgentManager, "getAgent" | "getSubagents">;

export interface CreateLocalAgentSessionOptions {
  managed: ManagedAgent;
  manager?: LocalAgentSessionManager | null;
}

function now(): number {
  return Date.now();
}

function resolveChannels(options?: AgentSessionSubscribeOptions): Set<AgentSessionChannel> {
  if (options?.channels && options.channels.length > 0) {
    return new Set(options.channels);
  }
  return new Set(DEFAULT_AGENT_SESSION_CHANNELS);
}

/**
 * Channel → retained event type. A subscriber receives the current value for
 * each such channel on subscribe (independent of the shared bus subscription),
 * so a second subscriber still gets initial state without a snapshot refetch.
 */
const RETAINED_CHANNEL_EVENT = (() => {
  const map = new Map<AgentSessionChannel, AgentEventType>();
  for (const eventName of Object.keys(EVENT_META) as AgentEventType[]) {
    // Typed read: the `as const` table omits optional keys on rows that do not use them.
    const meta: AgentEventMeta = EVENT_META[eventName];
    if (!meta.retained || !meta.channel) continue;
    const existing = map.get(meta.channel);
    if (existing !== undefined) {
      // One retained event per channel is an invariant of this map, not a preference: the replay
      // below delivers exactly one event per channel, so a second `retained: true` event on the
      // same channel would be dropped in silence. Say so once at load instead.
      console.warn(
        `[agent-session] two retained events claim channel "${meta.channel}": "${existing}" and "${eventName}"; only the first is replayed`
      );
      continue;
    }
    map.set(meta.channel, eventName);
  }
  return map;
})();

type ChannelPayload<C extends AgentSessionChannel> = Extract<AgentSessionEvent, { channel: C }>["payload"];

/** One warning per channel per process for a retained declaration with no provider. */
const warnedRetainedChannels = new Set<AgentSessionChannel>();
/**
 * Lifecycle payloads that must not cross the wire verbatim.
 *
 * They are `unknown` at the type level and come from arbitrary tool/extension results (a Buffer, a
 * Date, a multi-MB base64 image). The lifecycle channel sends the ENTIRE envelope, so those values
 * were serialized into every remote frame. Every channel consumer reads only scalar identity fields
 * (`tool_name`, `tool_call_id`, `duration_ms`, …); the local bus event keeps the raw values for
 * logs and observers, which are the only readers that need them.
 */
const CHANNEL_DROPPED_PAYLOAD_KEYS = ["tool_input", "tool_output", "output"] as const;

/**
 * Text fields that are MODEL OUTPUT rather than identity.
 *
 * They cannot be dropped — a subagent's `summary` IS its result, and an `error` is the only signal
 * that a unit failed — but they are unbounded: the `task` tool runs with `SUBAGENT_NO_TRUNCATE`, so
 * `summary` is the full report, and the lifecycle channel serializes the ENTIRE envelope into every
 * SSE frame. The log policy already knows this field is unbounded and truncates it for the same
 * reason. A preview keeps the frame small; a transcript reader uses `messages`, which carries the
 * full text.
 */
const CHANNEL_PREVIEW_TEXT_KEYS = ["summary", "error", "stack", "prompt"] as const;
/** Generous enough for a real error message; a 50KB task report still fits in `messages`. */
const CHANNEL_TEXT_PREVIEW_CHARS = 1000;

/**
 * One event whose `output` is the FACT, not an arbitrary tool result.
 *
 * `agent:client-tool-result` carries the host's answer to a client tool (`ask_user`). Dropping
 * `output` left a remote consumer with a call id and no answer, while the local bus kept it —
 * the two read the same event and disagreed.
 */
const OUTPUT_IS_PAYLOAD_EVENT = "agent:client-tool-result";

function channelSafeLifecycleEvent(event: AgentEvent): AgentEvent {
  const payload = event.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== "object") return event;
  let next: Record<string, unknown> | undefined;
  for (const key of CHANNEL_DROPPED_PAYLOAD_KEYS) {
    if (key === "output" && event.type === OUTPUT_IS_PAYLOAD_EVENT) continue;
    if (!(key in payload)) continue;
    next ??= { ...payload };
    delete next[key];
  }
  for (const key of CHANNEL_PREVIEW_TEXT_KEYS) {
    const value = payload[key];
    if (typeof value !== "string" || value.length <= CHANNEL_TEXT_PREVIEW_CHARS) continue;
    next ??= { ...payload };
    next[key] = truncateText(value, CHANNEL_TEXT_PREVIEW_CHARS);
  }
  return next ? ({ ...event, payload: next } as AgentEvent) : event;
}

/**
 * Project one scoped bus event onto its declared session channel. Returns null
 * for events that do not map to a channel.
 */
function projectChannelEvent(channel: AgentSessionChannel, event: AgentEvent): AgentSessionEvent | null {
  const ts = event.ts;
  switch (channel) {
    case "state":
      return { channel, payload: event.payload as ChannelPayload<"state">, ts };
    case "messages":
      return { channel, payload: event.payload as ChannelPayload<"messages">, ts };
    case "queues":
      return { channel, payload: event.payload as ChannelPayload<"queues">, ts };
    case "usage":
      return { channel, payload: event.payload as ChannelPayload<"usage">, ts };
    case "todos":
      return { channel, payload: event.payload as ChannelPayload<"todos">, ts };
    case "plan":
      return { channel, payload: event.payload as ChannelPayload<"plan">, ts };
    case "tool":
      return { channel, payload: event.payload as ChannelPayload<"tool">, ts };
    case "summary":
      return { channel, payload: event.payload as ChannelPayload<"summary">, ts };
    case "extensions":
      return { channel, payload: event.payload as ChannelPayload<"extensions">, ts };
    case "tool-presentation":
      return { channel, payload: event.payload as ChannelPayload<"tool-presentation">, ts };
    case "mode":
      return { channel, payload: event.payload as ChannelPayload<"mode">, ts };
    case "interaction":
      return { channel, payload: event.payload as ChannelPayload<"interaction">, ts };
    case "iteration":
      return { channel, payload: event.payload as ChannelPayload<"iteration">, ts };
    case "mcp":
      return {
        channel,
        payload: { servers: (event.payload as { servers?: ChannelPayload<"mcp">["servers"] }).servers ?? [] },
        ts,
      };
    case "jobs":
      // `session:jobs` carries `SessionJobsSnapshot`, whose shape already matches the channel
      // payload — no re-shaping. This branch was missing while the event kept its
      // `AGENT_EVENT_META` row, its `AGENT_SESSION_CHANNELS` entry, its place in
      // `DEFAULT_AGENT_SESSION_CHANNELS` and its `retain()`: `session:jobs` was routed here and
      // hit `default: return null`, so the retained value never reached a subscriber. The one
      // consumer, `RemoteSessionClient`, has a `case "jobs"` that could therefore never run.
      return { channel, payload: event.payload as ChannelPayload<"jobs">, ts };
    case "subagents":
      // Shape already matches `{ subagents }`, as with `jobs` above.
      return { channel, payload: event.payload as ChannelPayload<"subagents">, ts };
    case "lifecycle":
      // The lifecycle channel carries the typed AgentEvent envelope itself (minus the raw
      // arbitrary tool payloads — see `channelSafeLifecycleEvent`).
      return { channel, payload: channelSafeLifecycleEvent(event) as ChannelPayload<"lifecycle">, ts };
    case "extension-ui":
      return { channel, payload: event.payload as ChannelPayload<"extension-ui">, ts };
    default: {
      // Exhaustiveness. Every channel is handled above, so `channel` is `never` here — dropping a
      // channel is then a COMPILE error rather than a silent `return null` at runtime. That is what
      // `session:jobs` was: declared, retained, in the default set, and dropped because this
      // function had no branch for it while every per-event validator stayed green.
      const uncovered: never = channel;
      void uncovered;
      return null;
    }
  }
}

class LocalAgentSessionImpl implements AgentSession {
  readonly id: string;
  private readonly managed: ManagedAgent;
  private readonly manager: LocalAgentSessionManager | null | undefined;
  /** Multicast bus for session events; all channels fan out through here. */
  private readonly events = new Emitter<Record<AgentSessionChannel, AgentSessionEvent>>();
  /** Ref count for the single underlying bus subscription. */
  private sourceRefCount = 0;
  private sourceTeardown: (() => void) | null = null;
  /** True only when the bus was present at wiring time; a bus-less wiring is retried on subscribe. */
  private sourceWired = false;
  /**
   * Incremented every time the shared bus subscription is detached.
   *
   * A disposable from a previous incarnation is inert: `close()` releases the ONE subscription, so
   * the disposers outstanding at that moment must not decrement the NEXT incarnation's ref count
   * (that went negative, then to zero under a later subscriber and tore down its only subscription).
   */
  private sourceGeneration = 0;

  constructor(options: CreateLocalAgentSessionOptions) {
    this.managed = options.managed;
    this.manager = options.manager ?? options.managed.manager ?? null;
    this.id = options.managed.id;
  }

  getSnapshot(): AgentSessionSnapshot {
    return readLocalAgentSessionSnapshot(this.managed, this.manager);
  }

  getAgentStreamSnapshot(key: string) {
    return this.managed.getStreamHub()?.getSnapshot(key) ?? null;
  }

  listAgentStreamSnapshots() {
    return this.managed.getStreamHub()?.listSnapshots() ?? [];
  }

  /**
   * Command-output buffers for remount: a projection of the same stream hub the `tool` channel
   * emits from, so there is no second buffer to keep in sync (the HTTP host exposes the same view).
   */
  getToolBuffers(): Record<string, { stdout: string; stderr: string }> {
    const buffers: Record<string, { stdout: string; stderr: string }> = {};
    for (const snapshot of this.listAgentStreamSnapshots()) {
      // Only in-flight commands: the hub retains a bounded number of ENDED previews, and seeding one
      // would resurrect a finished call's buffer (no later release frame exists for it on remount).
      if (snapshot.source !== "command" || snapshot.status !== "active" || !snapshot.toolCallId) continue;
      const channel = snapshot.channel === "stderr" ? "stderr" : "stdout";
      const text = snapshot.lines.map((line) => `${line}\n`).join("") + snapshot.pendingLine;
      const entry = buffers[snapshot.toolCallId] ?? { stdout: "", stderr: "" };
      entry[channel] = text;
      buffers[snapshot.toolCallId] = entry;
    }
    return buffers;
  }

  getToolPresentation(name: string) {
    return this.managed.getToolPresentation(name);
  }

  isBuiltinTool(name: string): boolean {
    return this.managed.isBuiltinTool(name);
  }

  subscribe(handler: AgentSessionSubscriber, options?: AgentSessionSubscribeOptions): () => void {
    const selected = resolveChannels(options);
    const unsubs: Array<() => void> = [];
    for (const channel of selected) {
      unsubs.push(this.events.on(channel, handler));
    }

    // Replay to THIS subscriber only. `this.events` is the shared multicast bus; using
    // it here would send the new subscriber's initial frame to every existing subscriber
    // (duplicate messages / transcript re-renders / repeated ACP projection).
    const deliverInitial = (event: AgentSessionEvent): void => {
      try {
        const result = (handler as (value: AgentSessionEvent) => unknown)(event);
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(result).catch((error) => this.reportSubscriberFailure(error));
        }
      } catch (error) {
        // Initial reconciliation is best-effort; the live subscription remains active.
        this.reportSubscriberFailure(error);
      }
    };

    // Per-subscriber reconcile: emit the current retained value for each
    // selected channel so late subscribers see initial state without a refetch.
    const bus = this.managed.getEventBus();
    if (bus) {
      for (const channel of selected) {
        const type = RETAINED_CHANNEL_EVENT.get(channel);
        if (!type) continue;
        const payload = bus.retainedValue(type, { includeParents: false });
        if (payload === undefined) {
          // Two different silences: NO provider (reported below) and a provider that legitimately has
          // no value yet (only the former is a wiring bug). `session:jobs` shipped the first shape
          // before it gained its provider; this warning is the regression net for the declaration,
          // not a detector for "projection returned null".
          if (!bus.hasRetained(type, { includeParents: false }) && !warnedRetainedChannels.has(channel)) {
            warnedRetainedChannels.add(channel);
            console.warn(
              `[agent-session] channel "${channel}" is declared retained ("${type}") but no provider is registered; subscribers receive no initial frame`
            );
          }
          continue;
        }
        // Retained replay: the provider returns the CURRENT value, so the frame describes now, not
        // the past. Stamp the same identity a live emission carries — a subscriber that attributes
        // frames by `sessionId` (remote aggregation, log filtering) otherwise could not attribute
        // the initial frame while every later one was attributable.
        const sessionId = this.managed.getEventSessionId?.();
        const projected = projectChannelEvent(channel, {
          type,
          ts: now(),
          agentId: this.managed.id,
          ...(this.managed.parentId !== undefined ? { parentId: this.managed.parentId } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          payload,
        } as AgentEvent);
        if (projected) deliverInitial(projected);
      }
    }

    // Per-subscriber reconcile: replay the extension render slots that were
    // published before this subscription mounted.
    if (selected.has("extension-ui")) {
      const slots = this.managed.getExtensionRunner()?.getUISlots();
      if (slots) {
        for (const [surface, entries] of Object.entries(slots)) {
          for (const [key, payload] of Object.entries(entries)) {
            deliverInitial({
              channel: "extension-ui",
              payload: { type: "render", surface, key, payload },
              ts: now(),
            });
          }
        }
      }
      // …and the NOTICES published before any host listened. Slots are retained; notices are
      // one-shot events, so a notice emitted before this subscriber attached (a language server
      // reporting ready while `createSession` is still running) would otherwise be lost forever.
      // `drainUINotices` is consumed, so a re-subscribe does not replay what the user already saw.
      for (const notice of this.managed.getExtensionRunner()?.drainUINotices() ?? []) {
        deliverInitial({
          channel: "extension-ui",
          payload: { type: "notify", message: notice.message, level: notice.level },
          ts: now(),
        });
      }
    }

    // The underlying bus is wired once per session (ref-counted), not once per
    // subscribe() call: each subscriber registers its handler on the shared bus
    // above, and a per-subscribe wiring would duplicate every event per
    // subscriber (N subscribers → N copies).
    const generation = this.sourceGeneration;
    this.sourceRefCount += 1;
    // Wire only once, and only when the bus exists. `wireSource` returns a no-op teardown when the
    // bus is absent; storing that as the "wired" handle made a session created before `setEventBus`
    // permanently silent (every channel, including retained replay).
    if (!this.sourceWired) {
      const teardown = this.wireSource();
      if (this.managed.getEventBus()) {
        this.sourceWired = true;
        this.sourceTeardown = teardown;
      }
    }
    unsubs.push(() => this.releaseSource(generation));

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // Ignore teardown errors
        }
      }
    };
  }

  /** Fingerprints already reported, so a flapping subscriber cannot flood the log per frame. */
  private readonly reportedSubscriberFailures = new Set<string>();

  /** Contain a host callback failure (sync throw or async rejection) to that subscriber. */
  private reportSubscriberFailure(error: unknown): void {
    const text = errorMessage(error);
    const key = text.slice(0, 200);
    if (this.reportedSubscriberFailures.has(key)) return;
    if (this.reportedSubscriberFailures.size >= 100) this.reportedSubscriberFailures.clear();
    this.reportedSubscriberFailures.add(key);
    this.managed.emitDiagnostic("session", "session subscriber failed", {
      level: "warn",
      error: text,
    });
  }

  private releaseSource(generation: number): void {
    // A disposer from a previous incarnation is inert (see `sourceGeneration`).
    if (generation !== this.sourceGeneration) return;
    this.sourceRefCount -= 1;
    if (this.sourceRefCount > 0) return;
    this.teardownSource();
  }

  /**
   * Detach this handle's bus subscription.
   *
   * `close()` exists because a host that holds the session handle does not necessarily hold the
   * disposer `subscribe()` returned; without it the only way to stop projecting was to destroy the
   * whole agent. It releases the ONE shared subscription (not just the caller's), so every
   * outstanding disposer becomes inert; a later `subscribe()` wires a fresh one. Idempotent.
   */
  async close(): Promise<void> {
    if (!this.sourceTeardown && this.sourceRefCount === 0) return;
    this.teardownSource();
  }

  private teardownSource(): void {
    this.sourceGeneration += 1;
    this.sourceRefCount = 0;
    const teardown = this.sourceTeardown;
    this.sourceTeardown = null;
    this.sourceWired = false;
    try {
      teardown?.();
    } catch {
      // Ignore teardown errors
    }
  }

  /**
   * Wire the scoped bus once per session. Each observer event is routed to the
   * channel declared in {@link AGENT_EVENT_META}; `subscribe({channels})` only
   * filters which of those the subscriber receives.
   */
  private wireSource(): () => void {
    const unsubs: Array<() => void> = [];
    const bus = this.managed.getEventBus();

    if (bus) {
      for (const eventName of Object.keys(EVENT_META) as AgentEventType[]) {
        const channel = (EVENT_META[eventName] as AgentEventMeta).channel;
        if (!channel) continue;
        unsubs.push(
          bus.on(
            eventName,
            (event) => {
              if (!this.acceptEvent(event)) return;
              const projected = projectChannelEvent(channel, event);
              if (projected) {
                this.events.emit(channel, projected, (error) => this.reportSubscriberFailure(error));
              }
            },
            { replay: false }
          )
        );
      }
    }

    return () => {
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {
          // Ignore teardown errors
        }
      }
    };
  }

  /**
   * Scope routing delivers descendant events to ancestors. A session accepts
   * its own events plus `subagent:*` events emitted by its direct children
   * (mirrors the previous manual id filtering).
   */
  private acceptEvent(event: AgentEvent): boolean {
    if (event.agentId === this.managed.id) return true;
    return event.parentId === this.managed.id && event.type.startsWith("subagent:");
  }

  async dispatch<C extends AgentSessionCommand["type"]>(
    command: Extract<AgentSessionCommand, { type: C }>
  ): Promise<AgentSessionCommandResultFor<C>> {
    return dispatchLocalAgentSessionCommand(this.managed, this.manager, command) as Promise<
      AgentSessionCommandResultFor<C>
    >;
  }
}

/**
 * Create a Local AgentSession wrapping any ManagedAgent (root or subagent).
 */
export function createLocalAgentSession(options: CreateLocalAgentSessionOptions): AgentSession {
  return new LocalAgentSessionImpl(options);
}

/**
 * Open a child AgentSession by subagent id (same contract as the parent).
 */
export function sessionForSubagent(
  manager: LocalAgentSessionManager,
  subagentId: string,
  options?: Omit<CreateLocalAgentSessionOptions, "managed" | "manager">
): AgentSession | null {
  const child = manager.getAgent(subagentId);
  if (!child) return null;
  return createLocalAgentSession({ managed: child, manager, ...options });
}
