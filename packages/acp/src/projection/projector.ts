/**
 * AcpProjector — the outbound projection from one {@link AgentSession}'s channels to ACP
 * `session/update` notifications, and the subscription/deferral they share.
 *
 * The `messages` channel delivers the full `UIMessage[]` on every change, so the projector keeps
 * **per-message / per-tool cursors** and only emits the delta: appended text only, a stable
 * `messageId` per message, `tool_call` on first sight then `tool_call_update` on transition. A single
 * frame's size is proportional to the change, not to the conversation.
 *
 * The projection itself is split by subject, because each has its own wire rules and its own state:
 *
 * | module | owns |
 * |---|---|
 * | `message-projection.ts` | text / thinking cursors, the one user-turn report a replay owes |
 * | `tool-projection.ts` | tool rows, streamed output, the parent-facing `task` report |
 * | `compaction-projection.ts` | the compaction row and its three closing signals |
 * | `session-state-projection.ts` | `plan` / mode / usage / title / available-commands frames |
 * | `subagent-projection.ts` | announce / patch / close diffs for delegated children |
 *
 * What stays here is what they share: the single subscription, the `session/new` deferral queue,
 * the replay/prime walk over the transcript (one walk, so replay and prime classify parts
 * identically), and the child-roster bookkeeping the host attaches projectors from.
 */

import {
  DEFAULT_AGENT_SESSION_CHANNELS,
  getBuiltinToolPresentation,
  isContextUIMessage,
  isUserVisibleTaskRow,
  parseToolInput,
} from "@codent/core";

import { CompactionProjection } from "./compaction-projection.js";
import { MessageProjection } from "./message-projection.js";
import { SessionStateProjection } from "./session-state-projection.js";
import { announcementOf, diffSubagents, patchOf, terminalUpdateOf } from "./subagent-projection.js";
import { ToolProjection } from "./tool-projection.js";

import type { InterSessionPrompt } from "./message-projection.js";
import type { ToolLookup } from "./tools.js";
import type {
  AcpCommands,
  SessionUpdate,
  SubagentProjection,
  ToolCallPartLike,
  ToolResultPartLike,
} from "../wire/types.js";
import type {
  AgentL1State,
  AgentSession,
  AgentSessionChannel,
  AgentSessionEvent,
  AgentSessionSnapshot,
  AgentSessionSubagentSummary,
  AgentStreamEvent,
  ToolPresentation,
} from "@codent/core";
import type { UIMessage } from "@tanstack/ai";

export interface AcpProjectorOptions {
  rootPath: string;
  /** Called for every outgoing `session/update` payload. */
  emit: (update: SessionUpdate) => void;
  /** Command catalog to advertise; recomputed on the `extensions` channel. */
  commands: () => AcpCommands;
  /**
   * Client capabilities that gate optional updates.
   *
   * Immutable for this projector's lifetime: they come from ONE `attach` (a reconnect or
   * `/resume` builds a new bridge and a new projector). Read them ONCE in the constructor and
   * keep the values on the instance, so every gated frame uses the same answer.
   */
  client: { compaction: boolean; notices: boolean; subagents?: boolean };
  /**
   * Called after a `subagents` snapshot has been announced/patched, with the user-visible rows.
   *
   * The host attaches/detaches child projectors here; this runs after the announcements so the
   * protocol's "announcement before child traffic" rule holds even for retained delivery.
   */
  onSubagents?: (rows: AgentSessionSubagentSummary[]) => void;
  /** Project this user message as an inter-session `session_message` instead of `user_message_chunk`. */
  userMessageAsSessionMessage?: InterSessionPrompt;
  /** A child's own conversation title is the parent's roster label; do not overwrite it with `name`. */
  suppressTitle?: boolean;
  /** Pending approvals / ask_user, forwarded from the `interaction` channel. */
  onInteraction?: (payload: unknown) => void;
  /**
   * The raw `state` payload, before projection — every lifecycle frame, before compaction handling.
   *
   * The ACP host uses it to remember the run's finish reason (`llm:response`), which is what
   * distinguishes a `max_tokens` stop from a natural end: core carries it on the state channel
   * rather than in the session snapshot.
   */
  onState?: (state: AgentL1State) => void;
  /** Read a workspace file, for `write_file`'s real `oldText` on an overwrite. */
  readFile?: (absolutePath: string) => Promise<string | null>;
}

export class AcpProjector {
  private readonly messages: MessageProjection;
  private readonly tools: ToolProjection;
  private readonly compaction: CompactionProjection;
  private readonly state: SessionStateProjection;
  private unsubscribe: (() => void) | null = null;
  /**
   * Updates held until the client has the session id (`session/new`).
   *
   * Subscribing delivers retained channel values synchronously; emitting them before the response
   * means a strict client drops them as "unknown session". Queue until {@link flushDeferred}.
   */
  private deferred: SessionUpdate[] | null = null;
  /** Last announced projection per child, so a snapshot update becomes a patch, never a re-announcement. */
  private readonly announcedSubagents = new Map<string, SubagentProjection>();
  /**
   * Child attach/detach deferred with the announcements it follows.
   *
   * `session/new` queues updates until the response carries the id. A child attached in that window
   * would emit its `session_message`/transcript IMMEDIATELY (its projector has its own queue), so the
   * client would see child traffic before the announcement that names it. The callback waits here
   * and runs after {@link flushDeferred} has sent the announcement.
   */
  private deferredSubagents: AgentSessionSubagentSummary[] | null = null;
  /** Capability gates, read once — see {@link AcpProjectorOptions.client}. */
  private readonly rendersSubagents: boolean;
  private readonly rendersNotices: boolean;

  constructor(
    private readonly session: AgentSession,
    private readonly options: AcpProjectorOptions
  ) {
    this.rendersSubagents = options.client.subagents === true;
    this.rendersNotices = options.client.notices;
    const publish = (update: SessionUpdate): void => this.publish(update);
    this.compaction = new CompactionProjection({ publish, renders: options.client.compaction });
    this.state = new SessionStateProjection({
      publish,
      commands: options.commands,
      ...(options.suppressTitle ? { suppressTitle: true } : {}),
    });
    this.tools = new ToolProjection({
      publish,
      rootPath: options.rootPath,
      ...(options.readFile ? { readFile: options.readFile } : {}),
      lookup: () => this.toolLookup(),
    });
    this.messages = new MessageProjection({
      publish,
      ...(options.userMessageAsSessionMessage
        ? { userMessageAsSessionMessage: options.userMessageAsSessionMessage }
        : {}),
      emitCompactionSummary: (message) => this.compaction.emitSummaryMessage(message),
    });
  }

  /**
   * The SESSION's presentation (live registrations included), not the static built-in table.
   *
   * Tool identity is a name on the wire but not in the registry: an extension may register its own
   * tool, or shadow a built-in name with a different shape. The session resolver already falls back
   * to the built-in table for the tools the agent was seeded with, so asking it is the only path that
   * describes what actually ran.
   */
  private presentationOf(name: string): ToolPresentation | undefined {
    return this.session.getToolPresentation ? this.session.getToolPresentation(name) : getBuiltinToolPresentation(name);
  }

  /** The live lookup a tool row needs: descriptor + "is this still the seeded built-in?". */
  private toolLookup(): ToolLookup {
    return {
      resolvePresentation: (name) => this.presentationOf(name),
      isBuiltin: (name) => this.session.isBuiltinTool?.(name) ?? true,
    };
  }

  /**
   * Subscribe and (optionally) seed non-transcript state.
   *
   * Message content is intentionally NOT seeded here — a caller that needs history replays it via
   * {@link replayFrom} (once), so `session/load`/`resume` never double-send. `primeOnly` primes the
   * cursors from the snapshot **before** subscribing, so the retained `messages` delivery a
   * subscription triggers finds them already at the end and emits nothing. That is what makes a
   * cold `session/resume` a resume rather than a replay of the whole transcript.
   */
  start(
    opts: {
      seedState?: boolean;
      primeOnly?: boolean;
      channels?: AgentSessionChannel[];
      /** Queue every update until {@link flushDeferred} (used by `session/new`). */
      deferEmits?: boolean;
    } = {}
  ): () => void {
    this.deferred = opts.deferEmits ? [] : null;
    // A (re)start is a new attachment: dedupe state must not suppress the seed because the SOURCE
    // conversation happened to have the same plan/commands (fork reuses this projector).
    this.state.reset();
    if (opts.primeOnly) this.primeFrom(this.session.getSnapshot(), false);
    const channels: AgentSessionChannel[] = opts.channels ?? [
      ...DEFAULT_AGENT_SESSION_CHANNELS,
      // `mode` and `extensions` are in the default set now (a default subscriber must see the mode
      // label and the extension list). This host additionally projects `extension-ui`, which is the
      // one channel genuinely opt-in: a host without an extension UI surface should not pay for it.
      "extension-ui",
    ];
    this.unsubscribe = this.session.subscribe((event) => this.onEvent(event), { channels });
    // Seeding is independent of transcript priming: `resume` primes cursors but still owes the
    // client plan/mode/usage/title/commands. `session/new` queues these via `deferEmits`.
    if (opts.seedState !== false) this.seedState();
    return () => this.stop();
  }

  /** Emit the non-transcript seed a session-creating response owes the client. */
  seedState(): void {
    this.state.seed(this.session.getSnapshot());
  }

  stop(): void {
    // A late async write (the `write_file` oldText read) must not publish after a stop/fork.
    this.tools.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.deferredSubagents = null;
  }

  /** The single outbound door: queue while `session/new`'s response is in flight, else send. */
  private publish(update: SessionUpdate): void {
    if (this.deferred) this.deferred.push(update);
    else this.options.emit(update);
  }

  /** Send what was queued while the client did not yet know the session id. */
  flushDeferred(): void {
    const queued = this.deferred;
    const children = this.deferredSubagents;
    this.deferred = null;
    this.deferredSubagents = null;
    if (queued) for (const update of queued) this.options.emit(update);
    // AFTER the announcements it was waiting behind: the child's first frame is only legal once the
    // client knows the id.
    if (children) this.options.onSubagents?.(children);
  }

  /**
   * Emit a stored transcript exactly once (for `session/load`), and prime the
   * cursors so the first post-load delta does not re-send already-replayed text.
   */
  replayFrom(snapshot: AgentSessionSnapshot): void {
    this.primeFrom(snapshot, true);
  }

  /**
   * Seed every cursor/state from a snapshot, emitting the transcript when `emit` is true.
   *
   * One walk for both jobs: the replay and the prime must classify parts identically, or a primed
   * `resume` disagrees with a replayed `load` about what the client already has.
   */
  private primeFrom(snapshot: AgentSessionSnapshot, emit: boolean): void {
    this.messages.syncTurnIds(snapshot.messages);
    for (const message of snapshot.messages) {
      // Synthetic `<ctx kind=…>` rows are persisted for the model, not for the reader: replaying one
      // would show the injected context as if the user had typed it.
      if (isContextUIMessage(message)) continue;
      if (message.role === "user") {
        if (emit) this.messages.emitUserMessage(message);
        else this.messages.primeUserMessage(message);
        continue;
      }
      // Tool-role messages (persisted at runtime; not part of the `UIMessage` union) carry their
      // results as parts. Skipping them here was why `session/load` showed a `task` — and every
      // other tool — with no result at all. Text/thinking are guarded by the assistant check below.
      // Replay in PART order — the order the live stream produced. Emitting "all the text, then all the
      // thinking, then the tool calls" reordered every turn (thinking after the reply, calls after both),
      // which is exactly what a client showed after a reconnect. Zed's own adapter replays by feeding the
      // stored messages through the same notification mapping it streams live, so its order comes for
      // free; this is that shape without a second code path.
      for (const part of message.parts) {
        if (part.type === "thinking") {
          if (emit && message.role === "assistant") this.messages.emitStored(message, "thinking", part.content);
        } else if (part.type === "text") {
          if (emit && message.role === "assistant") this.messages.emitStored(message, "text", part.content);
        } else if (part.type === "tool-call") {
          if (emit) this.tools.emitCall(part as ToolCallPartLike, true);
          else this.tools.primeCall(part as ToolCallPartLike);
        } else if (part.type === "tool-result") {
          // `load` owes the client tool RESULTS, not just the calls. They were dropped because this
          // loop only knew text/thinking/tool-call, and the call was then marked `resultEmitted`,
          // so the retained `messages` delivery could not send the result either.
          if (emit) this.tools.emitResult(part as ToolResultPartLike);
          else this.tools.primeResult(part as ToolResultPartLike);
        }
      }
      if (message.role === "assistant") this.messages.primeAssistant(message);
    }
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.channel) {
      case "messages":
        this.emitMessages(event.payload);
        break;
      case "tool":
        this.tools.emitStream(event.payload);
        break;
      case "todos":
        this.state.emitPlan(event.payload.items);
        break;
      case "mode":
        this.state.emitMode(event.payload.mode);
        break;
      case "usage":
        this.state.emitUsage(event.payload);
        break;
      case "state":
        this.onState(event.payload);
        break;
      case "summary":
        this.onSummary(event.payload);
        break;
      case "subagents":
        this.onSubagents(event.payload.subagents);
        break;
      case "extensions":
        this.state.emitCommands();
        break;
      case "interaction":
        this.options.onInteraction?.(event.payload);
        break;
      case "lifecycle":
        this.compaction.onLifecycle(event.payload as { type: string; payload?: { error?: unknown; phase?: string } });
        break;
      case "extension-ui":
        this.onExtensionUi(event.payload as { type: string; message?: string; level?: string });
        break;
      // Channels ACP does not project (the snapshot/state channel carries what it needs, and the
      // rest have no protocol frame). Listed explicitly so the default below is a COMPILE error for
      // a newly added channel instead of a silent no-op on this host.
      case "plan":
      case "mcp":
      case "iteration":
      case "jobs":
      case "queues":
      case "tool-presentation":
        break;
      default: {
        const uncovered: never = event;
        void uncovered;
        break;
      }
    }
  }

  /**
   * The live `messages` tick: text and thinking deltas, the child-prompt conversion, and tool rows —
   * in one pass, in part order (the order the live stream produced them).
   */
  private emitMessages(messages: UIMessage[]): void {
    this.messages.syncTurnIds(messages);
    for (const message of messages) {
      // A child prompt can arrive on the retained `messages` tick (a remote host hydrates after
      // attach). The live path otherwise never emits user messages — the child is the exception.
      if (message.role === "user" && this.options.userMessageAsSessionMessage) {
        this.messages.emitUserMessage(message);
        continue;
      }
      if (message.role === "assistant") this.messages.emitAssistant(message);
      for (const part of message.parts) {
        if (part.type === "tool-call") this.tools.emitCall(part as ToolCallPartLike, false);
        else if (part.type === "tool-result") this.tools.emitResult(part as ToolResultPartLike);
      }
    }
  }

  private onState(state: AgentL1State): void {
    this.options.onState?.(state);
    this.state.emitTitle(state.name);
    this.compaction.onStatus(state.status);
  }

  /** The `summary` channel: a task report updates that tool row, a compact stream its own row. */
  private onSummary(event: AgentStreamEvent): void {
    if (this.tools.emitTaskSummary(event)) return;
    this.compaction.onSummary(event);
  }

  /**
   * Forget every announced child (and its task streams) for a NEW parent conversation.
   *
   * `session/fork` re-keys this projector to a cloned session; announcing under the old id and
   * streaming child traffic from it after the fork violates the protocol's announcement rule. The
   * host stops the child projectors; the next snapshot re-announces whatever the new parent owns.
   */
  resetSubagents(): void {
    this.announcedSubagents.clear();
    this.deferredSubagents = null;
    this.tools.resetStreams();
  }

  /** Re-diff the session's current `subagents` rows (fork / rebind after `/new` · `/clone` · `/resume`). */
  resyncSubagents(): void {
    this.onSubagents(this.session.getSnapshot().subagents ?? []);
  }

  /** Mark the start of a manual `/compact`; its command result closes the row. */
  beginManualCompaction(): void {
    this.compaction.beginManual();
  }

  /** Close a manual compaction from the command's own result (`ok`/`error`). */
  finishManualCompaction(status: "completed" | "failed" | "cancelled", error?: string): void {
    this.compaction.finishManual(status, error);
  }

  /**
   * Project a `subagents` snapshot: announce first sighting, patch changed rows, forget removed ones.
   *
   * The row list includes internal workers (compaction / memory summarizers); `diffSubagents`
   * filters with `isUserVisibleTaskRow`, so those never reach the client. Removed rows are closed
   * as `idle/cancelled` before being dropped: ACP has no delete-child frame, and leaving the last
   * running state in place would strand the client's spinner forever.
   */
  private onSubagents(rows: AgentSessionSubagentSummary[]): void {
    if (!this.rendersSubagents) return;

    const { announce, patch, removed, current } = diffSubagents(this.announcedSubagents, rows, (toolCallId) =>
      this.taskPromptOf(toolCallId)
    );
    this.announcedSubagents.clear();
    for (const [id, projection] of current) this.announcedSubagents.set(id, projection);

    for (const projection of announce) this.publish(announcementOf(projection));
    for (const item of patch) {
      const update = patchOf(item.previous, item.next);
      if (update) this.publish(update);
    }
    // No deletion frame exists, so close a disappeared running row explicitly. Rows that
    // were already idle need no terminal update.
    for (const previous of removed) {
      if (previous.state.state === "idle") continue;
      this.publish(terminalUpdateOf(previous));
    }

    // ALWAYS hand the snapshot to the host, not only when the row SET changed: the host is the one
    // that knows whether a child projector actually attached (`connect()` can return null), and it
    // must get another chance on the next snapshot. It is idempotent by `bridge.subagents`.
    //
    // AFTER the announcements: the child projector is attached from this callback, and its retained
    // messages must not reach the client before the announcement that names it.
    const visible = rows.filter((row) => isUserVisibleTaskRow(row));
    if (this.deferred) this.deferredSubagents = visible;
    else this.options.onSubagents?.(visible);
  }

  /** The `task` call's description/prompt, used as the child's title fallback. */
  private taskPromptOf(toolCallId: string | undefined): string | undefined {
    if (!toolCallId) return undefined;
    for (const message of this.session.getSnapshot().messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.type !== "tool-call" || part.id !== toolCallId) continue;
        const input = parseToolInput(part as ToolCallPartLike);
        const record = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
        const description = typeof record?.description === "string" ? record.description : undefined;
        const prompt = typeof record?.prompt === "string" ? record.prompt : undefined;
        return description ?? prompt;
      }
    }
    return undefined;
  }

  /** Extension notify → ACP `notice` (gated); otherwise leave it to the extension's own UI. */
  private onExtensionUi(event: { type: string; message?: string; level?: string }): void {
    if (event.type !== "notify" || !event.message) return;
    if (!this.rendersNotices) return;
    const severity =
      event.level === "error" ? "error" : event.level === "success" || event.level === "info" ? "info" : "warning";
    this.publish({ sessionUpdate: "notice", severity, title: event.message });
  }
}
