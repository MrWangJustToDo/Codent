import { isSyntheticCancelOutput } from "../../../../runtime-types/abort.js";
import { promptTokensOf } from "../../../../runtime-types/token-usage.js";
import { formatExtensionDeniedOutput, isExtensionDeniedOutput } from "../../../../runtime-types/tool-denial.js";
import { isBareToolErrorResult } from "../../../../runtime-types/tool-error.js";
import { formatByteSize } from "../../../../utils/byte-size.js";
import { truncateText } from "../../../../utils/text-truncation.js";
import { AGENT_CACHE_DIR } from "../../../../utils/workspace-paths.js";
import { TOOL_CANCELLED_MESSAGE } from "../../../stream/incomplete-tool-calls.js";
import { BUILTIN_TOOL_NAMES } from "../../catalog/tool-names.js";
import { getBuiltinToolPresentation } from "../builtin.js";

import { ENTRY_VALUE_MAX_CHARS } from "./format.js";
import { splitStreamingLines } from "./lines.js";

import type { TaskOutput } from "../../../subagent/task-tool.js";
import type { ReadFileOutput } from "../../builtin/fs/read-file-tool.js";
import type {
  EditFileOutput,
  GetCommandOutput,
  GlobOutput,
  GrepOutput,
  KillCommandOutput,
  ListFileOutput,
  RunCommandOutput,
  TodoOutput,
  WriteFileOutput,
} from "../../shared/schemas.js";
import type { ToolPresentationResolver } from "../types.js";

// ============================================================================
// Helpers
// ============================================================================

/** The cache path as a regex fragment — the hint lines are produced from the same constant. */
const CACHE_DIR_PATTERN = AGENT_CACHE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CACHE_HINT_PATTERNS = [
  new RegExp(`^Full output saved to:\\s*${CACHE_DIR_PATTERN}/`),
  new RegExp(`^Use read_file with path="${CACHE_DIR_PATTERN}/`),
  /^\.\.\.\s*\(\d+\s+lines?\s+omitted\)\s*\.\.\.$/,
  /^\.\.\.\s*\(\d+\s+chars?\s+omitted\)\s*\.\.\.$/,
];

/** Strip LLM-directed cache hint lines from tool output for user display. */
function stripCacheHintLines(lines: string[]): string[] {
  return lines.filter((line) => !CACHE_HINT_PATTERNS.some((pattern) => pattern.test(line)));
}

// ============================================================================
// Formatters
// ============================================================================

function formatListFileOutput(output: ListFileOutput): string {
  const { entries, count } = output;
  if (!count || count === 0 || !entries || entries.length === 0) return "Empty directory";

  const maxShow = 5;
  const shown = entries.slice(0, maxShow);
  const lines = shown.map((e) => {
    const icon = e.type === "directory" ? "/" : "";
    return `  ${e.name}${icon}`;
  });

  if (count > maxShow) {
    lines.push(`  ... and ${count - maxShow} more`);
  }

  return `${count} entries:\n${lines.join("\n")}`;
}

/** Max width for individual output lines before truncation. */
const MAX_LINE_WIDTH = 400;

function truncateLine(line: string, maxWidth: number = MAX_LINE_WIDTH): string {
  // Defense: strip any leftover CR before measuring / rendering in Ink.
  const cleaned = line.replace(/\r/g, "");
  return truncateText(cleaned, maxWidth);
}

function formatRunCommandOutput(output: RunCommandOutput): string {
  if (output.runInBackground && output.jobId) {
    return `Background job ${output.jobId} (${output.status ?? "running"}): ${output.command}`;
  }

  const { stdout, stderr, exitCode, success, cancelled, timedOut, timeoutMs } = output;
  const lines: string[] = [];

  // A deadline kill (`timedOut`) and a user cancel (`cancelled`) both carry a synthesized
  // `exitCode: -1` — the schema's "not finished" value, NOT a result — so neither prints an exit
  // code. A timeout instead NAMES its cause: the bare `Exit code: -1` is exactly the "reads like a
  // crash" the model-facing output avoids, and it would sit above the partial output the tool
  // deliberately kept (still rendered below).
  //
  // For a cancel, `formatToolOutput` already short-circuits the framework's synthetic payload
  // before a formatter is reached; this covers the OTHER cancel shape, where the tool's own catch
  // returns a full output with `cancelled: true` and `exitCode: -1`.
  if (timedOut) {
    lines.push(typeof timeoutMs === "number" ? `Command timed out after ${timeoutMs}ms` : "Command timed out");
  } else if (!success && !cancelled) {
    lines.push(`Exit code: ${exitCode}`);
  }

  if (stderr && stderr.trim()) {
    const stderrLines = stripCacheHintLines(splitStreamingLines(stderr.trim()));
    const tail = stderrLines.slice(-3);
    if (stderrLines.length > 3) {
      lines.push(`stderr: ... (${stderrLines.length - 3} more lines)`);
    }
    lines.push(...tail.map((line) => `stderr: ${truncateLine(line)}`));
  }

  if (stdout && stdout.trim()) {
    const stdoutLines = stripCacheHintLines(splitStreamingLines(stdout.trim()));
    const tail = stdoutLines.slice(-3);
    if (stdoutLines.length > 3) {
      lines.push(`... (${stdoutLines.length - 3} more lines)`);
    }
    lines.push(...tail.map((i) => truncateLine(i)));
  }

  if (lines.length === 0) {
    if (cancelled) return TOOL_CANCELLED_MESSAGE;
    return success ? "Command completed successfully" : `Command failed (exit ${exitCode})`;
  }

  return lines.join("\n");
}

function formatGetCommandOutput(output: GetCommandOutput): string {
  const lines = [`job ${output.jobId}: ${output.status}`];
  if (output.exitCode != null) lines.push(`exit ${output.exitCode}`);
  if (output.stderr?.trim()) {
    const stderrLines = splitStreamingLines(output.stderr.trim()).slice(-3);
    lines.push(...stderrLines.map((line) => `stderr: ${truncateLine(line)}`));
  }
  if (output.stdout?.trim()) {
    const stdoutLines = splitStreamingLines(output.stdout.trim()).slice(-3);
    lines.push(...stdoutLines.map((line) => truncateLine(line)));
  } else if (!output.stderr?.trim()) {
    lines.push(output.running ? "(no new output)" : "(no output)");
  }
  return lines.join("\n");
}

function formatKillCommandOutput(output: KillCommandOutput): string {
  return output.killed
    ? `Killed job ${output.jobId} (${output.status})`
    : `Job ${output.jobId} not running (${output.status})`;
}

function formatReadFileOutput(output: ReadFileOutput): string {
  // Derive a summary from structured fields instead of the removed `message`.
  if (output.type === "text") {
    return `Read ${output.path} (lines ${output.startLine}-${output.endLine} of ${output.totalLines})`;
  }
  if (output.type === "directory") {
    return `Listed ${output.path} (${output.entries.length}/${output.totalEntries} entries)`;
  }
  if (output.type === "image") {
    return `Image: ${output.path} (${formatByteSize(output.size)})`;
  }
  if (output.type === "pdf") {
    return `PDF: ${output.path} (${formatByteSize(output.size)})`;
  }
  return "";
}

function formatWriteFileOutput(output: WriteFileOutput): string {
  return output.created ? `Created file: ${output.path}` : `Overwrote file: ${output.path}`;
}

function formatEditFileOutput(output: EditFileOutput): string {
  return `Edited ${output.path} (${output.replacements} replacement${output.replacements !== 1 ? "s" : ""})`;
}

function formatGlobOutput(output: GlobOutput): string {
  const { files } = output;
  // A search the run stopped renders as cancelled, whatever it had printed. "No files found" would
  // be a claim the search never earned — it was stopped mid-scan. Only the marker-only shape is
  // replaced (the same line `isSyntheticCancelOutput` draws): a search that did return files still
  // renders them rather than hiding output the user watched arrive.
  if (output.cancelled === true && (!files || files.length === 0)) return TOOL_CANCELLED_MESSAGE;
  if (!files || files.length === 0) return "No files found";

  const maxShow = 5;
  const shown = files.slice(0, maxShow);
  const lines = shown.map((file) => `  ${file}`);

  if (files.length > maxShow) {
    lines.push(`  ... and ${files.length - maxShow} more`);
  }

  return `${files.length} files found:\n${lines.join("\n")}`;
}

function formatGrepOutput(output: GrepOutput): string {
  const { matches } = output;
  // See {@link formatGlobOutput}: a cancelled search reports a cancel, and only when it has nothing
  // to show — a stopped `grep` certainly is not a `grep` that found nothing.
  if (output.cancelled === true && (!matches || matches.length === 0)) return TOOL_CANCELLED_MESSAGE;
  if (!matches || matches.length === 0) return "No matches found";

  const maxShow = 5;
  const shown = matches.slice(0, maxShow);
  const lines = shown.map((match) => {
    const line = Number.isFinite(match.lineNumber) && match.lineNumber > 0 ? match.lineNumber : "?";
    return `  ${match.file}:${line}`;
  });

  if (matches.length > maxShow) {
    lines.push(`  ... and ${matches.length - maxShow} more matches`);
  }

  return `${matches.length} matches:\n${lines.join("\n")}`;
}

function formatTodoOutput(output: TodoOutput): string {
  const { stats, source } = output;
  // `stats` is required by the schema, but this formatter is also reachable from host code that
  // renders a stored part. A framework/extension shape without it must not throw inside a render.
  if (!stats) return source === "plan" ? "Updated plan todos" : "Updated todos";
  const tag = source === "plan" ? " (plan)" : "";
  return `Updated ${stats.total} todos${tag}: ${stats.completed} completed, ${stats.inProgress} in progress, ${stats.pending} pending`;
}

function formatAskUserOutput(output: {
  question?: string;
  answer?: string;
  hasOptions?: boolean;
  multiSelect?: boolean;
  selected?: string[];
  draft?: string;
}): string {
  const { answer, hasOptions, multiSelect, selected, draft } = output;
  if (!answer && !(selected && selected.length > 0)) return "";

  const lines: string[] = [];
  // Multi-select: echo the picked options as an explicit list (one per line) so
  // it's clear these are option choices rather than an ambiguous comma-joined
  // string — option text may itself contain commas.
  if (multiSelect && selected && selected.length > 0) {
    lines.push(`Selected ${selected.length} item${selected.length !== 1 ? "s" : ""}:`);
    for (const item of selected) {
      lines.push(`  - ${truncateLine(item)}`);
    }
    if (draft) {
      lines.push(`  - ${truncateLine(draft)} (custom answer)`);
    }
    return lines.join("\n");
  }
  // Single-select / no options: label distinguishes a picked option from a
  // free-form typed answer, mirroring how the question itself is shown in the
  // tool header.
  lines.push(hasOptions ? `Selected: ${truncateLine(answer ?? "")}` : `Answer: ${truncateLine(answer ?? "")}`);
  return lines.join("\n");
}

function formatTaskOutput(output: TaskOutput): string {
  const { summary, iterations, truncated, reachedLimit, incomplete, aborted, usage, cachedOutputPath } = output;
  const lines: string[] = [];
  const statusParts: string[] = [];

  if (typeof iterations === "number") statusParts.push(`${iterations} iteration${iterations !== 1 ? "s" : ""}`);
  // Billed prompt + output — `usage.totalTokens` omits the cached prompt, which for a
  // subagent is nearly the whole thing (one real run: 1.95k reported against 2.70M sent).
  if (usage) {
    // `billedInputTokens` was added after this output shape shipped, so a task result read
    // back from an older session does not carry it (49 such outputs exist in this workspace's
    // sessions). Read the cached counters then — the same convention-aware sum the tracker
    // uses — rather than defaulting to 0, which rendered `[1 iteration, 300 tokens]` for a
    // 27k-token run: not the prompt, but at least the part of it the data still holds.
    const billedInput = usage.billedInputTokens ?? promptTokensOf(usage);
    statusParts.push(`${billedInput + (usage.outputTokens ?? 0)} tokens`);
  }
  // Disk cache preview (large summary) vs length truncation (maxOutputLength) are different.
  if (cachedOutputPath) statusParts.push("cached");
  else if (truncated) statusParts.push("truncated");
  if (aborted) statusParts.push("cancelled");
  if (reachedLimit) statusParts.push("limit reached");
  if (incomplete && !reachedLimit && !aborted) statusParts.push("stalled");
  if (!summary) return aborted ? "[cancelled]" : "";
  if (statusParts.length > 0) lines.push(`[${statusParts.join(", ")}]`);

  const summaryLines = stripCacheHintLines(splitStreamingLines(summary.trim()));
  const maxSummaryLines = 10;
  const shown = summaryLines.length <= maxSummaryLines ? summaryLines : summaryLines.slice(0, maxSummaryLines);
  lines.push(...shown.map((i) => truncateLine(i)));
  if (summaryLines.length > maxSummaryLines) {
    lines.push(`... (${summaryLines.length - maxSummaryLines} more lines)`);
  }

  return lines.join("\n");
}

/** Short JSON/text preview for a tool with no dedicated renderer (or one that produced nothing). */
function formatGenericToolOutput(output: unknown): string {
  const str = typeof output === "string" ? output : JSON.stringify(output, null, 2);
  return truncateText(str, 200);
}

/** Format tool output for display based on tool name. */
export function formatToolOutput(
  output: unknown,
  toolName?: string,
  resolvePresentation: ToolPresentationResolver = getBuiltinToolPresentation
): string {
  if (output === undefined || output === null) return "";

  // The framework's abort fallback (`cancelInFlightToolCalls` / `cancelIncompleteToolCalls`)
  // settles a tool that never produced a result with a SHARED synthetic payload —
  // `{ success: false, error, cancelled: true }` — regardless of which tool it was. It is not any
  // tool's output schema: `run_command` has no `exitCode` in it (so this rendered the literal
  // `Exit code: undefined` on the first frame after a cancel, until the tool's own catch replaced
  // the part one message later with `-1`), `todo` has no `stats` (its formatter threw), and
  // `edit_file` has no `path` (so it rendered "Edited undefined"). Reading it here, before
  // dispatching on tool name, is what makes a cancelled row render as cancelled for EVERY tool
  // instead of each formatter having to defend against a shape it can never legitimately receive.
  //
  // Only the SYNTHETIC one is short-circuited. A tool that caught its own abort returns a full
  // output with `cancelled: true` and whatever it had produced — that is a real result, and its
  // formatter renders it (minus the exit code the tool synthesizes).
  if (isSyntheticCancelOutput(output)) return TOOL_CANCELLED_MESSAGE;

  // An extension's refusal (`tool:before:*` → `event.skip`) is the same class of shape: a shared
  // marker that is no tool's schema. Without this short-circuit every formatter read fields that
  // cannot be there (`todo` threw on `stats.total`, `run_command` printed `Exit code: undefined`).
  if (isExtensionDeniedOutput(output)) return formatExtensionDeniedOutput(output);

  // A tool that THREW settles as `{ error: string }`, which is not any tool's output schema.
  // Every formatter below reads its own fields, so without this the commonest failure
  // (`write_file` on an existing path) rendered "Overwrote file: undefined" and `todo` threw a
  // TypeError inside a host render. The model-facing projection has always short-circuited the
  // same shape; this is the UI-side counterpart. Empty is deliberate: the row's error header
  // already carries the message, and a fabricated body is worse than none.
  if (isBareToolErrorResult(output)) return "";

  if (toolName) {
    const uiRenderer = resolvePresentation(toolName)?.text;
    if (uiRenderer) {
      const rendered = uiRenderer(output);
      if (typeof rendered === "string") return rendered;
      // The descriptor exists but produced nothing usable: a host-side descriptor is a stub
      // (`presentationFromInfo` cannot carry renderers across processes, so `text` returns
      // undefined), or a real formatter received a shape it does not know. An empty row is worse
      // than the generic preview — the tool ran, so the user should see at least the payload.
      return formatGenericToolOutput(output);
    }
  }

  if (toolName && typeof output === "object") {
    const out = output as Record<string, unknown>;

    switch (toolName) {
      case BUILTIN_TOOL_NAMES.listFile:
        return formatListFileOutput(out as ListFileOutput);
      case BUILTIN_TOOL_NAMES.runCommand:
        return formatRunCommandOutput(out as RunCommandOutput);
      case BUILTIN_TOOL_NAMES.getCommandOutput:
        return formatGetCommandOutput(out as GetCommandOutput);
      case BUILTIN_TOOL_NAMES.killCommand:
        return formatKillCommandOutput(out as KillCommandOutput);
      case BUILTIN_TOOL_NAMES.readFile:
        return formatReadFileOutput(out as ReadFileOutput);
      case BUILTIN_TOOL_NAMES.writeFile:
        return formatWriteFileOutput(out as WriteFileOutput);
      case BUILTIN_TOOL_NAMES.editFile:
        return formatEditFileOutput(out as EditFileOutput);
      case BUILTIN_TOOL_NAMES.glob:
        return formatGlobOutput(out as GlobOutput);
      case BUILTIN_TOOL_NAMES.grep:
        return formatGrepOutput(out as GrepOutput);
      case BUILTIN_TOOL_NAMES.todo:
        return formatTodoOutput(out as TodoOutput);
      case BUILTIN_TOOL_NAMES.task:
        return formatTaskOutput(out as TaskOutput);
      case BUILTIN_TOOL_NAMES.createPlan:
      case BUILTIN_TOOL_NAMES.updatePlan:
        // Plan body is reviewed via PlanReadyBanner markdown preview — no tool output dump.
        return "";
      case BUILTIN_TOOL_NAMES.completePlan: {
        return typeof out.message === "string" ? out.message : "Plan complete";
      }
      case BUILTIN_TOOL_NAMES.websearch: {
        const results = Array.isArray(out.results) ? out.results : [];
        const query = typeof out.query === "string" ? out.query : "";
        if (results.length === 0) return query ? `No results for ${query}` : "No results";
        const lines = results.slice(0, 5).map((r) => {
          const row = r as { title?: string; url?: string };
          return `- ${row.title ?? "result"}${row.url ? ` (${row.url})` : ""}`;
        });
        return [`Search: ${query}`, ...lines].join("\n");
      }
      case BUILTIN_TOOL_NAMES.webfetch: {
        const url = typeof out.url === "string" ? out.url : "";
        const content = typeof out.content === "string" ? out.content : "";
        const preview = truncateText(content, 400);
        return url ? `${url}\n${preview}` : preview;
      }
      case BUILTIN_TOOL_NAMES.askUser:
        return formatAskUserOutput(
          out as {
            question?: string;
            answer?: string;
            hasOptions?: boolean;
            multiSelect?: boolean;
            selected?: string[];
            draft?: string;
          }
        );
      default:
        // No generic fallback to output.message (removed in phase 2).
        // Unknown tools get an empty string; they should add a dedicated case or register toUI.
        return "";
    }
  }

  return formatGenericToolOutput(output);
}

/** Format tool arguments for detailed display. */
export function formatToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "No arguments";
  if (typeof args === "string") return truncateText(args, ENTRY_VALUE_MAX_CHARS);

  const obj = args as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) return "No arguments";

  return entries
    .map(([key, value]) => {
      const strValue = typeof value === "string" ? value : JSON.stringify(value);
      return `  ${key}: ${truncateText(strValue, ENTRY_VALUE_MAX_CHARS)}`;
    })
    .join("\n");
}
