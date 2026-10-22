import { z } from "zod";

import { isAbortError } from "../../../../runtime-types/abort.js";
import { defineServerTool, isProjectedModelContent } from "../../runtime/define-tool.js";
import { maybeCacheOutput } from "../../shared/cache/tool-output-cache.js";
import { OUTPUT_LIMITS } from "../../shared/output-limits.js";
import { grepOutputSchema } from "../../shared/schemas.js";
import { withDuration } from "../../shared/tool-result.js";
import { canExecArgs, execArgsCapture } from "../shell/exec-args.js";

import {
  DEFAULT_EXCLUDE_DIRS,
  isCommandNotFound,
  quoteForShell,
  resolveSearchPath,
  SEARCH_COMMAND_TIMEOUT,
  truncateLines,
} from "./search/search-command.js";

import type { CoreEnv } from "../../../../env";
import type { GrepOutput } from "../../shared/schemas.js";

/** Maximum characters per matching line content (to prevent context overflow) */
const MAX_MATCH_LINE_CHARS = 500;

/** Maximum total characters for all match content combined */
const MAX_TOTAL_CONTENT = OUTPUT_LIMITS.MAX_CONTENT_CHARS;

/** Default number of matches per page */
const DEFAULT_LIMIT = 100;

/**
 * Cut one matched LINE to `maxLength`, marking the cut inline.
 *
 * Deliberately not `OUTPUT_LIMITS.truncateString`: that one inserts a newline before its marker,
 * which is fine for a block of text but would split a single match line in two — and this result is
 * parsed line-by-line, so the cut has to stay on one line.
 */
function truncateMatchLine(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.slice(0, maxLength) + "...[truncated]";
}

/**
 * Expand brace groups in a glob include pattern into individual globs.
 *
 * grep `--include` and rg `--glob` do not perform brace expansion, so a pattern
 * like `*.{ts,tsx}` is treated literally and matches nothing. Expand it into one
 * glob per alternative (e.g. `*.ts`, `*.tsx`) so callers can pass each as a
 * separate `--include` / `--glob` flag. Patterns without braces are returned as-is.
 */
function expandBraceGlobs(include: string): string[] {
  const groupRe = /\{([^{}]+)\}/;
  let current: string[] = [include];
  let match: RegExpExecArray | null;
  while ((match = groupRe.exec(current[0] ?? ""))) {
    const full = match[0];
    const alternatives = match[1].split(",");
    const next: string[] = [];
    for (const prefix of current) {
      const idx = prefix.indexOf(full);
      for (const alt of alternatives) {
        next.push(prefix.slice(0, idx) + alt + prefix.slice(idx + full.length));
      }
    }
    current = next;
    if (current.length === 0) {
      break;
    }
  }
  return current;
}

/**
 * Strip a single pair of matching outer quotes from a pattern.
 *
 * Agents sometimes wrap a regex in quotes (e.g. `"extensions"` or `'extensions'`)
 * treating the pattern as a literal string. grep/rg see those quote chars as
 * ordinary characters, so `"extensions"` matches nothing when the source only
 * has bare `extensions` — a silent empty result that is easy to misread as a
 * tool bug. When the whole pattern is wrapped in one matching quote pair, drop
 * the quotes so the search behaves as the caller intended.
 *
 * Returns the possibly-stripped pattern plus whether quotes were present at all
 * (stripped or embedded), so the caller can attach a hint on empty results.
 */
function stripOuterQuotes(pattern: string): { pattern: string; hadQuotes: boolean } {
  const hadQuotes = /["']/.test(pattern);
  if (pattern.length >= 2) {
    const first = pattern[0];
    const last = pattern[pattern.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return { pattern: pattern.slice(1, -1), hadQuotes };
    }
  }
  return { pattern, hadQuotes };
}

function buildRgArgs(
  pattern: string,
  searchPath: string,
  options: {
    ignoreCase: boolean;
    include: string | undefined;
    outputMode: string;
    context: number;
    searchPathIsFile: boolean;
    fetchCount: number;
  }
): string[] {
  const args: string[] = ["--color=never"];

  if (options.ignoreCase) {
    args.push("-i");
  }

  if (options.outputMode === "files_with_matches") {
    args.push("--files-with-matches");
  } else if (options.outputMode === "count") {
    args.push("--count");
  } else {
    args.push("--line-number", "--no-heading");
    if (options.context > 0) {
      args.push("-C", String(options.context));
    }
  }

  // --glob is only meaningful for directory searches; skip when searching a
  // single file to avoid conflicts between the glob and the file path.
  // Brace groups like `*.{ts,tsx}` are expanded to one --glob per alternative
  // since rg does not brace-expand its own --glob values.
  if (options.include && !options.searchPathIsFile) {
    for (const glob of expandBraceGlobs(options.include)) {
      args.push("--glob", glob);
    }
  }

  if (!options.searchPathIsFile) {
    for (const dir of DEFAULT_EXCLUDE_DIRS) {
      args.push("--glob", `!**/${dir}/**`);
    }
  }

  // `--` then the pattern as a single argv entry: no quoting, no escaping, and no shell
  // to reinterpret it, so a pattern containing quotes or metacharacters arrives intact.
  //
  // `--max-count` bounds the work at the source. Truncation to `fetchCount` happens in JS
  // either way (there is no `| head` any more), but without a source-side cap a search in a
  // large repository streams every match before all but the first few are discarded.
  args.push("--max-count", String(options.fetchCount));
  args.push("--", pattern, searchPath);
  return args;
}

function buildGrepArgs(
  pattern: string,
  searchPath: string,
  options: {
    ignoreCase: boolean;
    include: string | undefined;
    outputMode: string;
    context: number;
    searchPathIsFile: boolean;
    fetchCount: number;
  }
): string[] {
  const args: string[] = ["--color=never"];

  // Use -r (recursive) only when searching a directory; for a single file, plain grep
  // avoids conflicts between --include and a direct file path.
  if (!options.searchPathIsFile) {
    args.push("-r");
  }

  if (options.ignoreCase) {
    args.push("-i");
  }

  if (options.outputMode === "files_with_matches") {
    args.push("-l");
  } else if (options.outputMode === "count") {
    args.push("-c");
  } else {
    args.push("-n");
  }

  if (options.outputMode === "content" && options.context > 0) {
    args.push("-C", String(options.context));
  }

  // --include and --exclude-dir are only meaningful for directory searches; skip them when
  // searching a single file to avoid conflicts. Brace groups are expanded to one --include
  // per alternative since grep does not brace-expand its own --include values.
  if (options.include && !options.searchPathIsFile) {
    for (const glob of expandBraceGlobs(options.include)) {
      args.push("--include", glob);
    }
  }

  if (!options.searchPathIsFile) {
    for (const dir of DEFAULT_EXCLUDE_DIRS) {
      args.push("--exclude-dir", dir);
    }
  }

  args.push("-E", pattern, searchPath);
  // `-m` restores the source-side cap the previous `| head -n` pipeline provided (task 2.7 lists
  // pagination parity as a requirement). Without it the fallback reads the entire tree and the
  // JS-side truncation discards almost all of it — on GNU grep this is a bigger deal than with
  // ripgrep because there is no default match limit.
  args.push("-m", String(options.fetchCount));
  return args;
}

/**
 * Quote one argument for the legacy shell path.
 *
 * Reached only when the host cannot execute with an argv vector (a remote environment on a
 * server predating the exec-file route). POSIX quoting is kept because that is the
 * assumption the previous implementation already made — but no `pipefail` prefix, no stderr
 * redirection, and no `head` pipeline: truncation stays in JS on both paths.
 */
/**
 * Parse a positive integer line number; rejects NaN (JSON.stringify(NaN) → null).
 */
/**
 * Run the content search, preferring ripgrep and falling back to grep.
 *
 * Availability drives the choice: binaries are probed rather than relying on exit code 127,
 * which is POSIX-only for "command not found" (cmd.exe reports 9009, PowerShell reports 1),
 * so the code-based fallback never fired on Windows.
 *
 * Truncation to `fetchCount` happens in JS on both paths, replacing the previous `head`
 * pipeline — the shell is never responsible for correctness.
 */
async function runGrepSearch(
  env: CoreEnv,
  pattern: string,
  searchPath: string,
  options: {
    ignoreCase: boolean;
    include: string | undefined;
    outputMode: string;
    context: number;
    fetchCount: number;
    searchPathIsFile: boolean;
    signal?: AbortSignal;
  }
): Promise<string> {
  if (canExecArgs(env)) {
    const rgStdout = await execArgsCapture(env, "rg", buildRgArgs(pattern, searchPath, options), {
      cwd: env.rootPath,
      signal: options.signal,
    });
    if (rgStdout !== undefined) return truncateLines(rgStdout, options.fetchCount);
    const grepStdout = await execArgsCapture(env, "grep", buildGrepArgs(pattern, searchPath, options), {
      cwd: env.rootPath,
      signal: options.signal,
    });
    if (grepStdout !== undefined) return truncateLines(grepStdout, options.fetchCount);
    // Neither binary is available — an empty result is the honest answer.
    return "";
  }

  // Legacy path for hosts without argument-vector execution (task 1.7): the same argv,
  // joined and quoted, with truncation still in JS.
  const timeout = SEARCH_COMMAND_TIMEOUT;
  const rgArgv = buildRgArgs(pattern, searchPath, options).map(quoteForShell);
  const rgResult = await env.runCommand(`rg ${rgArgv.join(" ")}`, {
    timeout,
    cwd: env.rootPath,
    signal: options.signal,
  });
  if (!isCommandNotFound(rgResult.exitCode)) return truncateLines(rgResult.stdout, options.fetchCount);
  const grepArgv = buildGrepArgs(pattern, searchPath, options).map(quoteForShell);
  const grepResult = await env.runCommand(`grep ${grepArgv.join(" ")}`, {
    timeout,
    cwd: env.rootPath,
    signal: options.signal,
  });
  return truncateLines(grepResult.stdout, options.fetchCount);
}

function parseLineNumber(value: string): number | null {
  const lineNumber = Number(value);
  if (!Number.isFinite(lineNumber) || lineNumber < 0 || !Number.isInteger(lineNumber)) {
    return null;
  }
  return lineNumber;
}

/**
 * Parse ripgrep/grep content output.
 *
 * Match lines use `path:line:content` — the line number is the first `:digits:` segment
 * (non-greedy path), not the last, so colons in file content are not mistaken for a line.
 * Context lines use `path-line-content` (rg uses `-` instead of `:` around the line number).
 */
function parseGrepLine(
  line: string,
  defaultFile?: string
): { file: string; lineNumber: number; content: string } | null {
  if (line === "--") {
    return null;
  }

  // Match `path:line:content` format (from recursive directory search)
  const matchLine = line.match(/^(.+?):(\d+):(.*)$/s);
  if (matchLine) {
    const lineNumber = parseLineNumber(matchLine[2]);
    if (lineNumber === null) {
      return null;
    }
    return {
      file: matchLine[1],
      lineNumber,
      content: matchLine[3],
    };
  }

  // Match `line:content` format (from single file search without -r)
  // This happens when searching a specific file; use defaultFile as the path.
  const singleFileMatch = line.match(/^(\d+):(.*)$/s);
  if (singleFileMatch && defaultFile) {
    const lineNumber = parseLineNumber(singleFileMatch[1]);
    if (lineNumber === null) {
      return null;
    }
    return {
      file: defaultFile,
      lineNumber,
      content: singleFileMatch[2],
    };
  }

  // Context lines use `path-line-content` (rg uses `-` around the line number)
  const contextLine = line.match(/^(.+?)-(\d+)-(.*)$/s);
  if (contextLine) {
    const lineNumber = parseLineNumber(contextLine[2]);
    if (lineNumber === null) {
      return null;
    }
    return {
      file: contextLine[1],
      lineNumber,
      content: `[context] ${contextLine[3]}`,
    };
  }

  return null;
}

/**
 * Parse `rg --count` / `grep -c` output.
 *
 * Two shapes, matching {@link parseGrepLine}: `path:count` for a search over a directory (or several
 * files), and a BARE count when the search was a single file — grep omits the path there, so
 * `defaultFile` supplies it. Without that case the number was read as a file NAME with a count of
 * `0`: `grep -c` reporting 5 matches came back as "5: Count: 0".
 */
function parseCountLine(line: string, defaultFile?: string): { file: string; lineNumber: number; content: string } {
  const countMatch = line.match(/:(\d+)$/);
  const bareCount = defaultFile !== undefined ? line.match(/^(\d+)$/) : null;
  if (!countMatch && !bareCount) {
    return { file: line, lineNumber: 0, content: "Count: 0" };
  }
  const counted = countMatch ?? bareCount!;
  const count = parseLineNumber(counted[1]!) ?? 0;
  return {
    file: countMatch ? line.slice(0, -countMatch[0].length) : defaultFile!,
    lineNumber: 0,
    content: `Count: ${count}`,
  };
}

export const createGrepTool = () => {
  return defineServerTool({
    name: "grep",
    present: { category: "searches" },
    description:
      "Searches file contents using regular expressions. Returns file paths and line numbers with matching content. " +
      "Uses ripgrep (rg) when available, falls back to grep. " +
      'Use outputMode="files_with_matches" for broad searches (just file paths). ' +
      'Use outputMode="count" to get match counts per file. ' +
      "Supports pagination with offset/limit, context lines, and case-insensitive search.",
    inputSchema: z.object({
      pattern: z.string().describe("The regex pattern to search for in file contents."),
      path: z
        .string()
        .optional()
        .describe("Search directory or single file, relative to project root (default: current)."),
      include: z
        .string()
        .optional()
        .describe(
          "File pattern to include in the search (e.g., '*.js'). Brace groups such as '*.{ts,tsx}' " +
            "are expanded into one include glob per alternative. If not specified, searches all files."
        ),
      ignoreCase: z.boolean().optional().describe("If true, perform case-insensitive matching. Defaults to false."),
      offset: z
        .number()
        .int({ message: "offset: must be an integer" })
        .min(0, { message: "offset: must be >= 0 (0-indexed)" })
        .optional()
        .describe("Number of matches to skip (0-indexed). Use for pagination. Defaults to 0."),
      limit: z
        .number()
        .int({ message: "limit: must be an integer" })
        .min(1, { message: "limit: must be >= 1" })
        .max(500, { message: "limit: must be <= 500" })
        .optional()
        .describe(`Maximum number of matches to return. Defaults to ${DEFAULT_LIMIT}.`),
      outputMode: z
        .enum(["content", "files_with_matches", "count"])
        .optional()
        .describe(
          'Output mode: "content" (default, shows matching lines), ' +
            '"files_with_matches" (just file paths), "count" (match counts per file).' +
            ' Use "files_with_matches" for broad searches.'
        ),
      context: z
        .number()
        .int({ message: "context: must be an integer" })
        .min(0, { message: "context: must be >= 0" })
        .max(20, { message: "context: must be <= 20" })
        .optional()
        .describe("Lines of surrounding context per match (only with outputMode 'content'). Defaults to 0."),
    }),
    outputSchema: grepOutputSchema,
    execute: async (
      { pattern, path, include, ignoreCase, offset, limit, outputMode, context },
      { toolCallId, abortSignal, coreEnv }
    ) => {
      return withDuration(async () => {
        // Agents sometimes wrap the regex in quotes (e.g. `"extensions"`), which
        // grep treats as literal quote chars and matches nothing. Strip one pair
        // of matching outer quotes so the search behaves as the caller intended.
        const normalized = stripOuterQuotes(pattern);
        const searchPattern = normalized.pattern;

        const searchPath = resolveSearchPath(coreEnv, path);
        const skip = offset ?? 0;
        const take = limit ?? DEFAULT_LIMIT;
        const mode = outputMode ?? "content";
        const contextLines = context ?? 0;
        const fetchCount = skip + take + 1;

        // Detect whether the search path is a single file (vs directory) so we
        // can skip include/exclude flags that are only meaningful for directory
        // searches. When stat fails (path doesn't exist), treat as a directory
        // so the search still works for new/relative paths.
        let searchPathIsFile = false;
        try {
          const stat = await coreEnv.fs.stat(searchPath);
          searchPathIsFile = stat.isFile;
        } catch {
          // Non-fatal — treat as directory for backward compatibility
        }

        const searchOptions = {
          ignoreCase: ignoreCase ?? false,
          include,
          outputMode: mode,
          context: contextLines,
          fetchCount,
          searchPathIsFile,
          signal: abortSignal,
        };

        // The search is the only thing here that the run can stop, so the abort is caught where it
        // crosses that boundary. It must NOT fall through to the empty-result branch below: a search
        // that was cut short did not look, and "no matches" is a claim this tool cannot make. Same
        // contract as `run_command`/`webfetch` — settle as a normal result carrying `cancelled: true`
        // rather than throwing, because a throw renders as a tool FAILURE.
        let rawOutput: string;
        try {
          rawOutput = await runGrepSearch(coreEnv, searchPattern, searchPath, searchOptions);
        } catch (err) {
          if (!isAbortError(err, abortSignal)) throw err;
          return {
            matches: [] as { file: string; lineNumber: number; content: string }[],
            content: "",
            offset: skip,
            limit: take,
            cancelled: true,
          };
        }

        const lines = rawOutput
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

        if (lines.length === 0) {
          const hint = normalized.hadQuotes
            ? `
(no matches) — note: pattern contained quote characters (" or '); grep matches them literally, so a quoted pattern like "extensions" will not match bare extensions. Retry without the surrounding quotes if you meant a plain word.`
            : "";
          return {
            matches: [] as { file: string; lineNumber: number; content: string }[],
            content: hint.trim(),
            offset: skip,
            limit: take,
            cachedOutputPath: null,
          };
        }

        let allMatches: { file: string; lineNumber: number; content: string }[] = [];
        let totalContentLength = 0;

        if (mode === "files_with_matches") {
          allMatches = lines.map((file) => ({
            file,
            lineNumber: 0,
            content: "",
          }));
        } else if (mode === "count") {
          allMatches = lines.map((line) => parseCountLine(line, searchPathIsFile ? searchPath : undefined));
        } else {
          for (const line of lines) {
            // When searching a single file, grep outputs `line:content` (no path).
            // Pass searchPath as defaultFile so the parser can handle this format.
            const parsed = parseGrepLine(line, searchPathIsFile ? searchPath : undefined);
            if (!parsed) continue;

            if (parsed.content.length > MAX_MATCH_LINE_CHARS) {
              parsed.content = truncateMatchLine(parsed.content, MAX_MATCH_LINE_CHARS);
            }

            totalContentLength += parsed.content.length;
            if (totalContentLength > MAX_TOTAL_CONTENT) {
              parsed.content = "[content omitted - total size limit reached]";
            }

            allMatches.push(parsed);
          }
        }

        // Drop any match with an invalid line number (NaN serializes to null in JSON).
        const validMatches = allMatches.filter((m) => Number.isFinite(m.lineNumber));
        const paginatedMatches = validMatches.slice(skip, skip + take);

        const fullMatchText = paginatedMatches.map((m) => `${m.file}:${m.lineNumber}:${m.content}`).join("\n");
        const cached = await maybeCacheOutput(coreEnv, fullMatchText, `${toolCallId}-grep`);
        const { cachedOutputPath } = cached;

        // matches always carries the requested page (structured metadata for the UI
        // and external_* consumers) — `content` holds the model preview (cached head/tail
        // for large results) and `cachedOutputPath` the full text on disk.
        return {
          matches: paginatedMatches,
          content: cached.content,
          offset: skip,
          limit: take,
          cachedOutputPath,
        };
      });
    },
    // Only send matches to the LLM — search params are echoed in the input,
    // pagination/truncation/cache metadata is for the UI only.
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: GrepOutput }) {
      if (isProjectedModelContent(output)) return output;
      const lines = output.matches?.map?.((m) => `${m.file}:${m.lineNumber}: ${m.content}`);
      // A stopped search says so. Without this the model reads the (necessarily partial) matches
      // below as the complete answer to its query.
      if (output.cancelled === true) {
        return [
          {
            type: "text" as const,
            // The repo's wording for a stopped search (`websearch`) when there is nothing to show;
            // "incomplete" only qualifies a result that actually carries matches.
            content:
              lines && lines.length > 0
                ? `[Search cancelled by user — this result is incomplete.]\n${lines.join("\n")}`
                : "[Search cancelled by user.]",
          },
        ];
      }
      return [
        {
          type: "text" as const,
          content:
            `offset(current pagination): ${output.offset}; limit(Maximum number of items to return): ${output.limit}` +
            (output.content || `${output.matches?.length} matches:\n${lines?.join("\n")}`),
        },
      ];
    },
  });
};
