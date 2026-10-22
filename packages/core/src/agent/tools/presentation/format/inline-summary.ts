import { BUILTIN_TOOL_NAMES } from "../../catalog/tool-names.js";
import { isCancelledToolCall } from "../state.js";

import type { ToolCallPart } from "@tanstack/ai";

/** Only show final duration for slow operations (>= this threshold). */
export const DURATION_THRESHOLD_MS = 500;

/** Show a live elapsed timer on the tool header while executing past this threshold. */
export const LIVE_DURATION_THRESHOLD_MS = 3000;

/** Extract durationMs from tool output if available. */
export function getDurationMs(output: unknown): number | null {
  if (output && typeof output === "object" && "durationMs" in output) {
    const durationMs = (output as { durationMs?: unknown }).durationMs;
    if (typeof durationMs === "number") {
      return durationMs;
    }
  }
  return null;
}

/**
 * Get a brief inline summary for the header line, such as "3 matches" or "12 files".
 * Returns null if the tool has no meaningful inline summary.
 */
export function getInlineSummary(part: ToolCallPart, toolName: string): string | null {
  const output = part.output as Record<string, unknown> | undefined;
  if (!output) return null;

  // A run the user cut short reads as "cancelled" regardless of how its part settled —
  // `isCancelledToolCall` covers both the framework fallback marker (`cancelled`) and the
  // task tool's own `aborted`. Checked BEFORE the state guard because a truncation cancel
  // settles the part as `error` (the guard would bail) and a cancelled run_command would
  // otherwise render as a clean finish with an `(error)` body.
  if (isCancelledToolCall(part)) return "cancelled";

  if (part.state !== "complete") return null;

  switch (toolName) {
    case BUILTIN_TOOL_NAMES.readFile: {
      const totalLines = output.totalLines as number | undefined;
      if (totalLines !== undefined) return `${totalLines} lines`;
      if (output.type === "directory") {
        const totalEntries = output.totalEntries as number | undefined;
        return totalEntries !== undefined ? `${totalEntries} entries` : null;
      }
      if (output.type === "image" || output.type === "pdf") return output.type as string;
      return null;
    }
    case BUILTIN_TOOL_NAMES.listFile: {
      const count = output.count as number | undefined;
      return count !== undefined ? `${count} entries` : null;
    }
    case BUILTIN_TOOL_NAMES.grep: {
      const matches = output.matches as unknown[] | undefined;
      if (!matches) return null;
      return matches.length === 0 ? "no matches" : `${matches.length} match${matches.length !== 1 ? "es" : ""}`;
    }
    case BUILTIN_TOOL_NAMES.glob: {
      const files = output.files as string[] | undefined;
      if (!files) return null;
      return files.length === 0 ? "no files" : `${files.length} file${files.length !== 1 ? "s" : ""}`;
    }
    case BUILTIN_TOOL_NAMES.writeFile:
      return output.created ? "created" : "updated";
    case BUILTIN_TOOL_NAMES.editFile: {
      const replacements = output.replacements as number | undefined;
      if (replacements !== undefined) return `${replacements} replacement${replacements !== 1 ? "s" : ""}`;
      return "applied";
    }
    case BUILTIN_TOOL_NAMES.deleteFile:
      return "deleted";
    case BUILTIN_TOOL_NAMES.todo: {
      const stats = output.stats as { total?: number; completed?: number } | undefined;
      const source = output.source as string | undefined;
      const planTag = source === "plan" ? " plan" : "";
      if (stats) return `${stats.completed ?? 0}/${stats.total ?? 0} done${planTag}`;
      return source === "plan" ? "plan" : null;
    }
    case BUILTIN_TOOL_NAMES.createPlan:
    case BUILTIN_TOOL_NAMES.updatePlan: {
      const stepCount = output.stepCount as number | undefined;
      if (typeof stepCount === "number") return `${stepCount} steps`;
      return output.ok === false ? "failed" : "ready";
    }
    case BUILTIN_TOOL_NAMES.completePlan:
      return output.ok === false ? "failed" : "done";
    case BUILTIN_TOOL_NAMES.websearch: {
      const results = output.results as unknown[] | undefined;
      if (!results) return null;
      return results.length === 0 ? "no results" : `${results.length} result${results.length !== 1 ? "s" : ""}`;
    }
    case BUILTIN_TOOL_NAMES.task: {
      // A delegated run that was cut short must not read as a clean finish on the
      // row: the parent's result distinguishes a budget cutoff (`reachedLimit`)
      // from a stall (`incomplete` without a limit) from a natural end. Mirrors
      // the wording of `formatTaskOutput` so the row and the detailed block agree.
      //
      // The cancel case is NOT repeated here: `aborted` is one of the cancel markers, so
      // `isCancelledToolCall` above already returned "cancelled" for it. A second check on
      // this same output was unreachable — and it is the shape that made the marker look
      // like it needed per-tool handling.
      if (output.reachedLimit === true) return "limit reached";
      if (output.incomplete === true) return "stalled";
      return null;
    }
    case BUILTIN_TOOL_NAMES.webfetch: {
      const truncated = output.truncated === true;
      const contentType = typeof output.contentType === "string" ? output.contentType : null;
      if (contentType) return truncated ? `${contentType} (truncated)` : contentType;
      return truncated ? "truncated" : "fetched";
    }
    case BUILTIN_TOOL_NAMES.tree: {
      const totalEntries = output.totalEntries as number | undefined;
      if (totalEntries !== undefined) return `${totalEntries} entries`;
      return null;
    }

    // --- LSP inspection ---
    case BUILTIN_TOOL_NAMES.lspDiagnostics: {
      const errors = output.errors as number | undefined;
      const warnings = output.warnings as number | undefined;
      const count = output.count as number | undefined;
      if ((errors ?? 0) > 0) {
        return `${errors} err${errors !== 1 ? "s" : ""}${(warnings ?? 0) > 0 ? `, ${warnings} warn` : ""}`;
      }
      if ((warnings ?? 0) > 0) return `${warnings} warning${warnings !== 1 ? "s" : ""}`;
      if (count !== undefined && count > 0) return `${count} issue${count !== 1 ? "s" : ""}`;
      return count === 0 ? "clean" : null;
    }
    case BUILTIN_TOOL_NAMES.lspDefinition: {
      const count = output.count as number | undefined;
      if (count !== undefined) return count > 0 ? `${count} definition${count !== 1 ? "s" : ""}` : "not found";
      return null;
    }
    case BUILTIN_TOOL_NAMES.lspReferences: {
      const count = output.count as number | undefined;
      if (count !== undefined) return count > 0 ? `${count} reference${count !== 1 ? "s" : ""}` : "none";
      return null;
    }
    case BUILTIN_TOOL_NAMES.lspSymbols: {
      const count = output.count as number | undefined;
      if (count !== undefined) return count > 0 ? `${count} symbols` : "none";
      return null;
    }
    case BUILTIN_TOOL_NAMES.lspCompletions: {
      const count = output.count as number | undefined;
      const total = output.total as number | undefined;
      if (total !== undefined) return `${count ?? 0}/${total} completions`;
      if (count !== undefined) return count > 0 ? `${count} completions` : "none";
      return null;
    }
    case BUILTIN_TOOL_NAMES.lspCodeActions: {
      const count = output.count as number | undefined;
      const preferredCount = output.preferredCount as number | undefined;
      if (count !== undefined) {
        if (count === 0) return "none";
        return (preferredCount ?? 0) > 0 ? `${count} (${preferredCount} preferred)` : `${count} actions`;
      }
      return null;
    }
    case BUILTIN_TOOL_NAMES.lspHover:
      return output.hasResult === true ? "hover" : output.hasResult === false ? "no info" : null;

    // --- AST / structural analysis ---
    case BUILTIN_TOOL_NAMES.astSearch: {
      const matchCount = output.matchCount as number | undefined;
      if (matchCount !== undefined)
        return matchCount > 0 ? `${matchCount} match${matchCount !== 1 ? "es" : ""}` : "no matches";
      return null;
    }
    case BUILTIN_TOOL_NAMES.codeOverview: {
      const files = output.files as number | undefined;
      const symbols = output.symbols as number | undefined;
      if (files !== undefined) {
        const head = `${files} file${files !== 1 ? "s" : ""}`;
        return symbols !== undefined ? `${head}, ${symbols} symbols` : head;
      }
      return null;
    }
    case BUILTIN_TOOL_NAMES.codeRewrite: {
      const dryRun = output.dryRun as boolean | undefined;
      const filesModified = output.filesModified as number | undefined;
      if (dryRun === false) {
        return filesModified !== undefined && filesModified > 0
          ? `modified ${filesModified} file${filesModified !== 1 ? "s" : ""}`
          : "no changes";
      }
      const matchCount = output.matchCount as number | undefined;
      if (matchCount !== undefined) {
        return matchCount > 0 ? `${matchCount} match${matchCount !== 1 ? "es" : ""} (preview)` : "no matches";
      }
      return null;
    }
    case BUILTIN_TOOL_NAMES.lspRename: {
      const editCount = output.editCount as number | undefined;
      const fileCount = output.fileCount as number | undefined;
      if (editCount !== undefined && editCount > 0) {
        return `${editCount} edit${editCount !== 1 ? "s" : ""}${fileCount !== undefined ? `, ${fileCount} file${fileCount !== 1 ? "s" : ""}` : ""} (preview)`;
      }
      return editCount === 0 ? "no edits" : null;
    }

    // --- Memory ---
    case BUILTIN_TOOL_NAMES.memoryList: {
      const count = output.count as number | undefined;
      if (count !== undefined) return `${count} memory${count !== 1 ? "ies" : "y"}`;
      return null;
    }
    case BUILTIN_TOOL_NAMES.memoryRead: {
      const type = output.type as string | undefined;
      return typeof type === "string" ? `[${type}]` : null;
    }
    case BUILTIN_TOOL_NAMES.memoryWrite:
      return output.ok === false ? "failed" : "saved";

    // --- Skills ---
    case BUILTIN_TOOL_NAMES.listSkills: {
      const count = output.count as number | undefined;
      if (count !== undefined) return `${count} skill${count !== 1 ? "s" : ""}`;
      return null;
    }
    case BUILTIN_TOOL_NAMES.loadSkill:
      return typeof output.name === "string" ? "loaded" : null;

    default:
      return null;
  }
}

/**
 * Header summary for a completed call derived from its output alone — the shape the
 * descriptor API uses (`present.summary(output)`).
 */
export function inlineSummaryForOutput(output: unknown, toolName: string): string | null {
  const part = {
    type: "tool-call",
    id: "",
    name: toolName,
    arguments: "",
    state: "complete",
    output,
  } as ToolCallPart;
  return getInlineSummary(part, toolName);
}
