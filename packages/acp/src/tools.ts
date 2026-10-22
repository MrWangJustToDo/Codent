/**
 * Tool-call projection helpers: ACP `ToolKind` mapping, human titles, file
 * `locations`, and structured `diff` derivation.
 *
 * ACP per-tool metadata is derived here from the tool's name + input (and, for
 * diffs, the replacement spans that are already in the input) — core is not
 * coupled to ACP, and we never fabricate a diff we cannot reconstruct.
 */

import { BUILTIN_TOOL_NAMES, formatToolInput, getBuiltinToolPresentation } from "@codent/core";

import { textBlock } from "./content.js";
import { toWirePath } from "./paths.js";

import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { ToolActivityCategory } from "@codent/core";

/** Core presentation category → ACP {@link ToolKind}. */
const CATEGORY_KIND: Record<ToolActivityCategory, ToolKind> = {
  reads: "read",
  edits: "edit",
  searches: "search",
  commands: "execute",
  tasks: "other",
  other: "other",
};

/**
 * The few tools whose ACP kind is not implied by their core presentation category
 * (`delete_file` folds as an edit, the web tools as searches). Keyed by core's exported
 * identifiers so a rename can never leave a stale key.
 */
const NAME_KIND_OVERRIDES: Record<string, ToolKind> = {
  [BUILTIN_TOOL_NAMES.deleteFile]: "delete",
  [BUILTIN_TOOL_NAMES.websearch]: "fetch",
  [BUILTIN_TOOL_NAMES.webfetch]: "fetch",
};

/** Map a tool name to an ACP {@link ToolKind}, from core's presentation catalog. */
export function toolKindFor(name: string): ToolKind {
  const category = getBuiltinToolPresentation(name)?.category ?? "other";
  return NAME_KIND_OVERRIDES[name] ?? CATEGORY_KIND[category];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Path-like fields a tool input may carry (single or list). */
const PATH_KEYS = ["path", "file", "filePath", "file_path", "target"] as const;
const PATH_LIST_KEYS = ["paths", "files"] as const;

/** Collect absolute file paths a tool call touches, for ACP `locations`. */
export function toolLocationsFor(input: unknown, rootPath: string): Array<{ path: string; line?: number }> {
  const rec = asRecord(input);
  if (!rec) return [];
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) found.push(value);
  }
  for (const key of PATH_LIST_KEYS) {
    const value = rec[key];
    if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === "string" && entry.trim()) found.push(entry);
    }
  }
  // ACP's `locations[].line` is what a client uses for "follow-along" (jump to the spot the agent is
  // working on). It is 1-based on the wire, and the two inputs that carry a position are 0-based:
  // `read_file`'s `offset` (a line index) and the LSP tools' `line`. Only the primary path gets it —
  // a multi-path input has no single position, and inventing one would point somewhere wrong.
  const line =
    typeof rec.offset === "number" || typeof rec.line === "number" ? Number(rec.offset ?? rec.line) + 1 : undefined;
  const paths = [...new Set(found)];
  return paths.map((p, index) => ({
    path: toWirePath(p, rootPath),
    ...(index === 0 && line !== undefined && Number.isFinite(line) ? { line } : {}),
  }));
}

/** Human-readable title for a tool call: `Verb <path>` when a path is known. */
export function toolTitleFor(name: string, input: unknown): string {
  const path = toolLocationsFor(input, "")[0]?.path; // rootPath "" keeps it as given for the title
  const verb = TITLE_VERBS[name] ?? name.replace(/_/g, " ");
  if (path) return `${verb} ${path}`;
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

const TITLE_VERBS: Record<string, string> = {
  [BUILTIN_TOOL_NAMES.readFile]: "Read",
  [BUILTIN_TOOL_NAMES.listFile]: "List",
  [BUILTIN_TOOL_NAMES.tree]: "Tree",
  [BUILTIN_TOOL_NAMES.editFile]: "Edit",
  [BUILTIN_TOOL_NAMES.writeFile]: "Write",
  [BUILTIN_TOOL_NAMES.deleteFile]: "Delete",
  [BUILTIN_TOOL_NAMES.grep]: "Search",
  [BUILTIN_TOOL_NAMES.glob]: "Find files",
  [BUILTIN_TOOL_NAMES.websearch]: "Web search",
  [BUILTIN_TOOL_NAMES.webfetch]: "Fetch",
  [BUILTIN_TOOL_NAMES.runCommand]: "Run",
  [BUILTIN_TOOL_NAMES.getCommandOutput]: "Read command output",
  [BUILTIN_TOOL_NAMES.killCommand]: "Kill command",
  [BUILTIN_TOOL_NAMES.executeTypescript]: "Execute TypeScript",
  [BUILTIN_TOOL_NAMES.task]: "Task",
  [BUILTIN_TOOL_NAMES.askUser]: "Ask user",
  [BUILTIN_TOOL_NAMES.todo]: "Todos",
};

/**
 * Build ACP structured-diff content for edit/write tools, from the replacement
 * spans already present in the input. Returns `undefined` (degrade to text) when
 * the operation cannot be reconstructed faithfully.
 */
export function toolDiffFor(name: string, input: unknown, rootPath: string): ToolCallContent | undefined {
  return toolDiffsFor(name, input, rootPath)[0];
}

/**
 * Every reconstructable replacement in one call.
 *
 * `edit_file` can carry several edits; ACP's `content` is a list, so each replacement becomes its
 * own diff entry (a single synthetic old/new pair hiding which replacements ran is not a faithful
 * preview). `replaceAll` is one replacement pair — the diff shows the text, and the tool's own
 * output reports how many occurrences changed.
 */
export function toolDiffsFor(name: string, input: unknown, rootPath: string, writeOldText?: string): ToolCallContent[] {
  const rec = asRecord(input);
  if (!rec) return [];
  const path = typeof rec.path === "string" ? rec.path : undefined;
  if (!path) return [];

  if (name === BUILTIN_TOOL_NAMES.writeFile && typeof rec.content === "string") {
    return [
      {
        type: "diff",
        path: toWirePath(path, rootPath),
        // A new file has no old text. On an overwrite the projector reads the real content and
        // passes it here, so the client shows the edit instead of "whole file added".
        oldText: writeOldText ?? null,
        newText: rec.content,
      },
    ];
  }

  if (name === BUILTIN_TOOL_NAMES.editFile) {
    const edits = Array.isArray(rec.edits) ? rec.edits : [rec];
    const diffs: ToolCallContent[] = [];
    for (const edit of edits) {
      const e = asRecord(edit);
      if (!e) continue;
      if (typeof e.oldString !== "string" || typeof e.newString !== "string") continue;
      diffs.push({
        type: "diff",
        path: toWirePath(path, rootPath),
        oldText: e.oldString,
        newText: e.newString,
      });
    }
    return diffs;
  }

  return [];
}

/** The command line a shell tool carries, when it carries one. */
function shellCommandOf(name: string, input: unknown): string | undefined {
  if (name !== BUILTIN_TOOL_NAMES.runCommand) return undefined;
  const command = asRecord(input)?.command;
  return typeof command === "string" && command.trim() ? command.trim() : undefined;
}

/**
 * The row's label: core's input formatter, else the verb+path form.
 *
 * ONE definition — {@link toolCallInfo} uses it for the first sight of a call, and every
 * `tool_call_update` carries it again: an update that only reports a status leaves a row blank in a
 * client that replaces its row from the update instead of merging fields (reported as "after
 * approving, the tool has no title").
 */
export function toolTitleOf(name: string, input: unknown): string {
  return formatToolInput(input, name, { compact: true }) || toolTitleFor(name, input);
}

/**
 * The client-facing description of one tool call: title, kind, locations, and the input/content that
 * make it answerable.
 *
 * Shared by the transcript (`tool_call` / `tool_call_update`) and by the permission request, because
 * the two must not diverge — and because an approval prompt that cannot show WHAT it is approving is
 * not a decision anyone can make.
 *
 * The TITLE comes from core's own input formatter ({@link formatToolInput}) — the same string the app
 * puts at the head of a tool row (`ToolCallPartView`), so a `grep` names its pattern, a `webfetch` its
 * url, a `run_command` its command. ACP used to compose the title itself from a verb plus a PATH, so
 * every tool whose key parameter is not a path lost it ("Run", "Search <path>", "Web search").
 *
 * The result text (`displayText`, i.e. core's `part.display.text`) goes in the CONTENT, never in the
 * title: the title names the call, which is what a client shows while the call is still pending.
 */
export function toolCallInfo(
  name: string,
  input: unknown,
  rootPath: string,
  displayText?: string
): {
  title: string;
  kind: ToolKind;
  locations: Array<{ path: string }>;
  rawInput?: unknown;
  content?: ToolCallContent[];
} {
  const diffs = toolDiffsFor(name, input, rootPath);
  const command = shellCommandOf(name, input);
  const content: ToolCallContent[] | undefined =
    diffs.length > 0
      ? diffs
      : command
        ? [{ type: "content", content: textBlock(command) }]
        : displayText
          ? [{ type: "content", content: textBlock(displayText) }]
          : undefined;
  return {
    title: toolTitleOf(name, input),
    kind: toolKindFor(name),
    locations: toolLocationsFor(input, rootPath),
    ...(input !== undefined ? { rawInput: input } : {}),
    ...(content ? { content } : {}),
  };
}

/** Build the ACP `tool_call_update` status from a tool part state. */ export function toolStatusFor(
  state: string,
  hasError: boolean
): "pending" | "in_progress" | "completed" | "failed" {
  if (hasError || state === "error") return "failed";
  if (state === "complete") return "completed";
  // `input-streaming` / `awaiting-input` mean the arguments are still arriving: the row is waiting
  // for them, not executing. The old mapping reported `in_progress`, which a client draws as a
  // spinner for a call that has not started.
  if (state === "input-streaming" || state === "awaiting-input") return "pending";
  // `approval-responded` means approved-but-not-yet-run: still in progress, not done.
  if (state === "approval-responded") return "in_progress";
  if (state === "input-complete" || state === "approval-requested") return "pending";
  return "in_progress";
}

/**
 * Parse a JSON string into a value, or undefined when it is not JSON.
 *
 * The counterpart to `JSON.stringify` on the persistence path: a tool result's `content` is a
 * `ContentPart[]` while the run is live and a JSON STRING of that array once the session has been saved
 * (see `hydrateToolResultContent` in core). Both doors have to be walked, and a tool result is not
 * always JSON — a plain log line must survive as text rather than "parse" into nothing.
 */
export function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The part types that mean "content a human reads", i.e. the ones whose text is worth showing.
 *
 * A `ContentPart[]` carries one entry per kind of content, and the media ones carry BYTES — a screenshot
 * part holds a full base64 payload. Stringifying the whole array into the row is how a `read_file` of an
 * image ended up as a wall of base64 next to a blank preview: the text extractor had no way to know
 * which entries described the tool's work and which were the payload.
 */
const TEXT_PART_TYPES = new Set(["text", "reasoning", "thinking"]);
/** Extract the readable text from one model-facing content part, or "" when it holds none. */
function textPartOf(part: unknown): string {
  const p = asRecord(part);
  if (!p) return "";
  if (typeof p.type === "string" && !TEXT_PART_TYPES.has(p.type)) return "";
  if (typeof p.content === "string") return p.content;
  if (typeof p.text === "string") return p.text;
  return "";
}

/**
 * Extract the text an object result declares, or undefined when it declares none.
 */
function textOfResultObject(value: unknown): string | undefined {
  const rec = asRecord(value);
  if (typeof rec?.text === "string") return rec.text;
  if (typeof rec?.content === "string") return rec.content;
  return undefined;
}

/**
 * Extract plain text from a tool result content value (string, ContentPart[], or JSON of one).
 *
 * Nearly every result a session holds is a JSON STRING — `{"command":…,"stdout":…}` for `run_command`,
 * `{"matches":[…]}` for `grep`, `{"type":"text","path":…,"content":…}` for `read_file` — and that
 * JSON *is* the row's rendering, so the default path returns it whole. Making "an object result is not
 * text" the rule would empty every one of those rows.
 *
 * @param hasMedia - the caller found an image in this result, so the projector is rendering its bytes as
 * an image block. Then the payload must NOT also be prose: only genuine text parts are readable, and a
 * bare media object (which declares no text) contributes nothing. This is the whole reason a `read_file`
 * of a screenshot showed a wall of base64 beside a blank preview.
 */
export function toolResultText(content: unknown, hasMedia = false): string {
  if (hasMedia) {
    if (Array.isArray(content)) return content.map(textPartOf).filter(Boolean).join("\n");
    if (typeof content === "string") {
      const parsed = tryParseJson(content);
      return Array.isArray(parsed) ? parsed.map(textPartOf).filter(Boolean).join("\n") : "";
    }
    return textOfResultObject(content) ?? "";
  }
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textPartOf).filter(Boolean).join("\n");
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return "";
}
