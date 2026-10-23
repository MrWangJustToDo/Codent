import { z } from "zod";

import { ExecutionError } from "../../../../env/types";
import { isAbortError } from "../../../../runtime-types/abort.js";
import { toPosixPath } from "../../../../utils/posix-path.js";
import { defineServerTool, isProjectedModelContent } from "../../runtime/define-tool.js";
import { maybeCacheOutput } from "../../shared/cache/tool-output-cache.js";
import { OUTPUT_LIMITS } from "../../shared/output-limits.js";
import { grepOutputSchema } from "../../shared/schemas.js";
import { withDuration } from "../../shared/tool-result.js";
import { canExecArgs, execArgs } from "../shell/exec-args.js";

import { expandBraceGlobs, matchesGlobPath, normalizeSearchPath } from "./search/glob-pattern.js";
import {
  activeExcludeDirs,
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
      const stripped = pattern.slice(1, -1);
      // `""` is an empty regex, which matches every line. Keep it literal rather than
      // turning an empty quoted search into an accidental whole-file dump.
      if (stripped.length > 0) return { pattern: stripped, hadQuotes };
    }
  }
  return { pattern, hadQuotes };
}

/** The basename part of a path-shaped include glob, for GNU grep's basename-only flag. */
function includeBasename(glob: string): string {
  return toPosixPath(glob).split("/").pop() ?? glob;
}

/** Whether an include glob carries path semantics that GNU grep's --include cannot express. */
function includeNeedsJsFilter(include: string | undefined): boolean {
  return include !== undefined && (include.includes("/") || include.includes("\\") || include.includes("**"));
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
  // Match glob's search policy: an explicit filesystem search may target `.agents`
  // and other hidden/ignored paths. Common build directories remain excluded below.
  args.push("--hidden", "--no-ignore");

  if (options.ignoreCase) {
    args.push("-i");
  }

  if (options.outputMode === "files_with_matches") {
    args.push("--files-with-matches");
  } else if (options.outputMode === "count") {
    args.push("--count");
  } else {
    // `--null` makes the file boundary unambiguous. Context output is `path-line-content`,
    // and both path and content can contain `-digits-`; without a separator, a date
    // directory like `2024-01-02/a.ts` was parsed as file `2024`, line `1`.
    args.push("--line-number", "--no-heading", "--null");
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
      // ripgrep, like fd, matches a path glob from the search root/cwd; a caller's
      // `nested/*.ts` would match nothing unless it can start at any depth. The JS
      // include filter applies the exact relative semantics afterwards.
      const normalized = glob.replace(/^\.\//, "");
      const rgGlob = normalized.includes("/") && !normalized.startsWith("**/") ? `**/${normalized}` : normalized;
      args.push("--glob", rgGlob);
    }
  }

  if (!options.searchPathIsFile) {
    for (const dir of activeExcludeDirs(searchPath)) {
      args.push("--glob", `!**/${dir}/**`);
    }
  }

  // `--` then the pattern as a single argv entry: no quoting, no escaping, and no shell
  // to reinterpret it, so a pattern containing quotes or metacharacters arrives intact.
  //
  // `--max-count` bounds the work at the source. Truncation to `fetchCount` happens in JS
  // either way (there is no `| head` any more), but without a source-side cap a search in a
  // large repository streams every match before all but the first few are discarded.
  if (options.outputMode !== "count") {
    args.push("--max-count", String(options.fetchCount));
  }
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

  if (options.outputMode === "content") {
    // Match rg's `--null`: GNU grep's context separator (`path-line-content`) is
    // ambiguous when either the path or the matched text contains `-digits-`.
    args.push("-Z");
    if (options.context > 0) {
      args.push("-C", String(options.context));
    }
  }

  // --include and --exclude-dir are only meaningful for directory searches; skip them when
  // searching a single file to avoid conflicts. Brace groups are expanded to one --include
  // per alternative since grep does not brace-expand its own --include values.
  const needsJsIncludeFilter = includeNeedsJsFilter(options.include);
  if (options.include && !options.searchPathIsFile) {
    // GNU grep's --include is basename-only. For a path glob, still give it the basename
    // as a cheap pre-filter (e.g. `nested/*.ts` → `*.ts`); the exact path semantics are
    // applied in JS after the command returns.
    for (const glob of expandBraceGlobs(options.include)) {
      args.push("--include", needsJsIncludeFilter ? includeBasename(glob) : glob);
    }
  }

  if (!options.searchPathIsFile) {
    for (const dir of activeExcludeDirs(searchPath)) {
      args.push("--exclude-dir", dir);
    }
  }

  // `-e` keeps a pattern beginning with `-` from being parsed as an option; `--` keeps
  // the search path option-safe. Count mode must not use `-m`: GNU grep applies `-m` to
  // the count per file, which returned `Count: 101` for a 1997-match file at limit=100.
  args.push("-E", "-e", pattern);
  if (options.outputMode !== "count") {
    args.push("-m", String(options.fetchCount));
  }
  args.push("--", searchPath);
  return args;
}

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
  // Context lines occupy raw lines but are not matches. Give the parser enough rows to
  // reach the requested match page; count mode must never be capped by a match limit.
  // A path-shaped include is filtered in JS *after* the command, so the source-side cap
  // must not discard candidates from not-yet-seen files either.
  const lineCap =
    options.outputMode === "count" || includeNeedsJsFilter(options.include)
      ? Number.MAX_SAFE_INTEGER
      : options.context > 0
        ? options.fetchCount * (2 * options.context + 3) + 10
        : options.fetchCount;

  const failure = (
    binary: string,
    result: { code: number | null; stderr: string; stdout: string }
  ): ExecutionError | null => {
    // rg/grep use 0 for matches and 1 for a clean no-match. A non-zero other status with
    // no stdout is a real failure (invalid regex, missing path, unreadable input), not an
    // empty result; the model must not be told "0 matches" for a search that never ran.
    if (result.code !== null && result.code !== 0 && result.code !== 1 && result.stdout.length === 0) {
      return new ExecutionError(
        "unknown",
        `${binary} failed with exit code ${result.code}: ${result.stderr.trim() || "no diagnostic output"}`
      );
    }
    return null;
  };

  if (canExecArgs(env)) {
    const rgResult = await execArgs(env, "rg", buildRgArgs(pattern, searchPath, options), {
      cwd: env.rootPath,
      signal: options.signal,
    });
    if (!rgResult.missing) {
      if (rgResult.killed && !rgResult.truncated && rgResult.stdout.length === 0) {
        throw new ExecutionError("timeout", "rg was killed before it produced a complete result");
      }
      const error = failure("rg", rgResult);
      if (error) throw error;
      return truncateLines(rgResult.stdout, lineCap);
    }

    const grepResult = await execArgs(env, "grep", buildGrepArgs(pattern, searchPath, options), {
      cwd: env.rootPath,
      signal: options.signal,
    });
    if (!grepResult.missing) {
      if (grepResult.killed && !grepResult.truncated && grepResult.stdout.length === 0) {
        throw new ExecutionError("timeout", "grep was killed before it produced a complete result");
      }
      const error = failure("grep", grepResult);
      if (error) throw error;
      return truncateLines(grepResult.stdout, lineCap);
    }
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
  if (!isCommandNotFound(rgResult.exitCode)) {
    const error = failure("rg", { code: rgResult.exitCode ?? null, stderr: rgResult.stderr, stdout: rgResult.stdout });
    if (error) throw error;
    return truncateLines(rgResult.stdout, lineCap);
  }
  const grepArgv = buildGrepArgs(pattern, searchPath, options).map(quoteForShell);
  const grepResult = await env.runCommand(`grep ${grepArgv.join(" ")}`, {
    timeout,
    cwd: env.rootPath,
    signal: options.signal,
  });
  const error = failure("grep", {
    code: grepResult.exitCode ?? null,
    stderr: grepResult.stderr,
    stdout: grepResult.stdout,
  });
  if (error) throw error;
  return truncateLines(grepResult.stdout, lineCap);
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
): { file: string; lineNumber: number; content: string; context?: boolean } | null {
  if (line === "--") {
    return null;
  }

  // `rg --null` / `grep -Z` place a NUL after the file path. The remainder is
  // `line:content` for a match or `line-content` for context, so neither a path nor
  // matched text can be mistaken for a delimiter.
  const nul = line.indexOf("\0");
  if (nul >= 0) {
    const file = line.slice(0, nul);
    const rest = line.slice(nul + 1);
    const match = rest.match(/^(\d+):(.*)$/s);
    if (match) {
      const lineNumber = parseLineNumber(match[1]!);
      if (lineNumber !== null) return { file, lineNumber, content: match[2] };
    }
    const context = rest.match(/^(\d+)-(.*)$/s);
    if (context) {
      const lineNumber = parseLineNumber(context[1]!);
      if (lineNumber !== null) {
        return { file, lineNumber, content: `[context] ${context[2]}`, context: true };
      }
    }
    return null;
  }

  // Single-file context lines are `line-content`; this must be recognized before the
  // generic `path:line:content` matcher, which would otherwise turn `12-config:30` into
  // a fictional file named `12-config`.
  if (defaultFile) {
    const singleContext = line.match(/^(\d+)-(.*)$/s);
    if (singleContext) {
      const lineNumber = parseLineNumber(singleContext[1]!);
      if (lineNumber !== null) {
        return { file: defaultFile, lineNumber, content: `[context] ${singleContext[2]}`, context: true };
      }
    }
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
      context: true,
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
      "Searches hidden/ignored paths too, while excluding common build directories. " +
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

        const searchPath = await resolveSearchPath(coreEnv, path);
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

        // Preserve leading/trailing source whitespace — it is part of a matched line.
        // Only a trailing CR is transport noise (Windows output).
        const lines = rawOutput
          .split("\n")
          .map((line) => line.replace(/\r$/, ""))
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

        let allMatches: { file: string; lineNumber: number; content: string; kind?: "match" | "context" }[] = [];
        let totalContentLength = 0;

        // `include` is omitted from the grep fallback when it contains a path glob
        // (GNU grep's --include is basename-only). Apply the same segment-aware filter
        // here for both backends; brace alternatives include `*.{ts,tsx}`.
        // A single-file path already names the file; include flags are ignored by the
        // backend in that case, so do not filter the one result away here either.
        const includePatterns = include && !searchPathIsFile ? expandBraceGlobs(include) : [];
        const includeMatch = (file: string): boolean =>
          includePatterns.length === 0 ||
          includePatterns.some((pattern) => matchesGlobPath(file, searchPath, pattern, coreEnv.rootPath));

        // Context is a structural fact, not a rendered prefix: a real match can begin with
        // the literal text `[context] `.
        if (mode === "files_with_matches") {
          allMatches = lines.map((file) => ({
            file: normalizeSearchPath(file, coreEnv),
            lineNumber: 0,
            content: "",
          }));
        } else if (mode === "count") {
          allMatches = lines
            .map((line) => parseCountLine(line, searchPathIsFile ? searchPath : undefined))
            .map((match) => ({ ...match, file: normalizeSearchPath(match.file, coreEnv) }));
        } else {
          for (const line of lines) {
            // When searching a single file, grep outputs `line:content` (no path).
            // Pass searchPath as defaultFile so the parser can handle this format.
            const parsed = parseGrepLine(line, searchPathIsFile ? searchPath : undefined);
            if (!parsed) continue;

            const { context: isContextLine, ...fields } = parsed;
            const entry: { file: string; lineNumber: number; content: string; kind?: "match" | "context" } = {
              ...fields,
              file: normalizeSearchPath(parsed.file, coreEnv),
              kind: isContextLine ? "context" : "match",
            };
            if (!includeMatch(entry.file)) continue;

            if (parsed.content.length > MAX_MATCH_LINE_CHARS) {
              entry.content = truncateMatchLine(parsed.content, MAX_MATCH_LINE_CHARS);
            }

            totalContentLength += entry.content.length;
            if (totalContentLength > MAX_TOTAL_CONTENT) {
              entry.content = "[content omitted - total size limit reached]";
            }

            allMatches.push(entry);
          }
        }

        const filteredMatches =
          mode === "content"
            ? allMatches
            : includePatterns.length === 0
              ? allMatches
              : allMatches.filter((match) => includeMatch(match.file));

        const withoutZeroCounts =
          mode === "count" ? filteredMatches.filter((match) => match.content !== "Count: 0") : filteredMatches;

        // Drop any match with an invalid line number (NaN serializes to null in JSON).
        const validMatches = withoutZeroCounts.filter((m) => Number.isFinite(m.lineNumber));
        const actualMatches = validMatches.filter((match) => match.kind !== "context");
        const selectedMatches = actualMatches.slice(skip, skip + take);
        let paginatedMatches = selectedMatches;
        if (mode === "content" && contextLines > 0 && selectedMatches.length > 0) {
          // Include the context rows immediately before the first selected match and after
          // the last one too. Slicing from `first` to `last` alone lost both boundaries
          // (and returned no context at all when only one match was selected).
          const indexes = new Set<number>();
          for (const selected of selectedMatches) {
            const index = validMatches.indexOf(selected);
            if (index < 0) continue;
            indexes.add(index);
            let before = 0;
            for (let i = index - 1; i >= 0 && before < contextLines; i--) {
              const candidate = validMatches[i]!;
              if (candidate.kind !== "context") break;
              indexes.add(i);
              before++;
            }
            let after = 0;
            for (let i = index + 1; i < validMatches.length && after < contextLines; i++) {
              const candidate = validMatches[i]!;
              if (candidate.kind !== "context") break;
              indexes.add(i);
              after++;
            }
          }
          paginatedMatches = [...indexes]
            .sort((a, b) => a - b)
            .map((index) => validMatches[index]!)
            .filter((match): match is (typeof validMatches)[number] => match !== undefined);
        }

        const fullMatchText =
          mode === "files_with_matches"
            ? paginatedMatches.map((m) => m.file).join("\n")
            : mode === "count"
              ? paginatedMatches.map((m) => `${m.file}: ${m.content.slice("Count: ".length)}`).join("\n")
              : paginatedMatches.map((m) => `${m.file}:${m.lineNumber}:${m.content}`).join("\n");
        const cached = await maybeCacheOutput(coreEnv, fullMatchText, `${toolCallId}-grep`, { pageOnly: true });
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
      const matches = output.matches ?? [];
      // Context rows are additional display lines; `limit`/`offset` count only real matches.
      const actualMatches = matches.filter((m) => m.kind !== "context");
      const isFilesMode =
        actualMatches.length > 0 && actualMatches.every((m) => m.lineNumber === 0 && m.content === "");
      const body = output.content
        ? output.content
        : isFilesMode
          ? `${actualMatches.length} files:\n${actualMatches.map((m) => m.file).join("\n")}`
          : `${actualMatches.length} matches:\n${lines?.join("\n")}`;
      return [
        {
          type: "text" as const,
          content:
            `offset(current pagination): ${output.offset}; limit(Maximum number of items to return): ${output.limit}\n` +
            body,
        },
      ];
    },
  });
};
