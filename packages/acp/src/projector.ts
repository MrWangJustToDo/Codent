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

import {
  extractCompactionSummaryBody,
  findBuiltinCommand,
  isCompactionSummaryUIMessage,
  isContextUIMessage,
  parseToolInput,
} from "@codent/core";

import { textBlock } from "./content.js";
import { imagesOfParts, imagesOfResult } from "./media.js";
import { toolCallInfo, toolDiffFor, toolKindFor, toolResultText, toolStatusFor, toolTitleOf } from "./tools.js";

import type {
  AcpCommands,
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
  ToolCallPartLike,
  ToolResultPartLike,
} from "./types.js";
import type {
  AgentL1State,
  AgentSession,
  AgentSessionEvent,
  AgentSessionSnapshot,
  SummaryStreamEvent,
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
  client: { compaction: boolean; notices: boolean };
  /** Pending approvals / ask_user, forwarded from the `interaction` channel. */
  onInteraction?: (payload: unknown) => void;
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
  private unsubscribe: (() => void) | null = null;
  /**
   * The compaction currently on the wire, if any. Its id is the protocol's upsert key, so every
   * signal for ONE compaction (the announcement, the summary chunks, the completion) has to carry the
   * same one — two ids would render as two rows.
   */
  private compaction: { id: string; key: string; summary: string } | undefined;
  /** Fallback ids, for a compaction whose summary stream was never seen (the epoch keys better). */
  private compactionSeq = 0;

  constructor(
    private readonly session: AgentSession,
    private readonly options: AcpProjectorOptions
  ) {}

  /**
   * Subscribe and (optionally) seed non-transcript state. Message content is
   * intentionally NOT seeded here — a caller that needs history replays it via
   * {@link replayFrom} (once), so `session/load`/`resume` never double-send.
   */
  start(opts: { seedState?: boolean } = {}): () => void {
    this.unsubscribe = this.session.subscribe((event) => this.onEvent(event));
    if (opts.seedState !== false) {
      const snap = this.session.getSnapshot();
      this.emitPlan(snap.todos);
      this.emitMode(snap.mode);
      this.emitUsage(snap.usage);
      this.emitTitle(snap.name);
      this.emitCommands();
    }
    return () => this.stop();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Emit a stored transcript exactly once (for `session/load`), and prime the
   * cursors so the first post-load delta does not re-send already-replayed text.
   */
  replayFrom(snapshot: AgentSessionSnapshot): void {
    for (const message of snapshot.messages) {
      // Synthetic `<ctx kind=…>` rows are persisted for the model, not for the reader: replaying one
      // would show the injected context as if the user had typed it.
      if (isContextUIMessage(message)) continue;
      if (message.role === "user") {
        this.emitUserMessage(message);
        continue;
      }
      if (message.role !== "assistant") continue;
      // Replay in PART order — the order the live stream produced. Emitting "all the text, then all the
      // thinking, then the tool calls" reordered every turn (thinking after the reply, calls after both),
      // which is exactly what a client showed after a reconnect. Zed's own adapter replays by feeding the
      // stored messages through the same notification mapping it streams live, so its order comes for
      // free; this is that shape without a second code path.
      const text = textOf(message);
      const thought = thoughtOf(message);
      for (const part of message.parts) {
        if (part.type === "thinking") {
          this.options.emit({
            sessionUpdate: "agent_thought_chunk",
            messageId: message.id,
            content: textBlock(part.content),
          });
        } else if (part.type === "text") {
          this.options.emit({
            sessionUpdate: "agent_message_chunk",
            messageId: message.id,
            content: textBlock(part.content),
          });
        } else if (part.type === "tool-call") {
          this.emitToolCall(part as ToolCallPartLike, true);
        }
      }
      this.cursors.set(message.id, { text: text.length, thought: thought.length });
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
      case "extensions":
        this.emitCommands();
        break;
      case "interaction":
        this.options.onInteraction?.(event.payload);
        break;
      case "lifecycle":
        this.onLifecycle(event.payload as { type: string });
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

  private emitMessages(messages: UIMessage[]): void {
    for (const message of messages) {
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
    const text = textOf(message);
    const images = imagesOfParts(message.parts);
    if (!text && images.length === 0) return;
    this.emittedUserMessages.add(message.id);
    if (text) {
      this.options.emit({
        sessionUpdate: "user_message_chunk",
        messageId: message.id,
        content: textBlock(text),
      });
    }
    // An attachment is part of the turn: without this the client loses the image from history on
    // `session/load` (its own live row is the client's, so only the replay can carry it back).
    for (const image of images) {
      this.options.emit({ sessionUpdate: "user_message_chunk", messageId: message.id, content: image });
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
        this.options.emit({
          sessionUpdate: "agent_message_chunk",
          messageId: `${message.id}-${Date.now()}`,
          content: textBlock(text),
        });
      }
      this.cursors.set(message.id, cursor);
      return;
    }
    if (text.length > cursor.text) {
      this.options.emit({
        sessionUpdate: "agent_message_chunk",
        messageId: message.id,
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
      this.options.emit({
        sessionUpdate: "agent_thought_chunk",
        messageId: message.id,
        content: textBlock(thought.slice(cursor.thought)),
      });
      cursor.thought = thought.length;
    }
    this.cursors.set(message.id, cursor);
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
      const next = toolStatusFor(String(part.state), part.output?.success === false);
      if (next !== state.status) {
        state.status = next;
        const terminal = next === "completed" || next === "failed";
        // `part.output` is the tool's own return value — where a `read_file` image actually lives, and
        // the door this transition used to walk past (it read `part.content`, which holds a string).
        const content = this.toolContentFor(state, terminal, undefined, [], part.output);
        if (terminal) state.streamBuffer = "";
        this.options.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          // The label travels again on every update: a client that replaces its row from the update
          // would otherwise show a blank one (see `toolTitleOf`).
          title: toolTitleOf(state.name, state.input),
          kind: toolKindFor(state.name),
          status: next,
          ...(content ? { content } : {}),
          // `rawOutput` only when there is no content to show: sending both rendered the same result
          // twice (once as content, once as the raw output).
          ...(terminal && content === undefined && part.output !== undefined ? { rawOutput: part.output } : {}),
        });
      }
    }
  }

  private createToolCall(part: ToolCallPartLike, replay: boolean): void {
    // The status comes from the PART's state, not from "was this a replay": a replayed call that never
    // finished (awaiting approval, cancelled, interrupted) was advertised as `completed`, and the next
    // live tick then downgraded it to `pending` — a terminal row the client had already frozen, so the
    // approval row could not be answered at all (reported as a stuck session with a "hidden" tool call).
    const status: ToolCallStatus = toolStatusFor(String(part.state), part.output?.success === false);
    const input = toolInputOf(part);
    const display = (part as { display?: { summary?: string; text?: string } }).display;
    // The SAME description an approval prompt gets (`toolCallInfo`): a `run_command` whose command the
    // transcript shows but an approval cannot is exactly the divergence that sharing it prevents.
    const info = toolCallInfo(part.name, input, this.options.rootPath, display?.text);
    this.tools.set(part.id, {
      status,
      name: part.name,
      // `toolInputOf`, not `part.input`: the parsed field only exists once the engine has parsed the
      // call, while the raw `arguments` are there from the first tick. Everything downstream (title,
      // preview) reads this, so it holds the best-known input rather than the strictest one.
      input,
      streamBuffer: "",
      lastStreamFlush: 0,
      resultEmitted: replay,
      previewSent: (info.content ?? []).some((content) => content.type === "diff"),
    });
    this.options.emit({ sessionUpdate: "tool_call", toolCallId: part.id, name: part.name, status, ...info });
  }

  private emitToolResult(part: ToolResultPartLike): void {
    const state = this.tools.get(part.toolCallId);
    if (state?.resultEmitted) return;
    const status: ToolCallStatus = part.state === "error" || part.outcome ? "failed" : "completed";
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
    const text = toolResultText(part.content, images.length > 0) || (part.error ?? "");
    // The tool's own value goes out as content when there is content to show (the row says "what did this
    // return"), and as the loose `rawOutput` when there is not. Not both: sending both rendered the same
    // result twice — once as the row's body, once as raw.
    const content = this.toolContentFor(resultState ?? blankToolState(), true, text, images, part.content);
    this.options.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: part.toolCallId,
      ...(resultState
        ? { title: toolTitleOf(resultState.name, resultState.input), kind: toolKindFor(resultState.name) }
        : {}),
      status,
      ...(content
        ? { content }
        : text
          ? { content: [{ type: "content", content: textBlock(text) }] as ToolCallContent[] }
          : {}),
      ...(part.content !== undefined ? { rawOutput: part.content } : {}),
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
    const diff = toolDiffFor(state.name, state.input, this.options.rootPath);
    if (diff) parts.push(diff);
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
    const diff = toolDiffFor(state.name, state.input, this.options.rootPath);
    if (!diff) return;
    state.previewSent = true;
    this.options.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      title: toolTitleOf(state.name, state.input),
      kind: toolKindFor(state.name),
      status: state.status,
      content: [diff],
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
    this.options.emit({
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
      this.options.emit({
        sessionUpdate: "agent_message_chunk",
        messageId: `compact:${message.id}`,
        content: textBlock(COMPACTION_NOTICE),
      });
      return;
    }
    this.options.emit({
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
    this.options.emit({ sessionUpdate: "plan", entries });
  }

  private emitMode(mode: string): void {
    if (mode === this.priorMode) return;
    this.priorMode = mode;
    this.options.emit({ sessionUpdate: "current_mode_update", currentModeId: mode });
  }

  private emitUsage(usage: { contextFillTokens?: number; tokenLimit?: number; cost?: number } | undefined): void {
    if (!usage) return;
    const used = usage.contextFillTokens ?? 0;
    const size = usage.tokenLimit ?? 0;
    if (size <= 0) return;
    this.options.emit({
      sessionUpdate: "usage_update",
      used,
      size,
      ...(usage.cost && usage.cost > 0 ? { cost: { amount: usage.cost, currency: "USD" } } : {}),
    });
  }

  private emitTitle(name: string): void {
    if (!name || name === this.priorTitle) return;
    this.priorTitle = name;
    this.options.emit({ sessionUpdate: "session_info_update", title: name });
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
    this.options.emit({ sessionUpdate: "available_commands_update", availableCommands });
  }

  /** Compaction completion → `compaction_update` (gated by the client capability). */
  private onLifecycle(event: { type: string; error?: unknown }): void {
    const type = event.type;
    if (type === "compaction:auto-complete" || type === "compaction:reactive-complete") {
      this.finishCompaction("completed");
    } else if (type === "compaction:auto-error" || type === "compaction:reactive-error") {
      this.finishCompaction("failed", typeof event.error === "string" ? event.error : undefined);
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
    this.emitTitle(state.name);
    if (state.status === "compacting") {
      if (!this.compaction) {
        this.compaction = { id: this.nextCompactionId(), key: "", summary: "" };
        this.announceCompaction();
      }
      return;
    }
    if (!this.compaction) return;
    // Leaving `compacting` without a summary `end`: aborted mid-summary, or failed before its first
    // chunk. Neither produces an `end`, and both would otherwise leave the row open forever.
    this.finishCompaction(state.status === "aborted" ? "cancelled" : "completed");
  }

  /**
   * The `summary` channel: the compact summarizer's own stream.
   *
   * A task summary is not ours to project (its row is the `task` tool call), so only `compact` is
   * followed. `reset` opens the row, `append` streams it, `end` closes it — which is the protocol's
   * `compaction_summary_chunk` contract verbatim ("a first-seen id creates an in-progress compaction").
   */
  private onSummary(event: SummaryStreamEvent): void {
    if (event.type === "reset") {
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
      this.announceCompaction();
      return;
    }
    const active = this.compaction;
    if (!active || event.key !== active.key) return;
    if (event.type === "append") {
      active.summary += event.chunk;
      // Chunks are only for a client that renders the row; the text is accumulated either way, because
      // the closing update (and the notice a non-rendering client gets) needs it.
      if (this.options.client.compaction) {
        this.options.emit({
          sessionUpdate: "compaction_summary_chunk",
          compactionId: active.id,
          content: textBlock(event.chunk),
        });
      }
      return;
    }
    this.finishCompaction("completed");
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
    this.options.emit({
      sessionUpdate: "agent_message_chunk",
      messageId: `compact:${id}`,
      content: textBlock(COMPACTION_NOTICE),
    });
  }

  private emitCompactionUpdate(status: "in_progress" | "completed" | "failed" | "cancelled"): void {
    if (!this.options.client.compaction || !this.compaction) return;
    this.options.emit({
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
    // reported, and reporting it is also what creates the row on the client's side.
    const id = this.compaction?.id ?? this.nextCompactionId();
    this.compaction = undefined;

    if (!this.options.client.compaction) {
      // Nothing to close for this client. One line at most, so a compaction is not invisible — and only
      // for a success: a failure is reported by the run that failed, and a cancelled one by the abort.
      if (status === "completed") this.emitCompactionNotice(id);
      return;
    }
    this.options.emit({
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
    this.options.emit({ sessionUpdate: "notice", severity, title: event.message });
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
