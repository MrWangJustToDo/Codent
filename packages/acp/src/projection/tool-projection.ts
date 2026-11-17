/**
 * Tool-row projection: one ACP row per tool call (`tool_call` on first sight, `tool_call_update` on
 * transition), its streamed output, and the parent-facing `task` report.
 *
 * The state here is the ROW, not the tool: what the client was already told about one call. Three
 * rules follow from ACP v1 and decide most of this file:
 *
 * - **`content` REPLACES what the client holds.** Both writers (the status transition and the result
 *   part) run in the engine's order, not ours, so the row is always rebuilt as a whole
 *   (`toolContentFor`) rather than patched by whichever writer ran last.
 * - **there is no `cancelled` / `interrupted` status**, so both travel in `_meta` and every later
 *   content update must repeat them or the client loses the distinction.
 * - **a terminal row is final.** The channel re-delivers old parts while a later step streams;
 *   letting that move `completed` back to `in_progress` made a finished tool look stuck.
 */

import {
  BUILTIN_TOOL_NAMES,
  formatToolOutput,
  interruptedToolMessage,
  isCancelledToolCall,
  isInterruptedToolOutput,
  parseToolInput,
} from "@codent/core";

import { textBlock } from "../wire/content.js";
import { toWirePath } from "../wire/paths.js";

import { imagesOfResult } from "./media.js";
import { taskOutputOf } from "./message-text.js";
import { toolCallInfo, toolDiffsFor, toolKindFor, toolResultText, toolStatusFor, toolTitleOf } from "./tools.js";

import type { ToolLookup } from "./tools.js";
import type {
  ContentBlock,
  SessionUpdate,
  ToolCallContent,
  ToolCallPartLike,
  ToolCallStatus,
  ToolResultPartLike,
} from "../wire/types.js";
import type { AgentSessionEvent, AgentStreamEvent } from "@codent/core";

/**
 * A one-line result summary from the tool's own formatter, used only when the result carries no
 * extractable text (otherwise the client would get `rawOutput` JSON).
 *
 * `formatToolOutput` is the same call the app makes for a local row. It returns "" for a tool with
 * no renderer (extension tools, plan bodies), which leaves the raw-JSON fallback in place for those.
 */
function formattedResultText(name: string | undefined, output: unknown): string {
  if (!name || output === undefined) return "";
  try {
    return formatToolOutput(output, name);
  } catch {
    return "";
  }
}

/** Tool output is forwarded at most this often; a chunk stream is a log, not a frame per line. */
const STREAM_FLUSH_MS = 300;

/** Everything one client row needs to know about the call it describes. */
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
  /** Terminal status came from a user cancellation — content updates must carry `_meta.cancelled`. */
  cancelled?: boolean;
  /** The call never ran (truncated / interrupted) — content updates must carry `_meta.interrupted`. */
  interrupted?: boolean;
  /** The notice the marker carried, so the result row can render it instead of the marker JSON. */
  interruptedText?: string;
}

/**
 * ACP v1 has no `cancelled` / `interrupted` status. Both travel in `_meta` beside the terminal
 * status, and every later content update must repeat them or the client loses the distinction.
 */
function toolMeta(markers: { cancelled?: boolean; interrupted?: boolean }): {
  _meta?: { cancelled?: boolean; interrupted?: boolean };
} {
  const meta = {
    ...(markers.cancelled ? { cancelled: true } : {}),
    ...(markers.interrupted ? { interrupted: true } : {}),
  };
  return Object.keys(meta).length > 0 ? { _meta: meta } : {};
}

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

export interface ToolProjectionDeps {
  publish: (update: SessionUpdate) => void;
  /** This session's workspace root, for the wire paths a location/diff carries. */
  rootPath: string;
  /** Read a workspace file for `write_file`'s real `oldText`. `null` means "not readable / new". */
  readFile?: (absolutePath: string) => Promise<string | null>;
  /** The live tool lookup (the session's presentation, not the static built-in table). */
  lookup: () => ToolLookup;
}

export class ToolProjection {
  private readonly tools = new Map<string, ToolState>();
  /** Live task-summary streams keyed by `task:<toolCallId>` — the parent-facing task report. */
  private readonly taskStreams = new Map<string, { toolCallId: string; buffer: string; lastFlush: number }>();
  /** Bumped by {@link stop}; a late async write (oldText read) must not publish after a stop. */
  private generation = 0;

  constructor(private readonly deps: ToolProjectionDeps) {}

  /** A stop / fork detaches this projector: an in-flight `oldText` read must not publish any more. */
  stop(): void {
    this.generation += 1;
  }

  /** Forget live task streams (a NEW parent conversation). */
  resetStreams(): void {
    this.taskStreams.clear();
  }

  /** `tool_call` on first sight, then `tool_call_update` on transition only. */
  emitCall(part: ToolCallPartLike, replay: boolean): void {
    const id = part.id;
    const state = this.tools.get(id);
    if (!state) this.createCall(part, replay);
    else {
      state.input = parseToolInput(part) ?? state.input;
      // The preview is a function of the INPUT, so it goes out as soon as the input is final — not when
      // the call reaches a terminal status. `content` on an update REPLACES what the client holds, and
      // the two writers (this transition, and the result part below) run in the engine's order, not
      // ours: a preview that waits for the end is erased by the result text, or never sent at all when
      // the result part moved the status first (`emitResult` sets it) and this branch became a
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
        const cancelledNow = next === "failed" && isCancelledToolCall(part as { output?: unknown });
        const interruptedNow = isInterruptedToolOutput(part.output);
        state.cancelled = cancelledNow;
        state.interrupted = interruptedNow;
        if (interruptedNow) state.interruptedText = interruptedToolMessage(part.output);
        const nowTerminal = next === "completed" || next === "failed";
        // `part.output` is the tool's own return value — where a `read_file` image actually lives, and
        // the door this transition used to walk past (it read `part.content`, which holds a string).
        // A `task` result is formatted for the reader (summary + status line) instead of being sent as
        // its raw object; that row is the parent's result of record.
        const taskOutput = state.name === BUILTIN_TOOL_NAMES.task ? taskOutputOf(part) : undefined;
        const taskText = taskOutput !== undefined ? formatToolOutput(taskOutput, BUILTIN_TOOL_NAMES.task) : undefined;
        const content = this.toolContentFor(
          state,
          nowTerminal,
          taskText ?? (interruptedNow ? interruptedToolMessage(part.output) : undefined),
          [],
          part.output
        );
        if (nowTerminal) {
          state.streamBuffer = "";
          // Only a `task` row treats an output-bearing tool-call part as the result of record — for
          // every other tool the `tool-result` part still owes the client the real result, so
          // `resultEmitted` must stay its flag. (A late task-summary chunk must not replace this.)
          if (taskText !== undefined) state.resultEmitted = true;
        }
        this.deps.publish({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          // The label travels again on every update: a client that replaces its row from the update
          // would otherwise show a blank one (see `toolTitleOf`).
          title: toolTitleOf(state.name, state.input),
          kind: toolKindFor(state.name, this.deps.lookup()),
          status: next,
          // The terminal non-success status stays `failed` (v1 has no `cancelled`), but the reason
          // travels in `_meta` — without it a cancelled/interrupted row is indistinguishable from a fault.
          ...toolMeta({ cancelled: cancelledNow, interrupted: interruptedNow }),
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

  /** `tool_call_update` with the call's result (text, images, or the formatted `task` report). */
  emitResult(part: ToolResultPartLike): void {
    const state = this.tools.get(part.toolCallId);
    if (state?.resultEmitted) return;
    const resultStatus = this.resultStatusOf(part);
    // A denied call is already `failed`. Its synthetic denial result part is `state: "complete"`
    // with no `success: false`, so classifying the result alone would upgrade the row to
    // `completed` and tell the client the denied tool actually ran.
    const status: ToolCallStatus = state?.status === "failed" && resultStatus === "completed" ? "failed" : resultStatus;
    const cancelledResult = isCancelledToolCall(part as { output?: unknown });
    const interruptedResult = isInterruptedToolOutput(part.output) || state?.interrupted === true;
    if (state) {
      state.status = status;
      // A cancel marker may exist only on the result part (the call part was still running when the
      // row was terminal); keep it so later content-only updates still carry `_meta.cancelled`.
      state.cancelled = state.cancelled === true || cancelledResult;
      state.interrupted = state.interrupted === true || interruptedResult;
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
    // contributes none. The extractor is FIRST because it carries the whole result; a tool's
    // formatter is a summary (`Read src/a.ts (lines 1-42 of 42)`, `3 matches: …`), so using it first
    // would delete the body a client has no other way to see.
    const taskOutput = state?.name === BUILTIN_TOOL_NAMES.task ? taskOutputOf(part) : undefined;
    const taskText = taskOutput !== undefined ? formatToolOutput(taskOutput, BUILTIN_TOOL_NAMES.task) : undefined;
    // An interruption marker is a shared shape, not a tool result: its JSON is not a rendering.
    const text =
      taskText ??
      (interruptedResult
        ? (state?.interruptedText ?? interruptedToolMessage(part.output))
        : toolResultText(part.content, images.length > 0) ||
          // No extractable content: the tool's formatter beats the raw JSON that used to follow
          // (`rawOutput`), and a media result keeps the extractor's answer so an image is not also
          // printed as prose.
          (images.length === 0 ? formattedResultText(state?.name, part.output) : "") ||
          (part.error ?? ""));
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
    this.deps.publish({
      sessionUpdate: "tool_call_update",
      toolCallId: part.toolCallId,
      ...(resultState
        ? {
            title: toolTitleOf(resultState.name, resultState.input),
            kind: toolKindFor(resultState.name, this.deps.lookup()),
          }
        : {}),
      status,
      ...toolMeta({ cancelled: cancelledResult, interrupted: interruptedResult }),
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

  /** Prime a tool call from a snapshot without emitting it (`resume` / post-fork). */
  primeCall(part: ToolCallPartLike): void {
    if (this.tools.has(part.id)) return;
    // One helper for both shapes (see `@codent/core`'s `parseToolInput`): the parsed field exists
    // from the moment the engine has it, `arguments` from the first tick.
    const input = parseToolInput(part);
    const display = (part as { display?: { summary?: string; text?: string } }).display;
    const info = toolCallInfo(part.name, input, this.deps.rootPath, display?.text, this.deps.lookup());
    const cancelled = isCancelledToolCall(part as { output?: unknown });
    const interrupted = isInterruptedToolOutput(part.output);
    this.tools.set(part.id, {
      status: this.toolStatusOf(part),
      name: part.name,
      input,
      streamBuffer: "",
      lastStreamFlush: 0,
      resultEmitted: false,
      previewSent: (info.content ?? []).some((content) => content.type === "diff"),
      ...(cancelled ? { cancelled: true } : {}),
      ...(interrupted ? { interrupted: true, interruptedText: interruptedToolMessage(part.output) } : {}),
    });
  }

  /** Prime a tool result from a snapshot without emitting it. */
  primeResult(part: ToolResultPartLike): void {
    const state = this.tools.get(part.toolCallId);
    if (!state) return;
    state.status = this.resultStatusOf(part);
    state.cancelled = state.cancelled === true || isCancelledToolCall(part as { output?: unknown });
    state.resultEmitted = true;
    state.streamBuffer = "";
  }

  /** The `tool` channel: streamed stdout/stderr of one call, forwarded as row content. */
  emitStream(payload: Extract<AgentSessionEvent, { channel: "tool" }>["payload"]): void {
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
    this.deps.publish({
      sessionUpdate: "tool_call_update",
      toolCallId: chunk.toolCallId,
      title: toolTitleOf(state.name, state.input),
      kind: toolKindFor(state.name, this.deps.lookup()),
      status: state.status === "pending" ? "in_progress" : state.status,
      ...toolMeta({ cancelled: state.cancelled, interrupted: state.interrupted }),
      content: [{ type: "content", content: textBlock(state.streamBuffer) }],
    });
  }

  /**
   * The `summary` channel's TASK half: a task summary is the parent-facing result stream for one
   * task tool call, so it updates that row's content instead of opening a compaction row.
   *
   * Returns whether the event belonged to a task stream, so the caller can hand everything else
   * (the compact summarizer) to its own projection.
   */
  emitTaskSummary(event: AgentStreamEvent): boolean {
    if (event.type === "reset") {
      if (event.source !== "task" || !event.toolCallId) return false;
      this.taskStreams.set(event.key, { toolCallId: event.toolCallId, buffer: "", lastFlush: 0 });
      return true;
    }
    const task = this.taskStreams.get(event.key);
    if (!task) return false;
    if (event.type === "append") {
      task.buffer += event.chunk;
      const toolState = this.tools.get(task.toolCallId);
      // A chunk that arrives after the final result must be dropped — otherwise it would replace
      // the terminal content with a partial buffer.
      if (!toolState || toolState.resultEmitted) return true;
      const now = Date.now();
      if (now - task.lastFlush < STREAM_FLUSH_MS) return true;
      task.lastFlush = now;
      this.deps.publish({
        sessionUpdate: "tool_call_update",
        toolCallId: task.toolCallId,
        title: toolTitleOf(toolState.name, toolState.input),
        kind: toolKindFor(toolState.name, this.deps.lookup()),
        status: toolState.status === "pending" ? "in_progress" : toolState.status,
        ...toolMeta({ cancelled: toolState.cancelled, interrupted: toolState.interrupted }),
        // ACP tool `content` REPLACES what the client holds; there is no append form, so each
        // update re-sends the whole accumulated text.
        content: [{ type: "content", content: textBlock(task.buffer) }],
      });
      return true;
    }
    this.taskStreams.delete(event.key);
    return true;
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

  private createCall(part: ToolCallPartLike, replay: boolean): void {
    // The status comes from the PART's state, not from "was this a replay": a replayed call that never
    // finished (awaiting approval, cancelled, interrupted) was advertised as `completed`, and the next
    // live tick then downgraded it to `pending` — a terminal row the client had already frozen, so the
    // approval row could not be answered at all (reported as a stuck session with a "hidden" tool call).
    const status: ToolCallStatus = this.toolStatusOf(part);
    const cancelled = isCancelledToolCall(part as { output?: unknown });
    const interrupted = isInterruptedToolOutput(part.output);
    // One helper for both shapes (see `@codent/core`'s `parseToolInput`): the parsed field exists
    // from the moment the engine has it, `arguments` from the first tick.
    const input = parseToolInput(part);
    const display = (part as { display?: { summary?: string; text?: string } }).display;
    // The SAME description an approval prompt gets (`toolCallInfo`): a `run_command` whose command the
    // transcript shows but an approval cannot is exactly the divergence that sharing it prevents.
    const info = toolCallInfo(part.name, input, this.deps.rootPath, display?.text, this.deps.lookup());
    // A replayed task row carries its result on the CALL part (`output`); the persisted result part
    // has no `output`, only the raw JSON `content`. Format it here or `session/load` shows raw JSON
    // for every historical delegation — the one surface a client without `subagents` has.
    const taskOutput = part.name === BUILTIN_TOOL_NAMES.task ? taskOutputOf(part) : undefined;
    const taskText = taskOutput !== undefined ? formatToolOutput(taskOutput, BUILTIN_TOOL_NAMES.task) : undefined;
    this.tools.set(part.id, {
      status,
      name: part.name,
      // The best-known input (parsed field or raw `arguments`) rather than the strictest one:
      // everything downstream (title, preview) reads it.
      input,
      streamBuffer: "",
      lastStreamFlush: 0,
      // NOT `replay`: the replay still owes the client a tool RESULT part, and a `true` here was
      // what suppressed it (the retained `messages` delivery then skipped it too). A task CALL part
      // that already carries its output IS the result, so it is the exception.
      resultEmitted: taskText !== undefined,
      previewSent: (info.content ?? []).some((content) => content.type === "diff"),
      ...(cancelled ? { cancelled: true } : {}),
      ...(interrupted ? { interrupted: true, interruptedText: interruptedToolMessage(part.output) } : {}),
    });
    const replayText = taskText ?? (interrupted ? interruptedToolMessage(part.output) : undefined);
    const taskContent = replayText ? [{ type: "content" as const, content: textBlock(replayText) }] : [];
    const content = [...(info.content ?? []), ...taskContent];
    this.deps.publish({
      sessionUpdate: "tool_call",
      toolCallId: part.id,
      name: part.name,
      status,
      ...toolMeta({ cancelled, interrupted }),
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
    if (!state || state.oldTextRead || !this.deps.readFile) return;
    // While arguments stream, `input` is the raw partial JSON and has no path. Do NOT latch on that:
    // the next tick (input-complete) is the one that can actually read the file.
    const path = (state.input as { path?: unknown } | undefined)?.path;
    if (typeof path !== "string" || !path) return;
    state.oldTextRead = true;
    const generation = this.generation;
    let old: string | null;
    try {
      old = await this.deps.readFile(toWirePath(path, this.deps.rootPath));
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
      : toolDiffsFor(current.name, current.input, this.deps.rootPath, old);
    if (!content || content.length === 0) return;
    current.previewSent = true;
    this.deps.publish({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      title: toolTitleOf(current.name, current.input),
      kind: toolKindFor(current.name, this.deps.lookup()),
      status: current.status,
      ...toolMeta({ cancelled: current.cancelled, interrupted: current.interrupted }),
      content,
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
    for (const diff of toolDiffsFor(state.name, state.input, this.deps.rootPath, state.oldText)) {
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
    const diffs = toolDiffsFor(state.name, state.input, this.deps.rootPath, state.oldText);
    if (diffs.length === 0) return;
    state.previewSent = true;
    this.deps.publish({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      title: toolTitleOf(state.name, state.input),
      kind: toolKindFor(state.name, this.deps.lookup()),
      status: state.status,
      ...toolMeta({ cancelled: state.cancelled, interrupted: state.interrupted }),
      content: diffs,
    });
  }

  private resultStatusOf(part: ToolResultPartLike): ToolCallStatus {
    const output = part.output as { success?: boolean; ok?: boolean } | undefined;
    // A cancelled call that returned its own partial output (`run_command` with `cancelled: true`)
    // or a `task` whose subagent stopped (`aborted: true`) did not complete. Without this the
    // result writer upgraded both to `completed`.
    if (isCancelledToolCall(part as { output?: unknown })) return "failed";
    // `ok:false` is core's own failure marker for structured results (`create_plan`, `update_plan`);
    // the UI state treats it as an error too, so a rejected plan must not render green here.
    return part.state === "error" || part.outcome || part.error || output?.success === false || output?.ok === false
      ? "failed"
      : "completed";
  }
}
