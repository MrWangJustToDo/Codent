import { z } from "zod";

import { isAbortError } from "../../../../runtime-types/abort.js";
import { defineServerTool, isProjectedModelContent } from "../../runtime/define-tool.js";
import { maybeCacheOutput } from "../../shared/cache/tool-output-cache.js";
import { OUTPUT_LIMITS } from "../../shared/output-limits.js";
import { grepOutputSchema } from "../../shared/schemas.js";
import { withDuration } from "../../shared/tool-result.js";

import { expandBraceGlobs, matchesGlobPath, normalizeSearchPath } from "./search/glob-pattern.js";
import { parseCountLine, parseGrepLine, runGrepSearch } from "./search/grep-search.js";
import { formatSearchModelOutput, resolveSearchPath } from "./search/search-command.js";
import { activeExcludeDirs, defaultSearchPolicy, searchTargetBypassesIgnore } from "./search/search-policy.js";

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

export const createGrepTool = () => {
  return defineServerTool({
    name: "grep",
    present: { category: "searches" },
    description:
      "Searches file contents using regular expressions. Returns file paths and line numbers with matching content. " +
      "Uses ripgrep (rg) when available, then git grep, then grep. " +
      'Use outputMode="files_with_matches" for broad searches (just file paths). ' +
      'Use outputMode="count" to get match counts per file. ' +
      "Respects the repository's ignore rules (.gitignore) and skips common build, dependency and " +
      "agent-runtime directories; hidden files are still searched. Pass `path` to search inside an " +
      "ignored directory (e.g. generated output or session logs) — an explicit path overrides the " +
      "ignore rules for that subtree. " +
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

        // One policy for every engine (rg / git grep / grep): which trees are never source, and
        // whether the repository's own ignore rules apply. `noIgnore` is the ONE deliberate
        // exception — an explicitly targeted tree that those rules would otherwise skip.
        const policy = defaultSearchPolicy();
        const excludeDirs = activeExcludeDirs(searchPath, policy);
        const noIgnore = await searchTargetBypassesIgnore(coreEnv, policy, searchPath, {
          isFile: searchPathIsFile,
          signal: abortSignal,
        });

        const searchOptions = {
          ignoreCase: ignoreCase ?? false,
          include,
          outputMode: mode,
          context: contextLines,
          fetchCount,
          searchPathIsFile,
          policy,
          excludeDirs,
          noIgnore,
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
      const lines = output.matches?.map?.((m) => `${m.file}:${m.lineNumber}: ${m.content}`) ?? [];
      // A stopped search says so. Without this the model reads the (necessarily partial) matches
      // below as the complete answer to its query.
      if (output.cancelled === true) {
        return [
          {
            type: "text" as const,
            content: formatSearchModelOutput({
              cancelled: true,
              rows: lines,
              offset: output.offset,
              limit: output.limit,
            }),
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
          : `${actualMatches.length} matches:\n${lines.join("\n")}`;
      return [
        {
          type: "text" as const,
          content: formatSearchModelOutput({
            rows: lines,
            offset: output.offset,
            limit: output.limit,
            body,
          }),
        },
      ];
    },
  });
};
