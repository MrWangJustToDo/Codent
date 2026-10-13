import { z } from "zod";

import { getEnv, type CoreEnvFs } from "../../env";
import { toPosixPath, toPosixPathKey } from "../../utils/posix-path.js";

import { defineServerTool } from "./runtime/define-tool.js";
import { canExecArgs, execArgs } from "./util/exec-args.js";
import { OUTPUT_LIMITS, truncateString } from "./util/output-limits.js";
import { isCommandNotFound, quoteForShell, resolveSearchPath } from "./util/search-command.js";
import { maybeCacheOutput } from "./util/tool-output-cache.js";
import { withDuration } from "./util/tool-result.js";
import { toolOutputBaseSchema } from "./util/types.js";

/** Maximum characters for tree output */
const MAX_TREE_CHARS = OUTPUT_LIMITS.MAX_CONTENT_CHARS;

/** Maximum entries to show in tree */
const MAX_TREE_ENTRIES = OUTPUT_LIMITS.MAX_ARRAY_ITEMS;

/** Options for the native directory walk used when no `tree` binary is available. */
export interface WalkTreeOptions {
  maxDepth: number;
  dirsOnly: boolean;
  showHidden: boolean;
  pattern: string | undefined;
  ignore: string[];
  /** Injectable for testing; defaults to the registered environment's filesystem. */
  fs?: CoreEnvFs;
  /**
   * Injectable for testing only — the production call path never sets it, because the
   * `relative` list this builds is separator-agnostic by construction (see the `join`
   * default). It exists so a test can drive a win32-shaped walk on Linux.
   */
  join?: (parent: string, child: string) => string;
}

/**
 * Walk a directory tree, returning sorted root-relative paths.
 *
 * Used as the `tree` fallback. Implemented over `env.fs` rather than `find` because the
 * `-maxdepth` flag the previous version relied on is a GNU extension that BSD `find` (macOS)
 * and BusyBox reject — a fallback that only works on one platform is not a fallback.
 *
 * Depth counts entries below the root, matching `tree -L <n>`. The root itself is not an
 * entry, so an empty (or fully filtered) directory yields an empty list, which is the honest
 * answer and what `tree` prints for such a directory.
 */
export async function walkTree(rootPath: string, options: WalkTreeOptions): Promise<string[]> {
  const fs = options.fs ?? getEnv().fs;
  const join = options.join ?? ((parent: string, child: string) => `${parent.replace(/[/\\]+$/, "")}/${child}`);
  const results: string[] = [];

  const visit = async (dir: string, relativeDir: string, depth: number): Promise<void> => {
    if (depth > options.maxDepth || results.length >= MAX_TREE_ENTRIES) return;

    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch {
      // Unreadable directory (permissions, race) is skipped rather than failing the whole
      // walk — `find` printed a warning and continued, and a partial tree is more useful than
      // an error.
      return;
    }

    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (results.length >= MAX_TREE_ENTRIES) return;

      const isDirectory = entry.type === "directory";
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      // Pruning filters, matching `find -not -path '*/X/*'`: a hidden or ignored entry is
      // removed *with its subtree*. This is what makes them different from the two filters
      // below, which only decide whether to report an entry.
      if (!options.showHidden && entry.name.startsWith(".")) continue;
      if (options.ignore.some((ig) => entry.name === ig)) continue;

      // Report filters. These MUST NOT skip the recursion: `find -name '*.ts'` descends into
      // every directory and matches at any depth, so a directory whose own name does not match
      // is still walked. Pruning here instead silently yielded an empty tree for any pattern
      // that no directory happens to match (e.g. `*.ts`).
      const reported =
        !(options.dirsOnly && !isDirectory) && !(options.pattern && !matchesGlobPattern(entry.name, options.pattern));
      if (reported) results.push(relative);

      if (isDirectory) await visit(join(dir, entry.name), relative, depth + 1);
    }
  };

  await visit(rootPath, "", 1);
  return results.sort().slice(0, MAX_TREE_ENTRIES);
}

/**
 * Match a basename against the glob `tree -P` accepts: `*` and `?` wildcards, literal rest.
 *
 * A bare pattern with no wildcard is an exact match, which is also how `tree -P` treats it.
 */
function matchesGlobPattern(name: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Creates a tree tool for displaying directory structure.
 *
 * This tool displays the directory tree structure in a hierarchical format.
 * Useful for understanding project structure.
 */
export const createTreeTool = () => {
  return defineServerTool({
    name: "tree",
    present: { category: "reads" },
    description:
      "Shows a hierarchical directory tree (structure overview). Prefer over list_file when you need depth/layout; use list_file for one-level detail with sizes/dates; use glob to find paths by pattern.",
    inputSchema: z.object({
      path: z.string().optional().describe("Root directory to display tree from (default: current)."),
      maxDepth: z
        .number()
        .int({ message: "maxDepth: must be an integer" })
        .min(1, { message: "maxDepth: must be >= 1" })
        .max(10, { message: "maxDepth: must be <= 10" })
        .optional()
        .describe("Maximum depth to traverse. Defaults to 3."),
      showHidden: z
        .boolean()
        .optional()
        .describe("Whether to show hidden files (starting with dot). Defaults to false."),
      dirsOnly: z.boolean().optional().describe("Only show directories, not files. Defaults to false."),
      pattern: z
        .string()
        .optional()
        .describe("Only show files matching this pattern, relative to `path` (e.g. '*.ts', '*.js')."),
      ignore: z.array(z.string()).optional().describe("Patterns to ignore (e.g., ['node_modules', '.git', 'dist'])."),
    }),
    outputSchema: z.object({
      path: z.string().describe("The root directory that was displayed."),
      maxDepth: z.number().describe("The maximum depth that was traversed."),
      tree: z.string().describe("The tree structure as a formatted string."),
      totalEntries: z.number().describe("Total number of entries (files and directories) shown."),
      truncated: z.boolean().describe("Whether the tree output was truncated."),
      durationMs: z.number().describe("Execution duration in milliseconds."),
      ...toolOutputBaseSchema.shape,
    }),
    execute: async ({ path, maxDepth, showHidden, dirsOnly, pattern, ignore }, { toolCallId, coreEnv }) => {
      return withDuration(async () => {
        const rootPath = resolveSearchPath(coreEnv, path);
        const depth = maxDepth ?? 3;

        // Build `tree` arguments. argv, not a command string — the previous version
        // appended `2>/dev/null` and quoted values into a shell command, which is a parse
        // error outside POSIX shells (cmd.exe uses `2>nul`, PowerShell uses neither form).
        const treeArgs: string[] = [rootPath, "-L", String(depth)];

        if (!showHidden) {
          treeArgs.push("-I", ".*");
        }

        if (dirsOnly) {
          treeArgs.push("-d");
        }

        if (pattern) {
          treeArgs.push("-P", pattern);
        }

        if (ignore && ignore.length > 0) {
          treeArgs.push("-I", ignore.join("|"));
        }

        treeArgs.push("--noreport");

        // `exitCode` is deliberately not carried: the fallback below keys on `missing`/`killed`
        // only, and `tree` exits non-zero in normal operation (see the comment there), so a
        // status field here would be write-only.
        let result: { stdout: string; stderr: string; missing: boolean; killed: boolean };
        if (canExecArgs(coreEnv)) {
          const argsResult = await execArgs(coreEnv, "tree", treeArgs, { cwd: coreEnv.rootPath });
          result = {
            stdout: argsResult.stdout,
            stderr: argsResult.stderr,
            missing: argsResult.missing,
            killed: argsResult.killed,
          };
        } else {
          const envResult = await coreEnv.runCommand(`tree ${treeArgs.map(quoteForShell).join(" ")}`, {
            cwd: coreEnv.rootPath,
          });
          // The string path has no kill signal of its own; a shell reports a killed child as a
          // non-zero status, so there is nothing extra to distinguish here.
          result = {
            stdout: envResult.stdout,
            stderr: envResult.stderr,
            missing: isCommandNotFound(envResult.exitCode),
            killed: false,
          };
        }

        // Fall back when `tree` could not run. Two conditions, deliberately narrow:
        //
        //   - `missing` — the binary is not installed
        //   - `killed` — the call was terminated, so there is no usable output
        //
        // A non-zero exit is NOT one of them. `tree` exits non-zero in normal operation
        // (the manpage notes that `-I`/`-P`/`--filelimit` pruning "will lead to incorrect
        // file/directory count reports", and it also warns on unreadable directories), and
        // its stdout is still the tree the user asked for. Falling back there would replace
        // it with `walkTree`, whose `-I`-equivalent ignore only matches exact names — a
        // different tree with a different meaning. An empty stdout is an answer too: a bare
        // directory legitimately produces none.
        if (result.missing || result.killed) {
          // The fallback walks the filesystem directly instead of spawning `find`.
          //
          // `-maxdepth` is the reason: it is a GNU extension. BSD `find` (macOS) and BusyBox
          // reject it outright, so the fallback could not work on two of the three platforms
          // this tool runs on. `env.fs.readdir` is the same primitive the skill loader already
          // uses, and it removes an external dependency rather than adding a platform branch.
          const paths = await walkTree(rootPath, {
            fs: coreEnv.fs,
            maxDepth: depth,
            dirsOnly: dirsOnly ?? false,
            showHidden: showHidden ?? false,
            pattern,
            ignore: ignore ?? [],
          });
          const rawTree = formatAsTree(paths, rootPath);

          const cached = await maybeCacheOutput(coreEnv, rawTree, `${toolCallId}-tree`);
          let tree: string;
          let truncated: boolean;
          if (cached.cachedOutputPath) {
            tree = cached.content;
            truncated = true;
          } else {
            ({ text: tree, truncated } = truncateString(rawTree, MAX_TREE_CHARS));
          }

          return {
            path: rootPath,
            maxDepth: depth,
            tree,
            totalEntries: paths.length,
            truncated,
            cachedOutputPath: cached.cachedOutputPath,
          };
        }

        const lines = result.stdout.split("\n").filter((l) => l.trim());

        const cached = await maybeCacheOutput(coreEnv, result.stdout, `${toolCallId}-tree`);
        let truncatedTree: string;
        let truncated: boolean;
        if (cached.cachedOutputPath) {
          truncatedTree = cached.content;
          truncated = true;
        } else {
          ({ text: truncatedTree, truncated } = truncateString(result.stdout, MAX_TREE_CHARS));
        }

        return {
          path: rootPath,
          maxDepth: depth,
          tree: truncatedTree,
          totalEntries: lines.length,
          truncated,
          cachedOutputPath: cached.cachedOutputPath,
        };
      });
    },
    // Only send the tree text to the LLM — path/maxDepth are echoed in the
    // input, totalEntries/truncated/cachedOutputPath are UI metadata.
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: { tree: string } }) {
      return [{ type: "text" as const, content: output.tree }];
    },
  });
};

/**
 * Format flat path list into tree-like structure
 */
export function formatAsTree(paths: string[], rootPath: string): string {
  if (paths.length === 0) return "(empty)";

  const lines: string[] = [];
  // Canonical form so the prefix compare works for either separator flavour.
  // `walkTree` (the production producer) returns root-relative, "/"-joined paths,
  // so for it this is a no-op; the normalization is what makes the function safe
  // for a caller handing it absolute paths — which is exactly what the
  // `validate:path-portability` case does, with win32-shaped backslash input.
  const root = toPosixPathKey(rootPath);

  // Sort paths
  const sortedPaths = paths.sort();

  for (const fullPath of sortedPaths) {
    const normalized = toPosixPath(fullPath);
    const relativePath = normalized.startsWith(`${root}/`)
      ? normalized.slice(root.length + 1)
      : normalized === root
        ? "."
        : normalized;

    if (!relativePath || relativePath === ".") {
      lines.push(root);
      continue;
    }

    const parts = relativePath.split("/");
    const depth = parts.length - 1;
    const indent = "  ".repeat(depth);
    const name = parts[parts.length - 1];

    lines.push(`${indent}${name}`);
  }

  return lines.join("\n");
}
