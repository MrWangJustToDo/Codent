import { z } from "zod";

import { defaultPath } from "../../../../env";
import { ExecutionError } from "../../../../env/types";
import { isAbortError } from "../../../../runtime-types/abort.js";
import { toPosixPath } from "../../../../utils/posix-path.js";
import { defineServerTool, isProjectedModelContent } from "../../runtime/define-tool.js";
import { maybeCacheOutput } from "../../shared/cache/tool-output-cache.js";
import { OUTPUT_LIMITS } from "../../shared/output-limits.js";
import { globOutputSchema } from "../../shared/schemas.js";
import { withDuration } from "../../shared/tool-result.js";
import { canExecArgs, execArgs } from "../shell/exec-args.js";

import { expandBraceGlobs, filterGlobOutput, findPathPattern, normalizeExcludePattern } from "./search/glob-pattern.js";
import {
  activeExcludeDirs,
  formatSearchModelOutput,
  SEARCH_COMMAND_TIMEOUT,
  isCommandNotFound,
  quoteForShell,
  resolveSearchPath,
} from "./search/search-command.js";

import type { CoreEnv } from "../../../../env";
import type { GlobOutput } from "../../shared/schemas.js";

/** Default number of files to return per page */
const DEFAULT_LIMIT = OUTPUT_LIMITS.MAX_ARRAY_ITEMS;

/**
 * Build `fd` arguments.
 *
 * Returned as an array, never a joined string: the pattern and exclude values are passed
 * as discrete argv entries, so a pattern containing spaces, quotes, or shell
 * metacharacters cannot be reinterpreted by a shell — and there is no shell to reinterpret
 * it. The previous version quoted them into a command string, which only worked because
 * bash was always the shell.
 */
function buildFdArgs(
  pattern: string,
  searchPath: string,
  options: {
    type: string;
    exclude: string | undefined;
    absoluteSearchPath?: string;
  }
): string[] {
  const args: string[] = ["--color=never"];

  if (options.type === "directory") {
    args.push("--type", "directory");
  } else if (options.type === "file") {
    args.push("--type", "file");
  }

  // `fd --glob` matches a basename unless `--full-path` is present. A pattern with a
  // directory segment (`packages/*/package.json`, `.agents/**`) would otherwise silently
  // match nothing. Prefix a path pattern with `**/` so it can start at any depth; the
  // JS result filter applies the exact segment semantics afterwards.
  const normalized = pattern.replace(/^\.\//, "");
  const hasPathSegment = normalized.includes("/");
  // Anchor full-path patterns to the search root instead of `**/`. The latter finds a
  // path segment at any depth, so a huge repository can spend the capture budget on
  // irrelevant `dist`/`tmp` trees before the real page. Absolute patterns are accepted by
  // fd's --full-path on every supported version; the JS filter still owns exact semantics.
  const absoluteRoot = options.absoluteSearchPath?.replace(/\/+$/, "");
  const fdPattern =
    hasPathSegment && absoluteRoot
      ? `${absoluteRoot}/${normalized.replace(/^\/+/, "")}`
      : hasPathSegment && !normalized.startsWith("**/")
        ? `**/${normalized}`
        : normalized;
  args.push("--glob", fdPattern);
  // With `--full-path`, `*.json` is matched against `./package.json`, where `*` cannot
  // cross the leading slash and therefore finds nothing. Only switch on full-path mode
  // for path patterns; basename patterns keep fd's native basename matching.
  if (hasPathSegment) {
    args.push("--full-path");
  }
  // `glob` is a filesystem query, not a git query: `.agents/**` and other intentionally
  // ignored/hidden trees are valid targets. Keep the common build/cache exclusions below.
  args.push("--hidden", "--no-ignore");

  for (const dir of activeExcludeDirs(searchPath)) {
    args.push("--exclude", dir);
  }

  if (options.exclude && !options.exclude.includes("/") && !options.exclude.includes("**")) {
    // Path-shaped excludes are filtered in JS; fd's --exclude is basename-oriented and
    // disagreed with find for values like `src/*.ts`.
    args.push("--exclude", options.exclude);
  }

  args.push(searchPath);
  return args;
}

/** Both `fd` spellings: `fd` upstream, `fdfind` on Debian/Ubuntu. */
const FD_BINARIES = ["fd", "fdfind"];

/**
 * `find` arguments, as an argv vector.
 */
function buildFindArgs(
  pattern: string,
  searchPath: string,
  options: { type: string; exclude: string | undefined }
): string[] {
  const typeFlag = options.type === "directory" ? "d" : options.type === "file" ? "f" : undefined;
  const namePattern = pattern.includes("**") ? pattern.replace(/\*\*\//g, "") : pattern;
  const hasPathSeparator = pattern.includes("/");

  const args: string[] = [searchPath];
  if (typeFlag) args.push("-type", typeFlag);
  if (hasPathSeparator) {
    // `find` prints paths relative to cwd, including the leading `./` when searching `.`.
    // A path pattern without that prefix therefore never matches a relative literal path
    // (`packages/core/src/index.ts`) or `.agents/**`.
    const prefix = searchPath === "." ? "./" : `${searchPath.replace(/\/+$/, "")}/`;
    args.push("-path", `${prefix}${findPathPattern(pattern.replace(/^\.\//, ""))}`);
  } else {
    args.push("-name", namePattern);
  }

  for (const dir of activeExcludeDirs(searchPath)) {
    args.push("-not", "-path", `*/${dir}/*`, "-not", "-path", `*/${dir}`);
  }
  if (options.exclude && !options.exclude.includes("/") && !options.exclude.includes("**")) {
    // Simple basename excludes get a command-side pre-filter. Path-shaped excludes are
    // applied by the JS result filter, where fd and find cannot disagree.
    args.push(
      "-not",
      "-path",
      `*/${options.exclude}/*`,
      "-not",
      "-path",
      `*/${options.exclude}`,
      "-not",
      "-name",
      options.exclude
    );
  }

  return args;
}

/**
 * Run the glob search, preferring `fd` and falling back to `find`.
 *
 * Availability, not failure, drives the fallback: binaries are probed before spawning (and
 * the spawn result re-checked) rather than relying on exit code 127, which is POSIX-only
 * for "command not found" — cmd.exe reports 9009 and PowerShell reports 1, so the
 * code-based check never fired on Windows and a missing `fd` surfaced as an empty result.
 *
 * Truncation to `fetchCount` happens in JS on both paths.
 */
async function runGlobSearch(
  env: CoreEnv,
  pattern: string,
  searchPath: string,
  options: {
    type: string;
    exclude: string | undefined;
    absoluteSearchPath?: string;
    fetchCount: number;
    signal?: AbortSignal;
  }
): Promise<string> {
  if (canExecArgs(env)) {
    for (const binary of FD_BINARIES) {
      const result = await execArgs(env, binary, buildFdArgs(pattern, searchPath, options), {
        cwd: env.rootPath,
        signal: options.signal,
      });
      if (result.missing) continue;
      if (result.killed && !result.truncated && result.stdout.length === 0) {
        throw new ExecutionError("timeout", `${binary} was killed before it produced a complete result`);
      }
      // fd exits 1 for a clean no-match, but a malformed glob also exits non-zero with
      // a diagnostic and no stdout. Treat any such diagnostic-bearing result as "this
      // candidate cannot answer" and let find try the same pattern instead of returning
      // a false empty result.
      if (result.code !== 0 && result.stdout.length === 0 && result.stderr.length > 0) {
        continue;
      }
      return filterGlobOutput(result.stdout, pattern, searchPath, options.fetchCount, env, options.exclude);
    }
    const findResult = await execArgs(env, "find", buildFindArgs(pattern, searchPath, options), {
      cwd: env.rootPath,
      signal: options.signal,
    });
    if (findResult.missing) {
      // No search binary is installed. Keep the existing graceful-degrade behaviour;
      // "no candidates" is still a better answer than crashing the tool.
      return "";
    }
    if (findResult.killed && !findResult.truncated && findResult.stdout.length === 0) {
      throw new ExecutionError("timeout", "find was killed before it produced a complete result");
    }
    // `find` uses 0 even for no matches. A non-zero status with no stdout is a real
    // failure (missing path, unreadable root, bad predicate), not an empty result.
    if (findResult.code !== 0 && findResult.stdout.length === 0) {
      throw new ExecutionError(
        "unknown",
        `find failed with exit code ${findResult.code}: ${findResult.stderr.trim() || "no diagnostic output"}`
      );
    }
    return filterGlobOutput(findResult.stdout, pattern, searchPath, options.fetchCount, env, options.exclude);
  }

  // Legacy path for hosts without argument-vector execution (task 1.7): the same argv,
  // joined and quoted, with truncation still in JS.
  for (const binary of FD_BINARIES) {
    const argv = buildFdArgs(pattern, searchPath, options).map(quoteForShell);
    const result = await env.runCommand(`${binary} ${argv.join(" ")}`, {
      timeout: SEARCH_COMMAND_TIMEOUT,
      cwd: env.rootPath,
      signal: options.signal,
    });
    if (!isCommandNotFound(result.exitCode)) {
      if (result.exitCode !== 0 && !result.stdout && result.stderr) continue;
      return filterGlobOutput(result.stdout, pattern, searchPath, options.fetchCount, env, options.exclude);
    }
  }
  const findArgv = buildFindArgs(pattern, searchPath, options).map(quoteForShell);
  const findResult = await env.runCommand(`find ${findArgv.join(" ")}`, {
    timeout: SEARCH_COMMAND_TIMEOUT,
    cwd: env.rootPath,
    signal: options.signal,
  });
  if (isCommandNotFound(findResult.exitCode)) return "";
  if (findResult.exitCode !== 0 && !findResult.stdout) {
    throw new ExecutionError(
      "unknown",
      `find failed with exit code ${findResult.exitCode ?? "unknown"}: ${findResult.stderr.trim() || "no diagnostic output"}`
    );
  }
  return filterGlobOutput(findResult.stdout, pattern, searchPath, options.fetchCount, env, options.exclude);
}

export const createGlobTool = () => {
  return defineServerTool({
    name: "glob",
    present: { category: "searches" },
    description:
      "Finds paths matching a glob pattern (e.g. '**/*.ts', 'src/**/*.json'). Prefer over tree/list_file when you know a filename pattern; use grep to search file contents. " +
      "Uses `fd` when available (includes hidden/ignored paths, excluding common build dirs), falls back to `find`. " +
      "Supports pagination, type filtering (file/directory), and automatic exclusion of common non-source directories.",
    inputSchema: z.object({
      pattern: z
        .string()
        .describe("Glob pattern, relative to `path` (e.g. '**/*.js', 'src/**/*.ts'); use `**/` prefix for any depth."),
      path: z.string().optional().describe("Search directory, relative to project root (default: current)."),
      type: z
        .enum(["file", "directory", "all"])
        .optional()
        .describe("Type of entries to find: 'file' (default), 'directory', or 'all' for both."),
      offset: z
        .number()
        .int({ message: "offset: must be an integer" })
        .min(0, { message: "offset: must be >= 0 (0-indexed)" })
        .optional()
        .describe("Number of files to skip (0-indexed). Use for pagination. Defaults to 0."),
      limit: z
        .number()
        .int({ message: "limit: must be an integer" })
        .min(1, { message: "limit: must be >= 1" })
        .max(DEFAULT_LIMIT, { message: "limit: exceeds maximum" })
        .optional()
        .describe(`Maximum number of files to return. Defaults to ${DEFAULT_LIMIT}.`),
      exclude: z
        .string()
        .optional()
        .describe("Additional directory or file pattern to exclude (e.g., 'vendor', '*.log')."),
    }),
    outputSchema: globOutputSchema,
    execute: async ({ pattern, path, type, offset, limit, exclude }, { toolCallId, abortSignal, coreEnv }) => {
      return withDuration(async () => {
        const searchPath = await resolveSearchPath(coreEnv, path);
        const skip = offset ?? 0;
        const take = limit ?? DEFAULT_LIMIT;
        // A trailing slash is the conventional directory spelling (`src/`, `src/**/`).
        // Strip it before matching and treat it as a directory query; otherwise the
        // command-side pattern literally required a path ending in `/`, which no result has.
        const directoryPattern = pattern.length > 1 && pattern.endsWith("/");
        const effectivePattern = directoryPattern ? pattern.replace(/\/+$/, "") : pattern;
        const fileType = directoryPattern ? "directory" : (type ?? "file");
        const fetchCount = skip + take + 1;
        const normalizedExclude = exclude ? normalizeExcludePattern(exclude) : undefined;
        const absoluteSearchPath = toPosixPath((coreEnv.path ?? defaultPath).resolve(coreEnv.rootPath, searchPath));

        const searchOptions = {
          type: fileType,
          exclude: normalizedExclude,
          absoluteSearchPath,
          offset: skip,
          limit: take,
          fetchCount,
          signal: abortSignal,
        };

        // Same contract as grep's: a run abort is a cancel, never "no files found" — see the note
        // there. `resolveSearchPath` reads the path only, so the search is the only stoppable step.
        let rawOutput: string;
        try {
          const patterns = expandBraceGlobs(effectivePattern);
          const parts = await Promise.all(
            patterns.map((candidate) => runGlobSearch(coreEnv, candidate, searchPath, searchOptions))
          );
          rawOutput = [...new Set(parts.flatMap((part) => part.split("\n").filter(Boolean)))].join("\n");
        } catch (err) {
          if (!isAbortError(err, abortSignal)) throw err;
          return {
            files: [] as string[],
            content: "",
            offset: skip,
            limit: take,
            cancelled: true,
          };
        }

        const allFiles = rawOutput
          .split("\n")
          .map((line) => line.replace(/\r$/, ""))
          .filter((line) => line.length > 0);

        if (allFiles.length === 0) {
          return {
            files: [] as string[],
            content: "",
            offset: skip,
            limit: take,
            cachedOutputPath: null,
          };
        }

        const paginatedFiles = allFiles.slice(skip, skip + take);

        const fullOutputText = paginatedFiles.join("\n");
        const cached = await maybeCacheOutput(coreEnv, fullOutputText, `${toolCallId}-glob`, { pageOnly: true });
        const { cachedOutputPath } = cached;

        // files always carries the requested page (structured metadata for the UI
        // and external_* consumers) — `content` holds the model preview (cached
        // head/tail for large results) and `cachedOutputPath` the full list on disk.
        return {
          files: paginatedFiles,
          content: cached.content,
          offset: skip,
          limit: take,
          cachedOutputPath,
        };
      });
    },
    // Only send the file list to the LLM — pattern/path are echoed in the
    // input, pagination/truncation/cache metadata is for the UI only.
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: GlobOutput }) {
      if (isProjectedModelContent(output)) return output;
      const rows = output.files ?? [];
      return [
        {
          type: "text" as const,
          content: formatSearchModelOutput({
            cancelled: output.cancelled,
            rows,
            offset: output.offset,
            limit: output.limit,
            body: output.content || rows.join("\n"),
          }),
        },
      ];
    },
  });
};
