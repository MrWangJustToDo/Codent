/**
 * Tool-call projection helpers: ACP `ToolKind` mapping, human titles, file
 * `locations`, and structured `diff` derivation.
 *
 * ACP per-tool metadata is derived here from the tool's name + input (and, for
 * diffs, the replacement spans that are already in the input) — core is not
 * coupled to ACP, and we never fabricate a diff we cannot reconstruct.
 */

import type { ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";

/** Per-name overrides that beat the category table (e.g. delete vs edit). */
const NAME_KIND_OVERRIDES: Record<string, ToolKind> = {
  read_file: "read",
  list_file: "read",
  tree: "read",
  lsp_definition: "read",
  lsp_references: "read",
  lsp_hover: "read",
  lsp_symbols: "read",
  code_overview: "read",
  memory_read: "read",
  load_skill: "read",
  edit_file: "edit",
  write_file: "edit",
  lsp_rename: "edit",
  code_rewrite: "edit",
  memory_write: "edit",
  delete_file: "delete",
  grep: "search",
  glob: "search",
  websearch: "fetch",
  webfetch: "fetch",
  lsp_diagnostics: "search",
  lsp_completions: "search",
  lsp_code_actions: "search",
  ast_search: "search",
  memory_list: "search",
  list_skills: "search",
  discover_tools: "search",
  run_command: "execute",
  get_command_output: "execute",
  kill_command: "execute",
  execute_typescript: "execute",
};

/** Map a tool name to an ACP {@link ToolKind}. */
export function toolKindFor(name: string): ToolKind {
  return NAME_KIND_OVERRIDES[name] ?? "other";
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
  return [...new Set(found)].map((p) => ({ path: toAbsolute(p, rootPath) }));
}

/** Resolve a possibly-relative path against the session root. */
export function toAbsolute(path: string, rootPath: string): string {
  if (!rootPath) return path;
  if (path.startsWith("/")) return path;
  const base = rootPath.endsWith("/") ? rootPath.slice(0, -1) : rootPath;
  return `${base}/${path.replace(/^\.\//, "")}`;
}

/** Human-readable title for a tool call: `Verb <path>` when a path is known. */
export function toolTitleFor(name: string, input: unknown): string {
  const path = toolLocationsFor(input, "")[0]?.path; // rootPath "" keeps it as given for the title
  const verb = TITLE_VERBS[name] ?? name.replace(/_/g, " ");
  if (path) return `${verb} ${path}`;
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

const TITLE_VERBS: Record<string, string> = {
  read_file: "Read",
  list_file: "List",
  tree: "Tree",
  edit_file: "Edit",
  write_file: "Write",
  delete_file: "Delete",
  grep: "Search",
  glob: "Find files",
  websearch: "Web search",
  webfetch: "Fetch",
  run_command: "Run",
  get_command_output: "Read command output",
  kill_command: "Kill command",
  execute_typescript: "Execute TypeScript",
  task: "Task",
  ask_user: "Ask user",
  todo: "Todos",
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

  if (name === "write_file" && typeof rec.content === "string") {
    return { type: "diff", path: toAbsolute(path, rootPath), oldText: null, newText: rec.content };
  }

  if (name === "edit_file") {
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
        path: toAbsolute(path, rootPath),
        oldText: oldChunks.join("\n"),
        newText: newChunks.join("\n"),
      };
    }
  }

  return undefined;
}

/** Build the ACP `tool_call_update` status from a tool part state. */
export function toolStatusFor(state: string, hasError: boolean): "pending" | "in_progress" | "completed" | "failed" {
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
