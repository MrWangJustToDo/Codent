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

import { isContextUIMessage } from "@codent/core";

import { textBlock } from "./content.js";
import { toolCallInfo, toolDiffFor, toolResultText, toolStatusFor } from "./tools.js";

import type {
  AcpCommands,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallStatus,
  ToolCallPartLike,
  ToolResultPartLike,
} from "./types.js";
import type { AgentSession, AgentSessionEvent, AgentSessionSnapshot } from "@codent/core";
import type { UIMessage } from "@tanstack/ai";

const STREAM_FLUSH_MS = 300;

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
        this.emitTitle(event.payload.name);
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
      // Report the user turn too: the stream has to carry the turn boundary, or nothing separates two
      // consecutive assistant replies and a client can only render them as one run of text (which is
      // how a live conversation followed by a `session/load` came out merged and out of order).
      if (message.role === "user") this.emitUserMessage(message);
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
   * Report one user turn, once.
   *
   * Shared by the live path and {@link replayFrom} on purpose: they are the two halves of one
   * question ("what has this client been told about the conversation?"), and a `user_message_chunk`
   * sent twice is a duplicated turn in the client's transcript. Injected context rows are skipped
   * here for the same reason they are skipped on replay — they are not conversation.
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
      state.input = part.input ?? state.input;
      const next = toolStatusFor(String(part.state), part.output?.success === false);
      if (next !== state.status) {
        state.status = next;
        const terminal = next === "completed" || next === "failed";
        const content = this.toolContentFor(state, terminal);
        if (terminal) state.streamBuffer = "";
        this.options.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: next,
          ...(content ? { content } : {}),
          ...(terminal && part.output !== undefined ? { rawOutput: part.output } : {}),
        });
      }
    }
  }

  private createToolCall(part: ToolCallPartLike, replay: boolean): void {
    const status: ToolCallStatus = replay ? "completed" : "pending";
    this.tools.set(part.id, {
      status,
      name: part.name,
      input: part.input,
      streamBuffer: "",
      lastStreamFlush: 0,
      resultEmitted: replay,
    });
    const display = (part as { display?: { summary?: string; text?: string } }).display;
    // The SAME description an approval prompt gets (`toolCallInfo`): a `run_command` whose command the
    // transcript shows but an approval cannot is exactly the divergence that sharing it prevents.
    this.options.emit({
      sessionUpdate: "tool_call",
      toolCallId: part.id,
      name: part.name,
      status,
      ...toolCallInfo(part.name, part.input, this.options.rootPath, display?.text),
    });
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
    this.options.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: part.toolCallId,
      status,
      ...(text ? { content: [{ type: "content", content: textBlock(text) }] as ToolCallContent[] } : {}),
      ...(part.content !== undefined ? { rawOutput: part.content } : {}),
    });
  }

  private toolContentFor(state: ToolState, terminal: boolean): ToolCallContent[] | undefined {
    if (!terminal) return undefined;
    const diff = toolDiffFor(state.name, state.input, this.options.rootPath);
    if (diff) return [diff];
    if (state.streamBuffer) return [{ type: "content", content: textBlock(state.streamBuffer) }];
    return undefined;
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
  private onLifecycle(event: { type: string }): void {
    if (!this.options.client.compaction) return;
    const type = event.type;
    if (type === "compaction:auto-complete" || type === "compaction:reactive-complete") {
      this.options.emit({ sessionUpdate: "compaction_update", compactionId: "compact", status: "completed" });
    } else if (type === "compaction:auto-error" || type === "compaction:reactive-error") {
      this.options.emit({ sessionUpdate: "compaction_update", compactionId: "compact", status: "failed" });
    }
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
