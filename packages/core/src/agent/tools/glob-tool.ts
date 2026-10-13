import { z } from "zod";

import { defineServerTool, isProjectedModelContent } from "./runtime/define-tool.js";
import { canExecArgs, execArgsCapture } from "./util/exec-args.js";
import { OUTPUT_LIMITS } from "./util/output-limits.js";
import {
  DEFAULT_EXCLUDE_DIRS,
  SEARCH_COMMAND_TIMEOUT,
  isCommandNotFound,
  quoteForShell,
  resolveSearchPath,
  truncateLines,
} from "./util/search-command.js";
import { maybeCacheOutput } from "./util/tool-output-cache.js";
import { withDuration } from "./util/tool-result.js";
import { globOutputSchema } from "./util/types.js";

import type { CoreEnv } from "../../env";
import type { GlobOutput } from "./util/types.js";

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
  }
): string[] {
  const args: string[] = ["--color=never"];

  if (options.type === "directory") {
    args.push("--type", "directory");
  } else if (options.type === "file") {
    args.push("--type", "file");
  }

  args.push("--glob", pattern);

  for (const dir of DEFAULT_EXCLUDE_DIRS) {
    args.push("--exclude", dir);
  }

  if (options.exclude) {
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
    args.push("-path", pattern.replace(/\*\*/g, "*"));
  } else {
    args.push("-name", namePattern);
  }

  for (const dir of [...DEFAULT_EXCLUDE_DIRS, ...(options.exclude ? [options.exclude] : [])]) {
    args.push("-not", "-path", `*/${dir}/*`, "-not", "-path", `*/${dir}`);
  }

  return args;
}

/**
 * POSIX-quote one argument for the legacy shell path.
 *
 * Only reached when the host cannot execute with an argv vector — a remote environment on a
 * server that predates the exec-file route. That makes this a compatibility shim, so it
 * keeps the POSIX assumption the previous implementation already made. It must not
 * reintroduce a `pipefail` prefix, stderr redirection, or a `head` pipeline: truncation
 * stays in JS on both paths so the shell is never responsible for correctness.
 */
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
    fetchCount: number;
  }
): Promise<string> {
  if (canExecArgs(env)) {
    for (const binary of FD_BINARIES) {
      const stdout = await execArgsCapture(env, binary, buildFdArgs(pattern, searchPath, options), {
        cwd: env.rootPath,
      });
      if (stdout !== undefined) return truncateLines(stdout, options.fetchCount);
    }
    const findStdout = await execArgsCapture(env, "find", buildFindArgs(pattern, searchPath, options), {
      cwd: env.rootPath,
    });
    if (findStdout !== undefined) return truncateLines(findStdout, options.fetchCount);
    // Both binaries are absent — an empty result is the honest answer. Falling through to
    // the shell path would only re-attempt the same missing binaries.
    return "";
  }

  // Legacy path for hosts without argument-vector execution (task 1.7): the same argv,
  // joined and quoted, with truncation still in JS.
  for (const binary of FD_BINARIES) {
    const argv = buildFdArgs(pattern, searchPath, options).map(quoteForShell);
    const result = await env.runCommand(`${binary} ${argv.join(" ")}`, {
      timeout: SEARCH_COMMAND_TIMEOUT,
      cwd: env.rootPath,
    });
    if (!isCommandNotFound(result.exitCode)) return truncateLines(result.stdout, options.fetchCount);
  }
  const findArgv = buildFindArgs(pattern, searchPath, options).map(quoteForShell);
  const findResult = await env.runCommand(`find ${findArgv.join(" ")}`, {
    timeout: SEARCH_COMMAND_TIMEOUT,
    cwd: env.rootPath,
  });
  return truncateLines(findResult.stdout, options.fetchCount);
}

export const createGlobTool = () => {
  return defineServerTool({
    name: "glob",
    present: { category: "searches" },
    description:
      "Finds paths matching a glob pattern (e.g. '**/*.ts', 'src/**/*.json'). Prefer over tree/list_file when you know a filename pattern; use grep to search file contents. " +
      "Uses `fd` when available (respects .gitignore), falls back to `find`. " +
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
    execute: async ({ pattern, path, type, offset, limit, exclude }, { toolCallId, coreEnv }) => {
      return withDuration(async () => {
        const searchPath = resolveSearchPath(coreEnv, path);
        const skip = offset ?? 0;
        const take = limit ?? DEFAULT_LIMIT;
        const fileType = type ?? "file";
        const fetchCount = skip + take + 1;

        const searchOptions = {
          type: fileType,
          exclude,
          offset: skip,
          limit: take,
          fetchCount,
        };

        const rawOutput = await runGlobSearch(coreEnv, pattern, searchPath, searchOptions);

        const allFiles = rawOutput
          .split("\n")
          .map((line) => line.trim())
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
        const cached = await maybeCacheOutput(coreEnv, fullOutputText, `${toolCallId}-glob`);
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
      return [
        {
          type: "text" as const,
          content:
            `offset(current pagination): ${output.offset}; limit(Maximum number of items to return): ${output.limit}` +
            (output.content || output.files?.join("\n")),
        },
      ];
    },
  });
};
