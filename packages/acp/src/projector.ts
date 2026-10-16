/**
 * AcpProjector — the outbound projection from one {@link AgentSession}'s channels
 * to ACP `session/update` notifications.
 *
 * The `messages` channel delivers the full `UIMessage[]` on every change, so the
 * projector keeps **per-message / per-tool cursors** and only emits the delta:
 *
 *  - assistant text   → `agent_message_chunk`, only the appended substring, stable `messageId`
 *  - thinking         → `agent_thought_chunk`, same cursor scheme
 *  - tool calls       → `tool_call` (first sight) then `tool_call_update` **on transition only**
 *
 * Other channels map directly: `todos` → `plan`, `mode` → `current_mode_update`,
 * `usage` → `usage_update`, `state` → `session_info_update`, `extensions` → recompute
 * `available_commands_update`, `tool` → streamed tool output, `lifecycle` → compaction,
 * `extension-ui` → notices, `interaction` → the caller's permission/elicitation hook.
 */

import { isContextUIMessage, parseToolInput } from "@codent/core";

import { textBlock } from "./content.js";
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
 * The call's input: the parsed field when the engine has it, else the raw `arguments` JSON.
 *
 * While a call streams, only `arguments` exists — reading `input` alone is why a `grep`/`read_file`
 * row arrived with a bare "Search"/"Read" and no parameters, and with no `rawInput` either.
 */
const toolInputOf = (part: ToolCallPartLike): unknown => part.input ?? parseToolInput(part);

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
      const text = textOf(message);
      if (text) {
        this.options.emit({ sessionUpdate: "agent_message_chunk", messageId: message.id, content: textBlock(text) });
      }
      const thought = thoughtOf(message);
      if (thought) {
        this.options.emit({
          sessionUpdate: "agent_thought_chunk",
          messageId: `${message.id}-thought`,
          content: textBlock(thought),
        });
      }
      this.cursors.set(message.id, { text: text.length, thought: thought.length });
      for (const part of message.parts) {
        if (part.type !== "tool-call") continue;
        this.emitToolCall(part as ToolCallPartLike, true);
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
    if (this.emittedUserMessages.has(message.id)) return;
    const text = textOf(message);
    if (!text) return;
    this.emittedUserMessages.add(message.id);
    this.options.emit({
      sessionUpdate: "user_message_chunk",
      messageId: message.id,
      content: textBlock(text),
    });
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
      cursor.thought = 0;
      cursor.thought = thought.length;
      if (thought) {
        this.options.emit({
          sessionUpdate: "agent_thought_chunk",
          messageId: `${message.id}-thought-${Date.now()}`,
          content: textBlock(thought),
        });
      }
      this.cursors.set(message.id, cursor);
      return;
    }
    if (thought.length > cursor.thought) {
      this.options.emit({
        sessionUpdate: "agent_thought_chunk",
        messageId: `${message.id}-thought`,
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
        const content = this.toolContentFor(state, terminal);
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
    const text = toolResultText(part.content) || (part.error ?? "");
    const resultState = this.tools.get(part.toolCallId);
    this.options.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: part.toolCallId,
      ...(resultState
        ? { title: toolTitleOf(resultState.name, resultState.input), kind: toolKindFor(resultState.name) }
        : {}),
      status,
      ...(resultState && this.toolContentFor(resultState, true, text)
        ? { content: this.toolContentFor(resultState, true, text) }
        : text
          ? { content: [{ type: "content", content: textBlock(text) }] as ToolCallContent[] }
          : {}),
      ...(part.content !== undefined ? { rawOutput: part.content } : {}),
    });
  }

  /**
   * The content a tool row shows: the edit preview (a `diff`) and the result text, TOGETHER.
   *
   * Both halves describe the same call, and ACP's `content` on an update replaces what the client
   * holds — so a writer that sends only its own half erases the other's, and what the user ends up
   * seeing depends on which writer ran last. One builder, used by both writers, is what makes the row
   * order-independent.
   */
  private toolContentFor(state: ToolState, terminal: boolean, text?: string): ToolCallContent[] | undefined {
    if (!terminal) return undefined;
    const content: ToolCallContent[] = [];
    const diff = toolDiffFor(state.name, state.input, this.options.rootPath);
    if (diff) content.push(diff);
    const body = text?.trim() ? text : state.streamBuffer;
    if (body) content.push({ type: "content", content: textBlock(body) });
    return content.length > 0 ? content : undefined;
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
    const availableCommands: Array<{ name: string; description: string }> = [];
    for (const cmd of [...builtin, ...extension]) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      availableCommands.push({ name: cmd.name, description: cmd.description });
    }
    this.options.emit({ sessionUpdate: "available_commands_update", availableCommands });
  }

  /** Compaction completion → `compaction_update` (gated by the client capability). */
  private onLifecycle(event: { type: string; error?: unknown }): void {
    if (!this.options.client.compaction) return;
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
    if (!this.options.client.compaction) return;
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
    if (!this.options.client.compaction) return;
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
      this.options.emit({
        sessionUpdate: "compaction_summary_chunk",
        compactionId: active.id,
        content: textBlock(event.chunk),
      });
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

  private emitCompactionUpdate(
    status: "in_progress" | "completed" | "failed" | "cancelled",
    extra?: { summary?: ContentBlock[]; error?: string }
  ): void {
    if (!this.options.client.compaction || !this.compaction) return;
    this.options.emit({
      sessionUpdate: "compaction_update",
      compactionId: this.compaction.id,
      status,
      ...extra,
    });
  }

  /**
   * Close the open compaction: the summary stream's `end`, a lifecycle fault, or leaving `compacting`.
   * The accumulated summary is patched in once, at the end — the chunks already streamed it, and
   * `summary` has replace semantics, so sending it again is what makes the row readable for a client
   * that dropped the chunks.
   */
  private finishCompaction(status: "completed" | "failed" | "cancelled", error?: string): void {
    if (!this.compaction) {
      // A completion with no row of ours (its summary stream was never seen) still has to tell the
      // client what happened — one update, which is also what creates the row on the client's side.
      this.options.emit({
        sessionUpdate: "compaction_update",
        compactionId: this.nextCompactionId(),
        status,
        ...(error ? { error } : {}),
      });
      return;
    }
    const summary = this.compaction.summary.trim();
    this.emitCompactionUpdate(status, {
      ...(status === "completed" && summary ? { summary: [textBlock(summary)] } : {}),
      ...(error ? { error } : {}),
    });
    this.compaction = undefined;
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
