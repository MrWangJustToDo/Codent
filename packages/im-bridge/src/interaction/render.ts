/**
 * Reply rendering — projects the current run of UIMessage[] onto bridge
 * primitives.
 *
 * A "run" is everything after the last user message: one dispatch typically
 * spans SEVERAL assistant messages (one per LLM round), so rendering only the
 * last message would drop earlier rounds' text/tool lines mid-stream.
 *
 * Scanning conditions mirror the app layer (packages/app/src/utils/tool-part.ts
 * getUiToolState + use-agent-chat's pending interaction scan):
 * - pending ask_user: `part.name === "ask_user" && part.state === "input-complete" && part.output === undefined`
 * - pending approval: `part.approval.needsApproval && part.approval.approved === undefined`
 *
 * Tool lines follow a status-first convention: `<state> tool · key input info`
 * (e.g. `✅ run_command · $ pnpm build`) — the state glyph leads so consecutive
 * lines scan as a status list instead of looking like file attachments (the old
 * leading 📎 read as an attachment in Telegram).
 *
 * `edit_file` / `write_file` rows additionally carry a fenced preview of the
 * pending / applied content (see {@link formatToolPreview}): both tools require
 * approval, so the reviewer must see WHAT is edited or written — not just which
 * file — before tapping Approve. It is the one deliberate exception to the
 * one-line status list.
 */

import { BUILTIN_TOOL_NAMES } from "@codent/core";

import type { PendingInteraction } from "../types.js";
import type { ToolCallPart, UIMessage } from "@tanstack/ai";

const ASK_USER_TOOL = BUILTIN_TOOL_NAMES.askUser;
const INPUT_SUMMARY_LIMIT = 80;
const ERROR_EXCERPT_LIMIT = 200;

export interface RenderedReply {
  /** Assistant text plus collapsed tool status lines, current run only. */
  text: string;
  /** Interactions awaiting a user answer, in message order. */
  pending: PendingInteraction[];
}

/** One ordered outbound unit of a run: a text part or a tool status line. */
export interface RunSegment {
  /** Stable identity: tool parts key by `tool:<partId>`, text by `${message.id}:${partIndex}`. */
  key: string;
  kind: "text" | "tool";
  /** Rendered text (raw text content / tool status line). */
  text: string;
  /** Tool segment only: no further state change expected (output landed / denied). */
  done: boolean;
  /** Tool segment only: awaiting approval or an ask_user answer. */
  pending: boolean;
}

function isToolCallPart(part: UIMessage["parts"][number]): part is ToolCallPart {
  return part.type === "tool-call";
}

/**
 * Synthetic `<ctx kind=…>` injection messages (core synthetic-injection.ts: `ctx-<kind>-<hash>` ids)
 * land in the transcript as `role:"user"` — including MID-RUN (e.g. a refreshed
 * `git_status` between two assistant rounds). They are not turn boundaries.
 */
export function isSyntheticContextMessage(message: UIMessage): boolean {
  return message.role === "user" && /^ctx-[^-]+-/.test(message.id);
}

/** Messages of the current run: everything after the last REAL user message. */
export function currentRunMessages(messages: UIMessage[]): UIMessage[] {
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && !isSyntheticContextMessage(messages[i])) {
      lastUserIndex = i;
      break;
    }
  }
  return messages.slice(lastUserIndex + 1).filter((message) => message.role === "assistant");
}

function parseInputJson(part: ToolCallPart): Record<string, unknown> | undefined {
  if (part.input !== undefined) {
    return typeof part.input === "object" && part.input !== null ? (part.input as Record<string, unknown>) : undefined;
  }
  if (!part.arguments) return undefined;
  try {
    const parsed = JSON.parse(part.arguments) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function truncate(text: string, limit: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

// ---------------------------------------------------------------------------
// Per-tool input summary (port of packages/app tool-input-format, no chalk)
// ---------------------------------------------------------------------------

function formatFilePathInput(input: Record<string, unknown>, toolName?: string): string {
  const path = input.path as string | undefined;
  if (!path) return "";
  if (toolName === BUILTIN_TOOL_NAMES.readFile && (input.offset !== undefined || input.limit !== undefined)) {
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    if (offset !== undefined && limit !== undefined) return `${path} lines ${offset}-${offset + limit - 1}`;
    if (offset !== undefined) return `${path} from line ${offset}`;
    if (limit !== undefined) return `${path} first ${limit} lines`;
  }
  return path;
}

function formatRunCommandInput(input: Record<string, unknown>): string {
  const command = input.command as string | undefined;
  if (!command) return "";
  const short = command.length > 56 ? `${command.slice(0, 55)}…` : command;
  const suffix = input.run_in_background === true ? " (background)" : "";
  return `$ ${short}${suffix}`;
}

function formatGrepInput(input: Record<string, unknown>): string {
  const pattern = input.pattern as string | undefined;
  if (!pattern) return "";
  const parts = [JSON.stringify(pattern)];
  if (typeof input.path === "string" && input.path) parts.push(`in ${input.path}`);
  if (typeof input.include === "string" && input.include) parts.push(`--include=${input.include}`);
  return parts.join(" ");
}

function formatGenericInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return truncate(input, 50);
  if (typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  const formatted = entries
    .slice(0, 2)
    .map(([key, value]) => {
      const strValue = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}=${truncate(strValue, 30)}`;
    })
    .join(", ");
  return entries.length > 2 ? `(${formatted}, ...)` : `(${formatted})`;
}

/** Key information of a tool call's input, keyed by tool name. */
export function formatInputSummary(toolName: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  switch (toolName) {
    case BUILTIN_TOOL_NAMES.readFile:
    case BUILTIN_TOOL_NAMES.listFile:
    case BUILTIN_TOOL_NAMES.writeFile:
    case BUILTIN_TOOL_NAMES.editFile:
    case BUILTIN_TOOL_NAMES.deleteFile:
      return formatFilePathInput(input, toolName);
    case BUILTIN_TOOL_NAMES.runCommand:
      return formatRunCommandInput(input);
    case BUILTIN_TOOL_NAMES.grep:
      return formatGrepInput(input);
    case BUILTIN_TOOL_NAMES.glob: {
      const pattern = input.pattern as string | undefined;
      if (!pattern) return "";
      const parts = [JSON.stringify(pattern)];
      if (typeof input.path === "string" && input.path) parts.push(`in ${input.path}`);
      return parts.join(" ");
    }
    case BUILTIN_TOOL_NAMES.task: {
      const description = input.description as string | undefined;
      const prompt = input.prompt as string | undefined;
      if (description) return truncate(description, 60);
      if (prompt) return truncate(prompt, 60);
      return "";
    }
    case BUILTIN_TOOL_NAMES.todo:
      return (input.title as string | undefined) ?? "";
    case BUILTIN_TOOL_NAMES.websearch:
      return (input.query as string | undefined) ?? "";
    case BUILTIN_TOOL_NAMES.webfetch:
      return (input.url as string | undefined) ?? "";
    case BUILTIN_TOOL_NAMES.tree:
      return (input.path as string | undefined) ?? ".";
    case BUILTIN_TOOL_NAMES.loadSkill:
      return (input.name as string | undefined) ?? "";
    case BUILTIN_TOOL_NAMES.askUser:
      return (input.question as string | undefined) ?? "";
    case BUILTIN_TOOL_NAMES.createPlan:
    case BUILTIN_TOOL_NAMES.updatePlan: {
      const goal = typeof input.goal === "string" ? input.goal : "";
      return goal ? truncate(goal, 60) : "";
    }
    case BUILTIN_TOOL_NAMES.listSkills:
      return "";
    default:
      return formatGenericInput(input);
  }
}

/** `run_command · $ pnpm build` — tool name plus its key input info. */
function toolLabel(part: ToolCallPart): string {
  const summary = truncate(formatInputSummary(part.name, parseInputJson(part)), INPUT_SUMMARY_LIMIT);
  return summary ? `${part.name} · ${summary}` : part.name;
}

// ---------------------------------------------------------------------------
// edit_file / write_file content previews
// ---------------------------------------------------------------------------

/** Caps on an inline preview: shown edits / lines per side / total chars / per-line chars. */
const PREVIEW_MAX_EDITS = 2;
const PREVIEW_MAX_LINES_PER_SIDE = 4;
/** A write preview shows the new content only (one side), so it can afford more lines. */
const WRITE_PREVIEW_MAX_LINES = 6;
const PREVIEW_MAX_CHARS = 400;
const PREVIEW_MAX_LINE_CHARS = 120;

/** `- old` / `+ new` lines for one side of a change (an empty string contributes nothing). */
function prefixedLines(prefix: "-" | "+", value: string): string[] {
  if (value.length === 0) return [];
  return value.split("\n").map((line) => {
    const clipped = line.length > PREVIEW_MAX_LINE_CHARS ? `${line.slice(0, PREVIEW_MAX_LINE_CHARS - 1)}…` : line;
    return `${prefix} ${clipped}`;
  });
}

/**
 * Assemble a fenced preview block for a tool row, plus a
 * `… N more lines, N more edits` tail covering everything the caps dropped.
 *
 * The char budget is enforced HERE (dropping trailing lines into the omitted
 * count) rather than at the call sites, so a truncation notice can never push the
 * block past its cap. `lines` is consumed; returns "" when nothing is left.
 */
function fencedPreview(lines: string[], omittedLines: number, omittedEdits: number): string {
  if (lines.length === 0) return "";
  let dropped = omittedLines;
  const marker = (): string => {
    const parts = [
      dropped > 0 ? `${dropped} more line${dropped === 1 ? "" : "s"}` : "",
      omittedEdits > 0 ? `${omittedEdits} more edit${omittedEdits === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    return parts.length > 0 ? `… ${parts.join(", ")}` : "";
  };
  while (lines.length > 1 && lines.join("\n").length + marker().length > PREVIEW_MAX_CHARS) {
    lines.pop();
    dropped += 1;
  }
  const tail = marker();
  return `\n\n\`\`\`diff\n${lines.join("\n")}${tail ? `\n${tail}` : ""}\n\`\`\``;
}

/**
 * Fenced diff preview of an `edit_file` call — one `- old` / `+ new` block per
 * (capped) edit in the tool input. Rendered from the INPUT, deliberately not
 * from `output.oldFile` / `output.newFile`: those are whole files, and the
 * preview must already exist while the call is still awaiting approval.
 */
function formatEditDiff(part: ToolCallPart): string {
  if (part.name !== BUILTIN_TOOL_NAMES.editFile) return "";
  const edits = parseInputJson(part)?.edits;
  if (!Array.isArray(edits) || edits.length === 0) return "";

  const lines: string[] = [];
  let shown = 0;
  let omittedEdits = 0;
  let omittedLines = 0;
  for (const raw of edits) {
    if (shown >= PREVIEW_MAX_EDITS) {
      omittedEdits += 1;
      continue;
    }
    const edit = (raw ?? {}) as { oldString?: unknown; newString?: unknown };
    const minus = prefixedLines("-", typeof edit.oldString === "string" ? edit.oldString : "");
    const plus = prefixedLines("+", typeof edit.newString === "string" ? edit.newString : "");
    if (minus.length === 0 && plus.length === 0) {
      omittedEdits += 1;
      continue;
    }
    omittedLines += Math.max(0, minus.length - PREVIEW_MAX_LINES_PER_SIDE);
    omittedLines += Math.max(0, plus.length - PREVIEW_MAX_LINES_PER_SIDE);
    lines.push(...minus.slice(0, PREVIEW_MAX_LINES_PER_SIDE), ...plus.slice(0, PREVIEW_MAX_LINES_PER_SIDE));
    shown += 1;
  }
  return fencedPreview(lines, omittedLines, omittedEdits);
}

/**
 * Fenced preview of a `write_file` call — the new content as `+` lines.
 *
 * write_file always replaces the WHOLE file and its input carries only the new
 * content (no previous content), so this is an addition preview, not a diff: an
 * overwrite shows what the file becomes, never what it was. Only the leading
 * lines are shown (IM is a status feed, not a code reviewer), the rest rides the
 * tail marker.
 */
function formatWritePreview(part: ToolCallPart): string {
  if (part.name !== BUILTIN_TOOL_NAMES.writeFile) return "";
  const content = parseInputJson(part)?.content;
  if (typeof content !== "string" || content.trim().length === 0) return "";
  const lines = prefixedLines("+", content.endsWith("\n") ? content.slice(0, -1) : content);
  return fencedPreview(lines.slice(0, WRITE_PREVIEW_MAX_LINES), lines.length - WRITE_PREVIEW_MAX_LINES, 0);
}

/**
 * Content preview for the file-mutating tools whose effect the reviewer must see
 * (`edit_file`, `write_file`) — "" for every other tool and for calls whose args
 * are still streaming (nothing parsable yet).
 */
function formatToolPreview(part: ToolCallPart): string {
  return formatEditDiff(part) || formatWritePreview(part);
}

function isFailedOutput(part: ToolCallPart): boolean {
  return (
    typeof part.output === "object" && part.output !== null && (part.output as { success?: boolean }).success === false
  );
}

/** Single-line error excerpt from a failed tool output. */
function errorExcerpt(part: ToolCallPart): string {
  if (typeof part.output !== "object" || part.output === null) return "";
  const output = part.output as { error?: unknown; stderr?: unknown; stdout?: unknown };
  const raw = [output.error, output.stderr, output.stdout].find((value) => typeof value === "string" && value);
  return raw ? truncate(raw as string, ERROR_EXCERPT_LIMIT) : "";
}

/** Optional result hint (e.g. grep match count) appended after `✅`. */
function resultHint(part: ToolCallPart): string {
  if (part.name === BUILTIN_TOOL_NAMES.grep && typeof part.output === "object" && part.output !== null) {
    const matches = (part.output as { matches?: unknown }).matches;
    // Only when non-empty: oversized outputs may spill matches to a cache file
    // (empty array would be misleading).
    if (Array.isArray(matches) && matches.length > 0) return ` (${matches.length} matches)`;
  }
  return "";
}

/**
 * Status emoji — one emoji vocabulary for every tool row state, so the rows read
 * the same on every Telegram client. `\uFE0F` (VARIATION SELECTOR-16) is the
 * explicit EMOJI presentation for `⏸`/`▶` (without it clients fall back to the
 * small text glyph). Running is `▶️` rather than `⏳` because `⏳` is the reply
 * placeholder the first row claims.
 */
const GLYPH_DONE = "✅";
const GLYPH_FAILED = "❌";
const GLYPH_AWAITING = "\u23F8\uFE0F";
const GLYPH_RUNNING = "\u25B6\uFE0F";

/** Compact status line for a tool call (`✅ run_command · $ pnpm build`). */
export function toolStatusLine(part: ToolCallPart): string {
  const label = toolLabel(part);
  // A failed/denied edit or write mutates NOTHING on disk — a preview of the
  // never-applied content would read as if it had landed, drowning out the error.
  if (part.approval?.approved === false) return `${GLYPH_FAILED} ${label} · denied`;
  if (part.output !== undefined) {
    if (part.state === "error" || isFailedOutput(part)) {
      const excerpt = errorExcerpt(part);
      return `${GLYPH_FAILED} ${label}${excerpt ? ` · ${excerpt}` : ""}`;
    }
    return `${GLYPH_DONE} ${label}${resultHint(part)}${formatToolPreview(part)}`;
  }
  if (part.approval?.needsApproval && part.approval.approved === undefined) {
    return `${GLYPH_AWAITING} ${label} · awaiting approval${formatToolPreview(part)}`;
  }
  // ask_user without options has no buttons — the only answer channel is a
  // plain reply, so say so on the row instead of a bare "running".
  if (part.name === ASK_USER_TOOL && askUserOptionCount(part) === 0) {
    return `${GLYPH_RUNNING} ${label} · reply with text`;
  }
  return `${GLYPH_RUNNING} ${label}${formatToolPreview(part)}`;
}

function askUserOptionCount(part: ToolCallPart): number {
  const options = parseInputJson(part)?.options;
  return Array.isArray(options) ? options.length : 0;
}

/** Scan run messages for interactions that need a user answer. */
export function scanPendingInteractions(messages: UIMessage[]): PendingInteraction[] {
  const pending: PendingInteraction[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const [partIndex, part] of message.parts.entries()) {
      if (!isToolCallPart(part)) continue;
      const segmentKey = toolSegmentKey(message.id, partIndex, part.id);
      if (part.name === ASK_USER_TOOL && part.state === "input-complete" && part.output === undefined) {
        const input = parseInputJson(part) ?? {};
        pending.push({
          kind: BUILTIN_TOOL_NAMES.askUser,
          toolCallId: part.id,
          question: typeof input.question === "string" ? input.question : "(no question)",
          options: Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === "string") : [],
          multiSelect: input.multiSelect === true,
          segmentKey,
        });
        continue;
      }
      if (part.approval?.needsApproval && part.approval.approved === undefined) {
        pending.push({
          kind: "approval",
          approvalId: part.approval.id,
          toolName: part.name,
          question: toolLabel(part),
          segmentKey,
        });
      }
    }
  }
  return pending;
}

/**
 * Stable identity for a tool-call segment. The local pipeline rebuilds message
 * ids (and splits parallel tool calls across messages) as rounds continue after
 * an approval, so `messageId:partIndex` keying orphanes posted tool rows. The
 * tool-call id (`call_*`/`approval_call_*`) is stable across those rebuilds, so
 * keying by it keeps a row's segment, registration, and follow-up updates on the
 * same object. Text parts have no stable id and are already terminal once
 * posted, so they keep the message-scoped key.
 */
export function toolSegmentKey(messageId: string, partIndex: number, partId: string | undefined): string {
  return partId ? `tool:${partId}` : `${messageId}:${partIndex}`;
}

/**
 * Project the current run onto ordered outbound segments — assistant text and
 * tool status lines alternate exactly as the app's message view renders them.
 * RunRenderer collapses consecutive tool segments into one message; text
 * segments always stay their own message.
 */
export function renderRunSegments(messages: UIMessage[]): RunSegment[] {
  const segments: RunSegment[] = [];
  for (const message of currentRunMessages(messages)) {
    for (const [partIndex, part] of message.parts.entries()) {
      if (part.type === "text") {
        if (part.content.trim().length === 0) continue;
        segments.push({
          key: `${message.id}:${partIndex}`,
          kind: "text",
          text: part.content,
          done: false,
          pending: false,
        });
      } else if (isToolCallPart(part)) {
        // Only post an ask_user row once its args are complete — a mid-stream
        // part (args still arriving) would otherwise render as a bare
        // `▶️ ask_user` with no question and no buttons.
        const pending =
          (part.name === ASK_USER_TOOL && part.state === "input-complete" && part.output === undefined) ||
          (part.approval?.needsApproval === true && part.approval.approved === undefined);
        segments.push({
          key: toolSegmentKey(message.id, partIndex, part.id),
          kind: "tool",
          text: toolStatusLine(part),
          done: part.output !== undefined || part.approval?.approved === false,
          pending,
        });
      }
    }
  }
  return segments;
}

/** Render the current run: assistant texts + tool status lines + pending interactions. */
export function renderReply(messages: UIMessage[]): RenderedReply {
  return {
    text: renderRunSegments(messages)
      .map((segment) => segment.text)
      .join("\n\n")
      .trim(),
    pending: scanPendingInteractions(currentRunMessages(messages)),
  };
}

/** Tool status lines only — the live progress row when answer streaming is off. */
export function renderRunToolLines(messages: UIMessage[]): string {
  const lines: string[] = [];
  for (const message of currentRunMessages(messages)) {
    for (const part of message.parts) {
      if (isToolCallPart(part)) lines.push(toolStatusLine(part));
    }
  }
  return lines.join("\n\n");
}

/** Assistant answer text only — the final reply when answer streaming is off. */
export function renderRunAnswer(messages: UIMessage[]): string {
  const parts: string[] = [];
  for (const message of currentRunMessages(messages)) {
    for (const part of message.parts) {
      if (part.type === "text" && part.content.trim().length > 0) parts.push(part.content);
    }
  }
  return parts.join("\n\n").trim();
}

/** Render the final state of a just-answered interaction (button row cleanup). */
export function renderResolved(question: string, outcome: string): string {
  return `${question}\n\n→ ${outcome}`;
}
