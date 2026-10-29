/**
 * AcpProjector — the outbound projection from one {@link AgentSession}'s channels
 * to ACP `session/update` notifications.
 *
 * The `messages` channel delivers the full `UIMessage[]` on every change, so the
 * projector keeps **per-message / per-tool cursors** and only emits the delta:
 *
 *  - assistant text   → `agent_message_chunk`, only the appended substring, stable `messageId`
 *  - thinking         → `agent_thought_chunk`, same cursor scheme AND the same `messageId` as the
 *                        turn's text: the protocol says a changing `messageId` starts a NEW message, so a
 *                        `-thought` suffix split every turn in two — and a replay that sent the text
 *                        first then rendered the thinking after the reply.
 *  - tool calls       → `tool_call` (first sight) then `tool_call_update` **on transition only**
 *
 * Other channels map directly: `todos` → `plan`, `mode` → `current_mode_update`,
 * `usage` → `usage_update`, `state` → `session_info_update`, `extensions` → recompute
 * `available_commands_update`, `tool` → streamed tool output, `lifecycle` → compaction,
 * `extension-ui` → notices, `interaction` → the caller's permission/elicitation hook.
 */

/* eslint-disable max-lines -- The projector owns the channel→wire cursors. Transcript replay/prime and
 * tool rows share those cursor maps, so they stay together; compaction projection is the next
 * extraction (`compaction-projector.ts`) and only shares the `publish` door. Pure per-subject helpers
 * already live in `content.ts` / `tools.ts` / `media.ts`. */

import {
  DEFAULT_AGENT_SESSION_CHANNELS,
  BUILTIN_TOOL_NAMES,
  extractCompactionSummaryBody,
  findBuiltinCommand,
  formatToolOutput,
  isCompactionSummaryUIMessage,
  isContextUIMessage,
  isCancelledToolCall,
  isUserVisibleTaskRow,
  parseToolInput,
} from "@codent/core";

import { textBlock } from "./content.js";
import { imagesOfParts, imagesOfResult } from "./media.js";
import { toWirePath } from "./paths.js";
import { announcementOf, diffSubagents, patchOf, terminalUpdateOf } from "./subagent-projection.js";
import { toolCallInfo, toolDiffsFor, toolKindFor, toolResultText, toolStatusFor, toolTitleOf } from "./tools.js";

import type {
  AcpCommands,
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  SubagentProjection,
  ToolCallContent,
  ToolCallStatus,
  ToolCallPartLike,
  ToolResultPartLike,
} from "./types.js";
import type {
  AgentL1State,
  AgentSession,
  AgentSessionChannel,
  AgentSessionEvent,
  AgentSessionSnapshot,
  AgentSessionSubagentSummary,
  AgentStreamEvent,
} from "@codent/core";
import type { UIMessage } from "@tanstack/ai";

const STREAM_FLUSH_MS = 300;

/**
 * One line, sent to a client that cannot render a compaction row (no `session.compaction`).
 *
 * The summary itself is model context, not conversation, so the body is not what a reader needs — the
 * position of the compaction is.
 */
const COMPACTION_NOTICE = "[Context compacted — earlier turns are summarized in the model's context.]";

/**
 * The call's input: the parsed field when the engine has it, else the raw `arguments` JSON.
 *
 * While a call streams, only `arguments` exists — reading `input` alone is why a `grep`/`read_file`
 * row arrived with a bare "Search"/"Read" and no parameters, and with no `rawInput` either.
 */
const toolInputOf = (part: ToolCallPartLike): unknown => part.input ?? parseToolInput(part);

/**
 * A stand-in `ToolState` for a result whose call part has not been seen yet.
 *
 * Only the fields `toolContentFor` reads matter, and it reads the NAME only to derive a `diff` — which a
 * nameless state cannot produce, so the row is the result and nothing else (correct for a result that
 * arrived without its call). Sharing one object is safe: every field is either empty or never written.
 */
function blankToolState(): ToolState {
  return {
    status: "completed",
    name: "",
    input: undefined,
    streamBuffer: "",
    lastStreamFlush: 0,
    resultEmitted: true,
    previewSent: true,
  };
}

export interface AcpProjectorOptions {
  rootPath: string;
  /** Called for every outgoing `session/update` payload. */
  emit: (update: SessionUpdate) => void;
  /** Command catalog to advertise; recomputed on the `extensions` channel. */
  commands: () => AcpCommands;
  /** Client capabilities that gate optional updates. */
  client: { compaction: boolean; notices: boolean; subagents?: boolean };
  /**
   * Called after a `subagents` snapshot has been announced/patched, with the user-visible rows.
   *
   * The host attaches/detaches child projectors here; this runs after the announcements so the
   * protocol's "announcement before child traffic" rule holds even for retained delivery.
   */
  onSubagents?: (rows: AgentSessionSubagentSummary[]) => void;
  /**
   * Project this user message as an inter-session `session_message` instead of `user_message_chunk`.
   *
   * A subagent's first user message IS its task prompt, sent by the parent — not typed by a user of
   * that session. The conversion lives here (by message id, applied to replay and live) because a
   * post-filter would miss the retained-message delivery that `replayFrom` uses.
   */
  userMessageAsSessionMessage?: {
    /**
     * The prompt's message id when it is already in the snapshot. Omitted for a remote child, whose
     * `connect()` returns an unhydrated shell: the first user message that arrives is the prompt, and
     * it still has to be converted (the live path used to drop user messages entirely).
     */
    messageId?: string;
    senderSessionId: string;
    recipientSessionId: string;
    acpMessageId: string;
  };
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

interface MsgCursor {
  /** Characters of concatenated assistant text already sent. */
  text: number;
  /** Characters of concatenated thinking already sent. */
  thought: number;
}

interface ToolState {
  status: ToolCallStatus;
  name: string;
  input: unknown;
  streamBuffer: string;
  lastStreamFlush: number;
  resultEmitted: boolean;
  /**
   * The edit preview (`diff`) already went out — either inside the initial `tool_call` or as its own
   * update. `messages` re-emits the whole array on every tick, so without this a preview would be
   * re-sent on every one of them.
   */
  previewSent: boolean;
  /** `write_file` overwrite: the previous file content, read once from the workspace. */
  oldText?: string;
  /** The old-content read was attempted (successfully or not), so it is not repeated. */
  oldTextRead?: boolean;
  /** The result's text/images, kept so a late `oldText` read can rebuild the whole row. */
  resultText?: string;
  resultImages?: ContentBlock[];
  resultContent?: unknown;
}

export class AcpProjector {
  private readonly cursors = new Map<string, MsgCursor>();
  private readonly tools = new Map<string, ToolState>();
  /**
   * User messages already reported. A user turn lands in the channel whole (it is not streamed), so
   * one emission per message id is the whole contract — and the set is what keeps a *replayed* turn
   * from being re-sent by the next live tick.
   */
  private readonly emittedUserMessages = new Set<string>();
  private priorTitle: string | undefined;
  private priorMode: string | undefined;
  /** Last advertised command list, so a retained `extensions` delivery plus a seed is one update. */
  private priorCommands: string | undefined;
  /** Last emitted plan/usage, so a retained delivery plus a seed does not duplicate them. */
  private priorPlan: string | undefined;
  private priorUsage: string | undefined;
  /** The ACP message id of the turn being emitted, and source-message → turn-id map (`syncTurnIds`).
   *  Cursors stay per SOURCE message; only the emitted id is the turn's. */
  private turnId: string | undefined;
  private readonly turnIds = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  /**
   * The compaction currently on the wire, if any. Its id is the protocol's upsert key, so every
   * signal for ONE compaction (the announcement, the summary chunks, the completion) has to carry the
   * same one — two ids would render as two rows.
   */
  private compaction: { id: string; key: string; summary: string } | undefined;
  /** Fallback ids, for a compaction whose summary stream was never seen (the epoch keys better). */
  private compactionSeq = 0;
  /**
   * Updates held until the client has the session id (`session/new`).
   *
   * Subscribing delivers retained channel values synchronously; emitting them before the response
   * means a strict client drops them as "unknown session". Queue until {@link flushDeferred}.
   */
  private deferred: SessionUpdate[] | null = null;
  /** A manual `/compact` is in flight; its command result decides the row's outcome, not `state`. */
  private manualCompaction = false;
  /**
   * The id of the compaction just closed. An auto-compaction error can arrive after the summary
   * stream's `end` (core closes the stream in `finally`), and it must patch the SAME row rather
   * than opening a second one.
   */
  private lastCompactionId: string | undefined;
  /** Bumped by {@link stop}; a late async write (oldText read) must not publish after a stop. */
  private generation = 0;
  /** Last announced projection per child, so a snapshot update becomes a patch, never a re-announcement. */
  private readonly announcedSubagents = new Map<string, SubagentProjection>();
  /** Live task-summary streams keyed by `task:<toolCallId>` — the parent-facing task report. */
  private readonly taskStreams = new Map<string, { toolCallId: string; buffer: string; lastFlush: number }>();
  /**
   * Child attach/detach deferred with the announcements it follows.
   *
   * `session/new` queues updates until the response carries the id. A child attached in that window
   * would emit its `session_message`/transcript IMMEDIATELY (its projector has its own queue), so the
   * client would see child traffic before the announcement that names it. The callback waits here
   * and runs after {@link flushDeferred} has sent the announcement.
   */
  private deferredSubagents: AgentSessionSubagentSummary[] | null = null;
  /** A lazily-resolved child prompt (remote attach) has already been converted once. */
  private promptConverted = false;

  constructor(
    private readonly session: AgentSession,
    private readonly options: AcpProjectorOptions
  ) {}

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
    this.priorPlan = undefined;
    this.priorUsage = undefined;
    this.priorCommands = undefined;
    this.priorMode = undefined;
    this.priorTitle = undefined;
    if (opts.primeOnly) this.primeFrom(this.session.getSnapshot(), false);
    const channels: AgentSessionChannel[] = opts.channels ?? [
      ...DEFAULT_AGENT_SESSION_CHANNELS,
      // The default set deliberately omits these three: a host that does not project extensions
      // should not pay for them. This host does (commands + notices), so it opts in explicitly.
      //
      // `mode` is the same kind of opt-in, and its absence here made the `case "mode"` branch below
      // unreachable: `session:mode` is emitted on its own channel (not on `state`), so a plan ending
      // via `complete_plan` never re-advertised the `category: "mode"` config option.
      "mode",
      "extensions",
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
    const snap = this.session.getSnapshot();
    this.emitPlan(snap.todos);
    this.emitMode(snap.mode);
    this.emitUsage(snap.usage);
    this.emitTitle(snap.name);
    this.emitCommands();
  }

  stop(): void {
    this.generation += 1;
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
    this.syncTurnIds(snapshot.messages);
    for (const message of snapshot.messages) {
      // Synthetic `<ctx kind=…>` rows are persisted for the model, not for the reader: replaying one
      // would show the injected context as if the user had typed it.
      if (isContextUIMessage(message)) continue;
      if (message.role === "user") {
        if (emit) this.emitUserMessage(message);
        else this.emittedUserMessages.add(message.id);
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
      const text = textOf(message);
      const thought = thoughtOf(message);
      for (const part of message.parts) {
        if (part.type === "thinking") {
          if (emit && message.role === "assistant") {
            this.publish({
              sessionUpdate: "agent_thought_chunk",
              messageId: this.acpIdOf(message),
              content: textBlock(part.content),
            });
          }
        } else if (part.type === "text") {
          if (emit && message.role === "assistant") {
            this.publish({
              sessionUpdate: "agent_message_chunk",
              messageId: this.acpIdOf(message),
              content: textBlock(part.content),
            });
          }
        } else if (part.type === "tool-call") {
          if (emit) this.emitToolCall(part as ToolCallPartLike, true);
          else this.primeToolCall(part as ToolCallPartLike);
        } else if (part.type === "tool-result") {
          // `load` owes the client tool RESULTS, not just the calls. They were dropped because this
          // loop only knew text/thinking/tool-call, and the call was then marked `resultEmitted`,
          // so the retained `messages` delivery could not send the result either.
          if (emit) this.emitToolResult(part as ToolResultPartLike);
          else this.primeToolResult(part as ToolResultPartLike);
        }
      }
      if (message.role === "assistant") {
        this.cursors.set(message.id, { text: text.length, thought: thought.length });
      }
    }
  }

  private onEvent(event: AgentSessionEvent): void {
    switch (event.channel) {
      case "messages":
        this.emitMessages(event.payload);
        break;
      case "tool":
        this.onToolChannel(event.payload);
        break;
      case "todos":
        this.emitPlan(event.payload.items);
        break;
      case "mode":
        this.emitMode(event.payload.mode);
        break;
      case "usage":
        this.emitUsage(event.payload);
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
        this.emitCommands();
        break;
      case "interaction":
        this.options.onInteraction?.(event.payload);
        break;
      case "lifecycle":
        this.onLifecycle(event.payload as { type: string; payload?: { error?: unknown; phase?: string } });
        break;
      case "extension-ui":
        this.onExtensionUi(event.payload as { type: string; message?: string; level?: string });
        break;
      default:
        break;
    }
  }

  // --------------------------------------------------------------------------
  // Messages: text, thinking, tool calls
  // --------------------------------------------------------------------------

  /**
   * One ACP `messageId` per TURN, not per model step.
   *
   * The protocol: "a changed `messageId` indicates a new message". Core gives each model step its own
   * message id (`chat-completions-…`, `anthropic-…`), so passing them through told a client that one turn
   * was several messages — two reasoning-only rows and then the answer, which reads as duplicated
   * thinking (and is what arrives out of order on a replay). The adapters Zed ships never send an id at
   * all, landing every chunk on the current message; one id per turn is that same grouping with an
   * explicit key, so a replay can patch a message instead of appending blind.
   *
   * A user message opens a turn; the turn's first assistant message names it, and every later assistant
   * message of that turn maps onto the same id. Stable across ticks and replays, because those ids are.
   */
  private syncTurnIds(messages: UIMessage[]): void {
    for (const message of messages) {
      if (message.role === "user") {
        this.turnId = undefined;
        continue;
      }
      if (message.role !== "assistant") continue;
      this.turnId ??= message.id;
      this.turnIds.set(message.id, this.turnId);
    }
  }

  private acpIdOf(message: UIMessage): string {
    return this.turnIds.get(message.id) ?? message.id;
  }

  private emitMessages(messages: UIMessage[]): void {
    this.syncTurnIds(messages);
    for (const message of messages) {
      // A child prompt can arrive on the retained `messages` tick (a remote host hydrates after
      // attach). The live path otherwise never emits user messages — the child is the exception.
      if (message.role === "user" && this.options.userMessageAsSessionMessage) {
        this.emitUserMessage(message);
        continue;
      }
      if (message.role === "assistant") {
        this.emitAssistantText(message);
        this.emitAssistantThought(message);
      }
      for (const part of message.parts) {
        if (part.type === "tool-call") this.emitToolCall(part as ToolCallPartLike, false);
        else if (part.type === "tool-result") this.emitToolResult(part as ToolResultPartLike);
      }
    }
  }

  /**
   * Report one user turn, once — used by {@link replayFrom}.
   *
   * NOT the live path: a client that submits a prompt renders it itself, so echoing it live is a
   * duplicated turn (reported as after a cancel: `1` → `11`, because the client's own optimistic row
   * stops being deduplicated once the turn it belonged to is gone). The replay is the half that needs
   * this: there the client has nothing, and the user side is what keeps two consecutive assistant
   * replies from reading as one run of text.
   */
  private emitUserMessage(message: UIMessage): void {
    if (isContextUIMessage(message)) return;
    if (isCompactionSummaryUIMessage(message)) {
      this.emitCompactionSummary(message);
      return;
    }
    if (this.emittedUserMessages.has(message.id)) return;

    // A subagent's prompt is a parent→child message, not a user turn of the child session.
    const interSession = this.options.userMessageAsSessionMessage;
    if (interSession) {
      // A fixed id (local attach) OR the first user message (remote attach, snapshot not hydrated
      // yet). Once converted, a later user message in a child is not a user-typed turn.
      const isPrompt =
        interSession.messageId === undefined ? !this.promptConverted : message.id === interSession.messageId;
      if (!isPrompt) return;
      this.promptConverted = true;
      this.emittedUserMessages.add(message.id);
      const text = textOf(message);
      const images = imagesOfParts(message.parts);
      this.publish({
        sessionUpdate: "session_message",
        messageId: interSession.acpMessageId,
        senderSessionId: interSession.senderSessionId,
        recipientSessionId: interSession.recipientSessionId,
        ...(text || images.length > 0 ? { content: [...(text ? [textBlock(text)] : []), ...images] } : {}),
      });
      return;
    }

    const text = textOf(message);
    const images = imagesOfParts(message.parts);
    if (!text && images.length === 0) return;
    this.emittedUserMessages.add(message.id);
    if (text) {
      this.publish({
        sessionUpdate: "user_message_chunk",
        messageId: message.id,
        content: textBlock(text),
      });
    }
    // An attachment is part of the turn: without this the client loses the image from history on
    // `session/load` (its own live row is the client's, so only the replay can carry it back).
    for (const image of images) {
      this.publish({ sessionUpdate: "user_message_chunk", messageId: message.id, content: image });
    }
  }

  private emitAssistantText(message: UIMessage): void {
    const text = textOf(message);
    const cursor = this.cursors.get(message.id) ?? { text: 0, thought: 0 };
    if (text.length < cursor.text) {
      // Regenerated message: ACP chunks append, so a new messageId is required.
      cursor.text = 0;
      cursor.text = text.length;
      if (text) {
        this.publish({
          sessionUpdate: "agent_message_chunk",
          messageId: `${message.id}-${Date.now()}`,
          content: textBlock(text),
        });
      }
      this.cursors.set(message.id, cursor);
      return;
    }
    if (text.length > cursor.text) {
      this.publish({
        sessionUpdate: "agent_message_chunk",
        messageId: this.acpIdOf(message),
        content: textBlock(text.slice(cursor.text)),
      });
      cursor.text = text.length;
    }
    this.cursors.set(message.id, cursor);
  }

  private emitAssistantThought(message: UIMessage): void {
    const thought = thoughtOf(message);
    const cursor = this.cursors.get(message.id) ?? { text: 0, thought: 0 };
    if (thought.length < cursor.thought) {
      // The engine replaced the reasoning with a shorter (final) version. ACP chunks are APPEND-ONLY —
      // there is no retraction — so re-sending it under this message's id appends the whole text a
      // second time, which a client renders as duplicated thinking the moment the thinking phase ends
      // (reported exactly that way). Replacing is not expressible, so the client keeps what it already
      // has and the cursor catches up in silence.
      cursor.thought = thought.length;
      this.cursors.set(message.id, cursor);
      return;
    }
    if (thought.length > cursor.thought) {
      this.publish({
        sessionUpdate: "agent_thought_chunk",
        messageId: this.acpIdOf(message),
        content: textBlock(thought.slice(cursor.thought)),
      });
      cursor.thought = thought.length;
    }
    this.cursors.set(message.id, cursor);
  }

  private toolStatusOf(part: ToolCallPartLike): ToolCallStatus {
    const approval = (part as { approval?: { needsApproval?: boolean; approved?: boolean } }).approval;
    // A denied call never runs; a still-undecided one is waiting, not executing.
    if (approval?.needsApproval && approval.approved === false) return "failed";
    if (approval?.needsApproval && approval.approved === undefined) return "pending";
    // User cancel: one predicate for both marker shapes (`cancelled` / `aborted`), the same one
    // the TUI renders — so the client sees `cancelled`, not `failed` or `completed`.
    return toolStatusFor(
      String(part.state),
      (part.output as { success?: boolean } | undefined)?.success === false,
      isCancelledToolCall(part as { output?: unknown })
    );
  }

  private emitToolCall(part: ToolCallPartLike, replay: boolean): void {
    const id = part.id;
    const state = this.tools.get(id);
    if (!state) this.createToolCall(part, replay);
    else {
      state.input = toolInputOf(part) ?? state.input;
      // The preview is a function of the INPUT, so it goes out as soon as the input is final — not when
      // the call reaches a terminal status. `content` on an update REPLACES what the client holds, and
      // the two writers (this transition, and the result part below) run in the engine's order, not
      // ours: a preview that waits for the end is erased by the result text, or never sent at all when
      // the result part moved the status first (`emitToolResult` sets it) and this branch became a
      // no-op. That is how a `write_file` row lost its edit preview.
      this.emitPreview(id, state);
      if (!replay && state.name === BUILTIN_TOOL_NAMES.writeFile) void this.readWriteOldText(id);
      const next = this.toolStatusOf(part);
      // A terminal row is final. `messages` re-delivers old parts while a later step is still
      // streaming; letting that move a completed/failed row back to `in_progress` is what made a
      // finished tool look stuck (and an approval row unanswerable).
      const terminal = state.status === "completed" || state.status === "failed";
      if (!terminal && next !== state.status) {
        state.status = next;
        const nowTerminal = next === "completed" || next === "failed";
        // `part.output` is the tool's own return value — where a `read_file` image actually lives, and
        // the door this transition used to walk past (it read `part.content`, which holds a string).
        // A `task` result is formatted for the reader (summary + status line) instead of being sent as
        // its raw object; that row is the parent's result of record.
        const taskOutput = state.name === BUILTIN_TOOL_NAMES.task ? taskOutputOf(part) : undefined;
        const taskText = taskOutput !== undefined ? formatToolOutput(taskOutput, BUILTIN_TOOL_NAMES.task) : undefined;
        const content = this.toolContentFor(state, nowTerminal, taskText, [], part.output);
        if (nowTerminal) {
          state.streamBuffer = "";
          // Only a `task` row treats an output-bearing tool-call part as the result of record — for
          // every other tool the `tool-result` part still owes the client the real result, so
          // `resultEmitted` must stay its flag. (A late task-summary chunk must not replace this.)
          if (taskText !== undefined) state.resultEmitted = true;
        }
        this.publish({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          // The label travels again on every update: a client that replaces its row from the update
          // would otherwise show a blank one (see `toolTitleOf`).
          title: toolTitleOf(state.name, state.input),
          kind: toolKindFor(state.name),
          status: next,
          ...(content ? { content } : {}),
          // `rawOutput` only when there is no content to show, and never for a `task` row (its formatted
          // text is the result, even when that text is empty).
          ...(nowTerminal && taskText === undefined && content === undefined && part.output !== undefined
            ? { rawOutput: part.output }
            : {}),
        });
      }
    }
  }

  private createToolCall(part: ToolCallPartLike, replay: boolean): void {
    // The status comes from the PART's state, not from "was this a replay": a replayed call that never
    // finished (awaiting approval, cancelled, interrupted) was advertised as `completed`, and the next
    // live tick then downgraded it to `pending` — a terminal row the client had already frozen, so the
    // approval row could not be answered at all (reported as a stuck session with a "hidden" tool call).
    const status: ToolCallStatus = this.toolStatusOf(part);
    const input = toolInputOf(part);
    const display = (part as { display?: { summary?: string; text?: string } }).display;
    // The SAME description an approval prompt gets (`toolCallInfo`): a `run_command` whose command the
    // transcript shows but an approval cannot is exactly the divergence that sharing it prevents.
    const info = toolCallInfo(part.name, input, this.options.rootPath, display?.text);
    // A replayed task row carries its result on the CALL part (`output`); the persisted result part
    // has no `output`, only the raw JSON `content`. Format it here or `session/load` shows raw JSON
    // for every historical delegation — the one surface a client without `subagents` has.
    const taskOutput = part.name === BUILTIN_TOOL_NAMES.task ? taskOutputOf(part) : undefined;
    const taskText = taskOutput !== undefined ? formatToolOutput(taskOutput, BUILTIN_TOOL_NAMES.task) : undefined;
    this.tools.set(part.id, {
      status,
      name: part.name,
      // `toolInputOf`, not `part.input`: the parsed field only exists once the engine has parsed the
      // call, while the raw `arguments` are there from the first tick. Everything downstream (title,
      // preview) reads this, so it holds the best-known input rather than the strictest one.
      input,
      streamBuffer: "",
      lastStreamFlush: 0,
      // NOT `replay`: the replay still owes the client a tool RESULT part, and a `true` here was
      // what suppressed it (the retained `messages` delivery then skipped it too). A task CALL part
      // that already carries its output IS the result, so it is the exception.
      resultEmitted: taskText !== undefined,
      previewSent: (info.content ?? []).some((content) => content.type === "diff"),
    });
    const taskContent = taskText ? [{ type: "content" as const, content: textBlock(taskText) }] : [];
    const content = [...(info.content ?? []), ...taskContent];
    this.publish({
      sessionUpdate: "tool_call",
      toolCallId: part.id,
      name: part.name,
      status,
      ...info,
      ...(content.length > 0 ? { content } : {}),
    });
    // Only a LIVE call can still see its pre-write content. On `load` replay the file has already
    // been written, so reading it would fabricate an empty/unrelated "old" side.
    if (!replay && part.name === BUILTIN_TOOL_NAMES.writeFile) void this.readWriteOldText(part.id);
  }

  /**
   * Look up a `write_file` overwrite's previous content and replace the preview with a real diff.
   *
   * The initial `tool_call` necessarily went out with `oldText: null` (the read is async). This
   * update replaces that content with the actual old file, and — because `content` replaces the
   * whole array — rebuilds the result text/images too when the tool already finished.
   */
  private async readWriteOldText(id: string): Promise<void> {
    const state = this.tools.get(id);
    if (!state || state.oldTextRead || !this.options.readFile) return;
    // While arguments stream, `input` is the raw partial JSON and has no path. Do NOT latch on that:
    // the next tick (input-complete) is the one that can actually read the file.
    const path = (state.input as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string" || !path) return;
    state.oldTextRead = true;
    const generation = this.generation;
    let old: string | null;
    try {
      old = await this.options.readFile(toWirePath(path, this.options.rootPath));
    } catch {
      old = null;
    }
    // A stop/fork happened while the read was in flight: publishing now would attach the source
    // row to a new handle.
    if (generation !== this.generation) return;
    const current = this.tools.get(id);
    if (!current) return;
    if (old === null) return;
    current.oldText = old;
    const terminal = current.status === "completed" || current.status === "failed";
    const content = terminal
      ? this.toolContentFor(current, true, current.resultText, current.resultImages, current.resultContent)
      : toolDiffsFor(current.name, current.input, this.options.rootPath, old);
    if (!content || content.length === 0) return;
    current.previewSent = true;
    this.publish({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      title: toolTitleOf(current.name, current.input),
      kind: toolKindFor(current.name),
      status: current.status,
      content,
    });
  }

  /** Prime a tool call from a snapshot without emitting it (`resume` / post-fork). */
  private primeToolCall(part: ToolCallPartLike): void {
    if (this.tools.has(part.id)) return;
    const input = toolInputOf(part);
    const display = (part as { display?: { summary?: string; text?: string } }).display;
    const info = toolCallInfo(part.name, input, this.options.rootPath, display?.text);
    this.tools.set(part.id, {
      status: this.toolStatusOf(part),
      name: part.name,
      input,
      streamBuffer: "",
      lastStreamFlush: 0,
      resultEmitted: false,
      previewSent: (info.content ?? []).some((content) => content.type === "diff"),
    });
  }

  private resultStatusOf(part: ToolResultPartLike): ToolCallStatus {
    const output = part.output as { success?: boolean } | undefined;
    // A cancelled call that returned its own partial output (`run_command` with `cancelled: true`)
    // or a `task` whose subagent stopped (`aborted: true`) did not complete. Without this the
    // result writer upgraded both to `completed`.
    if (isCancelledToolCall(part as { output?: unknown })) return "failed";
    return part.state === "error" || part.outcome || part.error || output?.success === false ? "failed" : "completed";
  }

  /** Prime a tool result from a snapshot without emitting it. */
  private primeToolResult(part: ToolResultPartLike): void {
    const state = this.tools.get(part.toolCallId);
    if (!state) return;
    state.status = this.resultStatusOf(part);
    state.resultEmitted = true;
    state.streamBuffer = "";
  }

  private emitToolResult(part: ToolResultPartLike): void {
    const state = this.tools.get(part.toolCallId);
    if (state?.resultEmitted) return;
    const resultStatus = this.resultStatusOf(part);
    // A denied call is already `failed`. Its synthetic denial result part is `state: "complete"`
    // with no `success: false`, so classifying the result alone would upgrade the row to
    // `completed` and tell the client the denied tool actually ran.
    const status: ToolCallStatus = state?.status === "failed" && resultStatus === "completed" ? "failed" : resultStatus;
    if (state) {
      state.status = status;
      state.resultEmitted = true;
      state.streamBuffer = "";
    }
    const resultState = this.tools.get(part.toolCallId);
    // Both doors: `output` is the tool's own value, `content` the model-facing projection of it (a
    // `ContentPart[]` live, its JSON once persisted). Deduped, so one screenshot arrives once. NOT gated
    // on the call part being known: the image is on the result itself, and a result that landed before its
    // call would otherwise drop the only copy of it the client will ever see.
    const images = imagesOfResult(part.output, part.content);
    // The row's text. When the bytes are being rendered as an image block they must not ALSO be prose,
    // which is what `hasMedia` tells the extractor — a bare media object declares no text and so
    // contributes none. Every other result keeps the JSON that IS its rendering.
    const taskOutput = state?.name === BUILTIN_TOOL_NAMES.task ? taskOutputOf(part) : undefined;
    const taskText = taskOutput !== undefined ? formatToolOutput(taskOutput, BUILTIN_TOOL_NAMES.task) : undefined;
    const text = taskText ?? (toolResultText(part.content, images.length > 0) || (part.error ?? ""));
    if (state) {
      // Kept so a late `write_file` oldText read can rebuild a terminal row without losing the
      // result text/images that the diff update replaces.
      state.resultText = text;
      state.resultImages = images;
      state.resultContent = part.content;
    }
    // The tool's own value goes out as content when there is content to show (the row says "what did this
    // return"), and as the loose `rawOutput` when there is not. Not both: sending both rendered the same
    // result twice — a diff (or an image) next to the tool's raw JSON, which a reader reports as the edit
    // row showing its diff twice.
    const content = this.toolContentFor(resultState ?? blankToolState(), true, text, images, part.content);
    this.publish({
      sessionUpdate: "tool_call_update",
      toolCallId: part.toolCallId,
      ...(resultState
        ? { title: toolTitleOf(resultState.name, resultState.input), kind: toolKindFor(resultState.name) }
        : {}),
      status,
      ...(isCancelledToolCall(part as { output?: unknown }) ? { _meta: { cancelled: true } } : {}),
      ...(content
        ? { content }
        : text
          ? { content: [{ type: "content", content: textBlock(text) }] as ToolCallContent[] }
          : {}),
      ...(content === undefined && taskText === undefined && part.content !== undefined
        ? { rawOutput: part.content }
        : {}),
    });
  }

  /**
   * The content a tool row shows: the edit preview (a `diff`), the result text, and any image the call
   * produced — TOGETHER.
   *
   * Both halves describe the same call, and ACP's `content` on an update replaces what the client
   * holds — so a writer that sends only its own half erases the other's, and what the user ends up
   * seeing depends on which writer ran last. One builder, used by both writers, is what makes the row
   * order-independent.
   */
  private toolContentFor(
    state: ToolState,
    terminal: boolean,
    text?: string,
    images: ContentBlock[] = [],
    result?: unknown
  ): ToolCallContent[] | undefined {
    if (!terminal) return undefined;
    const parts: ToolCallContent[] = [];
    for (const diff of toolDiffsFor(state.name, state.input, this.options.rootPath, state.oldText)) {
      parts.push(diff);
    }
    const body = text?.trim() ? text : state.streamBuffer;
    if (body) parts.push({ type: "content", content: textBlock(body) });
    // A tool that returned an image (a `read_file` of a screenshot, say) put one in the model's context;
    // without this the client's row shows nothing for it. The images come from the RESULT part when it has
    // one (both doors), else from the call part's own `output` — the transition writer's only source.
    const blocks = images.length > 0 ? images : imagesOfResult(result, undefined);
    for (const image of blocks) parts.push({ type: "content", content: image });
    return parts.length > 0 ? parts : undefined;
  }

  /**
   * Send the call's edit preview (`diff`) once, the moment its input is resolvable.
   *
   * Not gated on status: a client renders the preview from the content it holds, and the natural
   * moment for it is "the arguments are known", which is before the tool has run — and, when the
   * result lands first, the only moment it can still be sent.
   */
  private emitPreview(id: string, state: ToolState): void {
    if (state.previewSent) return;
    const diffs = toolDiffsFor(state.name, state.input, this.options.rootPath, state.oldText);
    if (diffs.length === 0) return;
    state.previewSent = true;
    this.publish({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      title: toolTitleOf(state.name, state.input),
      kind: toolKindFor(state.name),
      status: state.status,
      content: diffs,
    });
  }

  // --------------------------------------------------------------------------
  // Tool streaming (`tool` channel)
  // --------------------------------------------------------------------------

  private onToolChannel(payload: Extract<AgentSessionEvent, { channel: "tool" }>["payload"]): void {
    if (payload.kind === "clear") {
      const state = this.tools.get(payload.toolCallId);
      if (state) state.streamBuffer = "";
      return;
    }
    const chunk = payload.chunk;
    if (!chunk) return;
    const state = this.tools.get(chunk.toolCallId);
    if (!state) return;
    state.streamBuffer += chunk.chunk;
    const now = Date.now();
    if (now - state.lastStreamFlush < STREAM_FLUSH_MS) return;
    state.lastStreamFlush = now;
    this.publish({
      sessionUpdate: "tool_call_update",
      toolCallId: chunk.toolCallId,
      title: toolTitleOf(state.name, state.input),
      kind: toolKindFor(state.name),
      status: state.status === "pending" ? "in_progress" : state.status,
      content: [{ type: "content", content: textBlock(state.streamBuffer) }],
    });
  }

  /**
   * A compaction's `[CONVERSATION SUMMARY]` row.
   *
   * It is a `role: "user"` message on the channel because that is how the MODEL receives it, but it is
   * not conversation: replaying it as a user turn showed the whole summary as if the user had typed it
   * (reported for `session/load`). The protocol has the place for it — the compaction row — and its id is
   * the message id, which is stable across reloads, so a client that already holds the row patches it
   * rather than gaining another.
   */
  private emitCompactionSummary(message: UIMessage): void {
    const body = extractCompactionSummaryBody(textOf(message) ?? "");
    if (!this.options.client.compaction) {
      // No row for this client; the line keeps the compaction from being invisible in the transcript.
      this.publish({
        sessionUpdate: "agent_message_chunk",
        messageId: `compact:${message.id}`,
        content: textBlock(COMPACTION_NOTICE),
      });
      return;
    }
    this.publish({
      sessionUpdate: "compaction_update",
      compactionId: message.id,
      status: "completed",
      ...(body ? { summary: [textBlock(body)] } : {}),
    });
  }

  // --------------------------------------------------------------------------
  // Plan / mode / usage / title / commands / compaction / notices
  // --------------------------------------------------------------------------

  private emitPlan(items: AgentSessionSnapshot["todos"]): void {
    const entries: PlanEntry[] = items.map((t) => ({
      content: t.content,
      priority: t.priority,
      status: t.status,
    }));
    const signature = JSON.stringify(entries);
    if (signature === this.priorPlan) return;
    this.priorPlan = signature;
    this.publish({ sessionUpdate: "plan", entries });
  }

  private emitMode(mode: string): void {
    if (mode === this.priorMode) return;
    this.priorMode = mode;
    this.publish({ sessionUpdate: "current_mode_update", currentModeId: mode });
  }

  private emitUsage(usage: { contextFillTokens?: number; tokenLimit?: number; cost?: number } | undefined): void {
    if (!usage) return;
    const used = usage.contextFillTokens ?? 0;
    const size = usage.tokenLimit ?? 0;
    if (size <= 0) return;
    const signature = JSON.stringify([used, size, usage.cost ?? 0]);
    if (signature === this.priorUsage) return;
    this.priorUsage = signature;
    this.publish({
      sessionUpdate: "usage_update",
      used,
      size,
      ...(usage.cost && usage.cost > 0 ? { cost: { amount: usage.cost, currency: "USD" } } : {}),
    });
  }

  private emitTitle(name: string): void {
    if (this.options.suppressTitle) return;
    if (!name || name === this.priorTitle) return;
    this.priorTitle = name;
    this.publish({ sessionUpdate: "session_info_update", title: name });
  }

  private emitCommands(): void {
    const { builtin, extension } = this.options.commands();
    const seen = new Set<string>();
    const availableCommands: Array<{ name: string; description: string; input?: { hint: string } }> = [];
    for (const cmd of [...builtin, ...extension]) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      // The catalog's `usage` IS the argument hint (`/compact [focus]` → `[focus]`): the protocol shows it
      // until the user types input, and core already declares it.
      const hint = findBuiltinCommand(cmd.name)
        ?.usage?.replace(/^\/[\w-]+/, "")
        .trim();
      availableCommands.push({
        name: cmd.name,
        description: cmd.description,
        ...(hint ? { input: { hint } } : {}),
      });
    }
    const signature = JSON.stringify(availableCommands);
    // A retained `extensions` delivery and the seed that follows it describe the same catalog;
    // sending it twice makes a client reset its command list for no reason.
    if (signature === this.priorCommands) return;
    this.priorCommands = signature;
    this.publish({ sessionUpdate: "available_commands_update", availableCommands });
  }

  /** Compaction completion → `compaction_update` (gated by the client capability). */
  private onLifecycle(event: {
    type: string;
    payload?: { payload?: { error?: unknown }; error?: unknown };
    error?: unknown;
  }): void {
    // The channel carries the `AgentEvent` envelope (`payload.payload` holds the event's data);
    // projectors driven directly by validators pass the data payload itself. Read both.
    const data = (event.payload?.payload ?? event.payload ?? event) as { error?: unknown };
    const type = event.type;
    if (type === "compaction:auto-complete" || type === "compaction:reactive-complete") {
      this.finishCompaction("completed");
    } else if (type === "compaction:auto-error" || type === "compaction:reactive-error") {
      const error = data.error;
      const message =
        typeof error === "string" ? error : ((error as { message?: string } | undefined)?.message ?? undefined);
      this.finishCompaction("failed", message);
    }
  }

  /**
   * The `state` channel: the status is the only signal a compaction gets that does not depend on the
   * summarizer producing text, so it opens the row when nothing else has.
   *
   * `core` deliberately keeps `compaction:auto-start` / `reactive-start` channel-less ("status covers
   * 'compacting'"), which is exactly this field — and both the automatic and the manual path go
   * through `beginCompaction`, so a manual `/compact` is reported here too.
   */
  private onState(state: AgentL1State): void {
    this.options.onState?.(state);
    this.emitTitle(state.name);
    if (state.status === "compacting") {
      if (!this.compaction) {
        this.lastCompactionId = undefined;
        this.compaction = { id: this.nextCompactionId(), key: "", summary: "" };
        this.announceCompaction();
      }
      return;
    }
    if (!this.compaction) return;
    // A manual `/compact` has no lifecycle event: its command result is the outcome, and it may
    // restore the PREVIOUS status (often `idle`) on failure. Wait for `finishManualCompaction`.
    if (this.manualCompaction) return;
    // Leaving `compacting` without a summary `end`: aborted mid-summary, or failed before its first
    // chunk. Neither produces an `end`, and both would otherwise leave the row open forever.
    this.finishCompaction(state.status === "aborted" ? "cancelled" : state.status === "error" ? "failed" : "completed");
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
    this.taskStreams.clear();
  }

  /** Re-diff the session's current `subagents` rows (fork / rebind after `/new` · `/clone` · `/resume`). */
  resyncSubagents(): void {
    this.onSubagents(this.session.getSnapshot().subagents ?? []);
  }

  /** Mark the start of a manual `/compact`; its command result closes the row (see below). */
  beginManualCompaction(): void {
    this.manualCompaction = true;
  }

  /** Close a manual compaction from the command's own result (`ok`/`error`). */
  finishManualCompaction(status: "completed" | "failed" | "cancelled", error?: string): void {
    this.manualCompaction = false;
    // Already closed by the summary stream's `end`: do not re-emit a completed row.
    if (!this.compaction && status === "completed") return;
    this.finishCompaction(status, error);
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
    if (!this.options.client.subagents) return;

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
        const input = toolInputOf(part as ToolCallPartLike);
        const record = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined;
        const description = typeof record?.description === "string" ? record.description : undefined;
        const prompt = typeof record?.prompt === "string" ? record.prompt : undefined;
        return description ?? prompt;
      }
    }
    return undefined;
  }

  /**
   * The `summary` channel: the compact summarizer's own stream.
   *
   * A task summary is not ours to project (its row is the `task` tool call), so only `compact` is
   * followed. `reset` opens the row, `append` streams it, `end` closes it — which is the protocol's
   * `compaction_summary_chunk` contract verbatim ("a first-seen id creates an in-progress compaction").
   * Task streams are keyed separately by `task:<toolCallId>` and update that row instead.
   */
  private onSummary(event: AgentStreamEvent): void {
    if (event.type === "reset") {
      // A task summary is the PARENT-facing result stream for one task tool call. It is not a
      // compaction row and not a child message: it updates the existing task row's content.
      if (event.source === "task" && event.toolCallId) {
        this.taskStreams.set(event.key, { toolCallId: event.toolCallId, buffer: "", lastFlush: 0 });
        return;
      }
      if (event.source !== "compact") return;
      if (this.compaction) {
        // Opened already from the status (`compacting` fires first): the same compaction, one row.
        this.compaction.key = event.key;
        return;
      }
      this.compaction = {
        id: event.epoch ?? event.compactId ?? this.nextCompactionId(),
        key: event.key,
        summary: "",
      };
      this.lastCompactionId = undefined;
      this.announceCompaction();
      return;
    }
    // Task streams are keyed independently of the compaction row.
    const task = this.taskStreams.get(event.key);
    if (task) {
      if (event.type === "append") {
        task.buffer += event.chunk;
        const toolState = this.tools.get(task.toolCallId);
        // A chunk that arrives after the final result must be dropped — otherwise it would replace
        // the terminal content with a partial buffer.
        if (!toolState || toolState.resultEmitted) return;
        const now = Date.now();
        if (now - task.lastFlush < STREAM_FLUSH_MS) return;
        task.lastFlush = now;
        this.publish({
          sessionUpdate: "tool_call_update",
          toolCallId: task.toolCallId,
          title: toolTitleOf(toolState.name, toolState.input),
          kind: toolKindFor(toolState.name),
          status: toolState.status === "pending" ? "in_progress" : toolState.status,
          // ACP tool `content` REPLACES what the client holds; there is no append form, so each
          // update re-sends the whole accumulated text.
          content: [{ type: "content", content: textBlock(task.buffer) }],
        });
        return;
      }
      this.taskStreams.delete(event.key);
      return;
    }

    const active = this.compaction;
    if (!active || event.key !== active.key) return;
    if (event.type === "append") {
      active.summary += event.chunk;
      // Chunks are only for a client that renders the row; the text is accumulated either way, because
      // the closing update (and the notice a non-rendering client gets) needs it.
      if (this.options.client.compaction) {
        this.publish({
          sessionUpdate: "compaction_summary_chunk",
          compactionId: active.id,
          content: textBlock(event.chunk),
        });
      }
      return;
    }
    // A compact stream `end` closes ONE summarization pass, not the whole compaction. Multi-pass
    // auto-compaction continues with same-epoch appends (segmented input / prefix summary), and
    // the lifecycle `compaction:*:complete` (or the manual command result) closes the row with the
    // accumulated summary. Finishing here discarded every pass after the first.
    //
    // CONTRACT: every producer that opens a `compact` summary stream MUST eventually emit
    // `compaction:auto-complete` / `compaction:reactive-complete`, or be a manual `/compact` whose
    // command result calls `finishManualCompaction`. Without one of those, the row intentionally
    // stays `in_progress`; `end` is not a completion signal for a multi-pass compaction.
  }

  /** An id is only required to be unique within the session, so a counter satisfies it. */
  private nextCompactionId(): string {
    this.compactionSeq += 1;
    return `compact-${this.compactionSeq}`;
  }

  private announceCompaction(): void {
    this.emitCompactionUpdate("in_progress");
  }

  /** The one line a client without the compaction capability gets, instead of an open row. */
  private emitCompactionNotice(id: string): void {
    this.publish({
      sessionUpdate: "agent_message_chunk",
      messageId: `compact:${id}`,
      content: textBlock(COMPACTION_NOTICE),
    });
  }

  private emitCompactionUpdate(status: "in_progress" | "completed" | "failed" | "cancelled"): void {
    if (!this.options.client.compaction || !this.compaction) return;
    this.publish({
      sessionUpdate: "compaction_update",
      compactionId: this.compaction.id,
      status,
    });
  }

  /**
   * Close the open compaction: the summary stream's `end`, a lifecycle fault, or leaving `compacting`.
   * The accumulated summary is patched in once, at the end — the chunks already streamed it, and
   * `summary` has replace semantics, so sending it again is what makes the row readable for a client
   * that dropped the chunks.
   */
  private finishCompaction(status: "completed" | "failed" | "cancelled", error?: string): void {
    const summary = this.compaction?.summary.trim();
    // The id survives the row: a completion whose own summary stream was never seen still has to be
    // reported, and reporting it is also what creates the row on the client's side. If the summary
    // stream already closed the row, a late error (<compaction>:auto-error is emitted after the
    // stream's `finally end`) patches the SAME id instead of opening a second row.
    const id = this.compaction?.id ?? this.lastCompactionId ?? this.nextCompactionId();
    this.compaction = undefined;
    this.lastCompactionId = status === "completed" ? id : undefined;

    if (!this.options.client.compaction) {
      // Nothing to close for this client. One line at most, so a compaction is not invisible — and only
      // for a success: a failure is reported by the run that failed, and a cancelled one by the abort.
      if (status === "completed") this.emitCompactionNotice(id);
      return;
    }
    this.publish({
      sessionUpdate: "compaction_update",
      compactionId: id,
      status,
      ...(status === "completed" && summary ? { summary: [textBlock(summary)] } : {}),
      ...(error ? { error } : {}),
    });
  }

  /** Extension notify → ACP `notice` (gated); otherwise leave it to the extension's own UI. */
  private onExtensionUi(event: { type: string; message?: string; level?: string }): void {
    if (event.type !== "notify" || !event.message) return;
    if (!this.options.client.notices) return;
    const severity =
      event.level === "error" ? "error" : event.level === "success" || event.level === "info" ? "info" : "warning";
    this.publish({ sessionUpdate: "notice", severity, title: event.message });
  }
}

/**
 * A task result from either persisted shape: the call part's `output`, or the result part's raw-JSON
 * `content` (older sessions persist no `output`). Anything that is not a JSON object stays unknown,
 * so a non-task payload is never guessed into a task result.
 */
function taskOutputOf(part: { output?: unknown; content?: unknown }): unknown {
  if (part.output !== undefined) return part.output;
  const text = typeof part.content === "string" ? part.content : toolResultText(part.content);
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; content: string } => p.type === "text")
    .map((p) => p.content)
    .join("");
}

function thoughtOf(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "thinking"; content: string } => p.type === "thinking")
    .map((p) => p.content)
    .join("");
}
