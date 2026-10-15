/**
 * In-process AgentSession: projects the agent's scoped {@link AgentEventBus}
 * into session channels (one subscription, routed by `AGENT_EVENT_META.channel`).
 */

import { AGENT_EVENT_META as EVENT_META } from "../agent/agent-event-bus";
import { Emitter } from "../utils/emitter.js";

import { dispatchLocalAgentSessionCommand } from "./local-session-dispatch.js";
import { readLocalAgentSessionSnapshot } from "./local-session-snapshot.js";
import {
  DEFAULT_AGENT_SESSION_CHANNELS,
  type AgentSession,
  type AgentSessionChannel,
  type AgentSessionCommand,
  type AgentSessionCommandResult,
  type AgentSessionEvent,
  type AgentSessionSnapshot,
  type AgentSessionSubscribeOptions,
  type AgentSessionSubscriber,
} from "./types.js";

import type { AgentEvent, AgentEventType } from "../agent/agent-event-bus";
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
    const meta = EVENT_META[eventName];
    if (meta.retained && meta.channel && !map.has(meta.channel)) {
      map.set(meta.channel, eventName);
    }
  }
  return map;
})();

type ChannelPayload<C extends AgentSessionChannel> = Extract<AgentSessionEvent, { channel: C }>["payload"];

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
    case "lifecycle":
      // The lifecycle channel carries the typed AgentEvent envelope itself.
      return { channel, payload: event as ChannelPayload<"lifecycle">, ts };
    case "extension-ui":
      return { channel, payload: event.payload as ChannelPayload<"extension-ui">, ts };
    default:
      return null;
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

  constructor(options: CreateLocalAgentSessionOptions) {
    this.managed = options.managed;
    this.manager = options.manager ?? options.managed.manager ?? null;
    this.id = options.managed.id;
  }

  getSnapshot(): AgentSessionSnapshot {
    return readLocalAgentSessionSnapshot(this.managed, this.manager);
  }

  getSummaryStreamSnapshot(key: string) {
    return this.managed.summaryStreams?.getSnapshot(key) ?? null;
  }

  listSummaryStreamSnapshots() {
    return this.managed.summaryStreams?.listSnapshots() ?? [];
  }

  subscribe(handler: AgentSessionSubscriber, options?: AgentSessionSubscribeOptions): () => void {
    const selected = resolveChannels(options);
    const unsubs: Array<() => void> = [];
    for (const channel of selected) {
      unsubs.push(this.events.on(channel, handler));
    }

    // Per-subscriber reconcile: emit the current retained value for each
    // selected channel so late subscribers see initial state without a refetch.
    const bus = this.managed.getEventBus();
    if (bus) {
      for (const channel of selected) {
        const type = RETAINED_CHANNEL_EVENT.get(channel);
        if (!type) continue;
        const payload = bus.retainedValue(type);
        if (payload === undefined) continue;
        const projected = projectChannelEvent(channel, {
          type,
          ts: now(),
          agentId: this.managed.id,
          ...(this.managed.parentId !== undefined ? { parentId: this.managed.parentId } : {}),
          payload,
        } as AgentEvent);
        if (projected) this.events.emit(channel, projected);
      }
    }

    // Per-subscriber reconcile: replay the extension render slots that were
    // published before this subscription mounted.
    if (selected.has("extension-ui")) {
      const slots = this.managed.getExtensionRunner()?.getUISlots();
      if (slots) {
        for (const [surface, entries] of Object.entries(slots)) {
          for (const [key, payload] of Object.entries(entries)) {
            this.events.emit("extension-ui", {
              channel: "extension-ui",
              payload: { type: "render", surface, key, payload },
              ts: now(),
            });
          }
        }
      }
    }

    // The underlying bus is wired once per session (ref-counted), not once per
    // subscribe() call: each subscriber registers its handler on the shared bus
    // above, and a per-subscribe wiring would duplicate every event per
    // subscriber (N subscribers → N copies).
    this.sourceRefCount += 1;
    if (!this.sourceTeardown) this.sourceTeardown = this.wireSource();
    unsubs.push(() => this.releaseSource());

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

  private releaseSource(): void {
    this.sourceRefCount -= 1;
    if (this.sourceRefCount > 0) return;
    this.sourceRefCount = 0;
    const teardown = this.sourceTeardown;
    this.sourceTeardown = null;
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
        const channel = EVENT_META[eventName].channel;
        if (!channel) continue;
        unsubs.push(
          bus.on(
            eventName,
            (event) => {
              if (!this.acceptEvent(event)) return;
              const projected = projectChannelEvent(channel, event);
              if (projected) this.events.emit(channel, projected);
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

  async dispatch(command: AgentSessionCommand): Promise<AgentSessionCommandResult> {
    return dispatchLocalAgentSessionCommand(this.managed, this.manager, command);
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
