/**
 * Tool-call projection helpers: ACP `ToolKind` mapping, human titles, file
 * `locations`, and structured `diff` derivation.
 *
 * ACP per-tool metadata is derived here from the tool's name + input (and, for
 * diffs, the replacement spans that are already in the input) — core is not
 * coupled to ACP, and we never fabricate a diff we cannot reconstruct.
 */

import { BUILTIN_TOOL_NAMES, formatToolInput, getToolPresentation } from "@codent/core";

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
  const category = getToolPresentation(name)?.category ?? "other";
  return NAME_KIND_OVERRIDES[name] ?? CATEGORY_KIND[category];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Path-like fields a tool input may carry (single or list). */
const PATH_KEYS = ["path", "file", "filePath", "file_path", "target"] as const;
const PATH_LIST_KEYS = ["paths", "files"] as const;

/** Collect absolute file paths a tool call touches, for ACP `locations`. */
export function toolLocationsFor(input: unknown, rootPath: string): Array<{ path: string }> {
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
  return [...new Set(found)].map((p) => ({ path: toWirePath(p, rootPath) }));
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
  const rec = asRecord(input);
  if (!rec) return undefined;
  const path = typeof rec.path === "string" ? rec.path : undefined;
  if (!path) return undefined;

  if (name === BUILTIN_TOOL_NAMES.writeFile && typeof rec.content === "string") {
    return { type: "diff", path: toWirePath(path, rootPath), oldText: null, newText: rec.content };
  }

  if (name === BUILTIN_TOOL_NAMES.editFile) {
    const edits = Array.isArray(rec.edits) ? rec.edits : [rec];
    const oldChunks: string[] = [];
    const newChunks: string[] = [];
    for (const edit of edits) {
      const e = asRecord(edit);
      if (!e) continue;
      if (typeof e.oldString === "string") oldChunks.push(e.oldString);
      if (typeof e.newString === "string") newChunks.push(e.newString);
    }
    if (oldChunks.length > 0 && oldChunks.length === newChunks.length) {
      return {
        type: "diff",
        path: toWirePath(path, rootPath),
        oldText: oldChunks.join("\n"),
        newText: newChunks.join("\n"),
      };
    }
  }

  return undefined;
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
  const diff = toolDiffFor(name, input, rootPath);
  const command = shellCommandOf(name, input);
  const content: ToolCallContent[] | undefined = diff
    ? [diff]
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
  // `approval-responded` means approved-but-not-yet-run: still in progress, not done.
  if (state === "approval-responded" || state === "input-streaming") return "in_progress";
  if (state === "awaiting-input" || state === "input-complete" || state === "approval-requested") return "pending";
  return "in_progress";
}

/** Extract plain text from a tool result content value (string or ContentPart[]). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = asRecord(part);
        if (!p) return "";
        if (typeof p.content === "string") return p.content;
        if (typeof p.text === "string") return p.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return "";
}
