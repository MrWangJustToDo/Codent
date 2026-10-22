/**
 * File operation tracking for compaction summaries.
 *
 * Scans assistant `toolCalls` to build an accurate list of files read and modified.
 * This metadata is appended to the compaction summary so the LLM doesn't have to
 * rely on memory to list which files were involved.
 */

import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";

import type { ModelMessage } from "@tanstack/ai";

// ============================================================================
// Types & Constants
// ============================================================================

/**
 * Tracked file operations from tool calls.
 *
 * To add new tools, update READ_TOOLS or WRITE_TOOLS below.
 */
export interface FileOps {
  /** Files that were read (read_file, list_file, tree, etc.) */
  readFiles: Set<string>;
  /** Files that were created or modified (write_file, edit_file, etc.) */
  modifiedFiles: Set<string>;
}

/** Tools that read file content or structure */
const READ_TOOLS: ReadonlySet<string> = new Set([
  BUILTIN_TOOL_NAMES.readFile,
  BUILTIN_TOOL_NAMES.listFile,
  BUILTIN_TOOL_NAMES.tree,
]);

/** Tools that create or modify files */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  BUILTIN_TOOL_NAMES.writeFile,
  BUILTIN_TOOL_NAMES.editFile,
  BUILTIN_TOOL_NAMES.deleteFile,
]);

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Extract a string path field from a tool-call's args.
 * Handles JSON-string args from TanStack `function.arguments`.
 */
function extractPathFromArgs(args: unknown, field: string): string | undefined {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      const val = parsed[field];
      return typeof val === "string" && val.length > 0 ? val : undefined;
    } catch {
      return undefined;
    }
  }
  if (args && typeof args === "object") {
    const val = (args as Record<string, unknown>)[field];
    return typeof val === "string" && val.length > 0 ? val : undefined;
  }
  return undefined;
}

function trackFileOp(ops: FileOps, toolName: string, args: unknown): void {
  if (READ_TOOLS.has(toolName)) {
    const path = extractPathFromArgs(args, "path");
    if (path && path !== "." && path !== "./") {
      ops.readFiles.add(path);
    }
    return;
  }

  if (!WRITE_TOOLS.has(toolName)) return;

  const path = extractPathFromArgs(args, "path");
  if (path) ops.modifiedFiles.add(path);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract file operations from assistant tool calls.
 *
 * @param messages - TanStack ModelMessage[] to scan
 * @returns Deduplicated sets of read and modified file paths
 */
export function extractFileOpsFromMessages(messages: ModelMessage[]): FileOps {
  const ops: FileOps = { readFiles: new Set(), modifiedFiles: new Set() };

  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) continue;

    for (const toolCall of message.toolCalls) {
      trackFileOp(ops, toolCall.function.name, toolCall.function.arguments);
    }
  }

  return ops;
}

/**
 * Format file operations into markdown sections for appending to a summary.
 *
 * Returns empty string if no operations were tracked.
 */
export function formatFileOperations(ops: FileOps): string {
  const parts: string[] = [];

  if (ops.readFiles.size > 0) {
    parts.push("## Files Read");
    for (const f of [...ops.readFiles].sort()) {
      parts.push(`- \`${f}\``);
    }
  }

  if (ops.modifiedFiles.size > 0) {
    parts.push("## Files Modified");
    for (const f of [...ops.modifiedFiles].sort()) {
      parts.push(`- \`${f}\``);
    }
  }

  return parts.length > 0 ? "\n\n" + parts.join("\n") : "";
}
