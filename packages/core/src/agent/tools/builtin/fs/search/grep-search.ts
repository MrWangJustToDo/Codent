/**
 * The `grep` engine ladder: argv construction, execution, and output parsing.
 *
 * Split out of `grep-tool.ts` at the 800-line file ceiling, along the seam the module already had:
 * this file knows about binaries (`rg` → `git grep` → `grep`) and their output formats, while the
 * tool file owns the definition the model sees (schema, description, result shaping).
 *
 * Three engines, one policy: `rg` honours `.gitignore` natively, `git grep` is the same answer on a
 * machine without ripgrep (and is why a repo-wide search no longer walks the agent's own 524 MB
 * `.agents/` directory), and GNU `grep` — which has no ignore support at all — remains the last
 * resort with the policy's `--exclude-dir` list.
 */

import { ExecutionError } from "../../../../../env/types";
import { toPosixPath } from "../../../../../utils/posix-path.js";
import { canExecArgs, execArgs } from "../../shell/exec-args.js";

import { expandBraceGlobs } from "./glob-pattern.js";
import { isCommandNotFound, quoteForShell, SEARCH_COMMAND_TIMEOUT, truncateLines } from "./search-command.js";
import { isGitWorkTree, type SearchPolicy } from "./search-policy.js";

import type { CoreEnv } from "../../../../../env";

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
    excludeDirs: readonly string[];
    noIgnore: boolean;
  }
): string[] {
  const args: string[] = ["--color=never"];
  // `--no-config`: the tool contract must not depend on ambient user config
  // (`RIPGREP_CONFIG_PATH`). A user config carrying `--no-ignore`/`--hidden` would otherwise
  // silently change what every search of this workspace can find, which is exactly the class of
  // difference this policy exists to remove.
  args.push("--no-config");
  // Hidden files are visible by default (dotfiles are source: `.github/`, `.eslintrc`, …), but
  // *ignored* files are not — that is the repository's own decision. `--no-ignore` is added only
  // for an explicit target inside an ignored tree (see `searchTargetBypassesIgnore`).
  args.push("--hidden");
  if (options.noIgnore) args.push("--no-ignore");

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
    for (const dir of options.excludeDirs) {
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
    excludeDirs: readonly string[];
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
    for (const dir of options.excludeDirs) {
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
 * Build `git grep` arguments — the ignore-aware engine for a git workspace when `rg` is absent.
 *
 * Why this exists: the fallback used to be `grep -r`, which has no idea what `.gitignore` says, so
 * a repo-wide search read the agent's own `.agents/` sessions (524 MB here) and anything else the
 * repository had excluded — 12.6 s for a search `git grep` answers in 57 ms. Making ripgrep
 * mandatory would solve it too, but a coding agent must work on a bare machine; `git grep` is
 * already there, `--untracked` keeps newly created files findable, and the ignore semantics are
 * git's own rather than a re-implementation.
 *
 * Output shape is GNU grep's (`path:line:content`, `path-line-content` for context), which is what
 * {@link parseGrepLine} already parses. Deliberately no `-z`: `git grep --null` puts the NUL after
 * the *line number* (`path\0line\0content`), not after the path like `rg --null`/`grep -Z`.
 */
function buildGitGrepArgs(
  pattern: string,
  searchPath: string,
  options: {
    ignoreCase: boolean;
    include: string | undefined;
    outputMode: string;
    context: number;
    searchPathIsFile: boolean;
    excludeDirs: readonly string[];
  }
): string[] {
  // `-P` (no pager): `git grep` pages on a tty, which would hang a non-interactive spawn.
  // Pushed rather than written as one `["-P", "grep", …]` literal: `validate:builtin-tool-names`
  // reads a `= [` array containing a built-in's spelling as a list of tool names, and this one is
  // an argv.
  const args: string[] = [];
  args.push("-P", "grep", "--untracked", "--no-color");
  // `-m` is not a `git grep` option, so the per-file cap has to come from JS truncation.

  if (options.ignoreCase) args.push("-i");
  if (options.outputMode === "files_with_matches") {
    args.push("-l");
  } else if (options.outputMode === "count") {
    args.push("-c");
  } else {
    args.push("-n");
    if (options.context > 0) args.push("-C", String(options.context));
  }

  // A basename include glob is a valid pathspec at any depth; a path-shaped one is relative to
  // the search root rather than the repository, so it stays a JS filter (same split as the grep
  // path above).
  const pathspecs: string[] = [];
  if (options.include && !options.searchPathIsFile && !includeNeedsJsFilter(options.include)) {
    pathspecs.push(...expandBraceGlobs(options.include));
  }
  pathspecs.push(searchPath);
  // The policy's build/data directories are not necessarily in `.gitignore` (a fixture repo, a
  // fresh clone before its first build). git pathspecs are the one way to prune them here —
  // `git grep` has no `--exclude-dir`, and `:(glob,exclude)` is the equivalent.
  if (!options.searchPathIsFile) {
    for (const dir of options.excludeDirs) {
      pathspecs.push(`:(glob,exclude)**/${dir}/**`);
    }
  }

  args.push("-E", "-e", pattern, "--", ...pathspecs);
  return args;
}

/**
 * Run the content search, preferring ripgrep, then `git grep`, then grep.
 *
 * Availability drives the choice: binaries are probed rather than relying on exit code 127,
 * which is POSIX-only for "command not found" (cmd.exe reports 9009, PowerShell reports 1),
 * so the code-based fallback never fired on Windows.
 *
 * The middle rung is what keeps a repo-wide search honest on a machine without ripgrep: `grep -r`
 * does not know about `.gitignore`, so it walked this workspace's 524 MB `.agents/` directory
 * (12.6 s for an answer `git grep` produces in 57 ms). It is skipped for an explicit target inside
 * an ignored tree, which `git grep` cannot search at all — there the ignore rules are dropped on
 * purpose (`noIgnore`).
 *
 * Truncation to `fetchCount` happens in JS on every path, replacing the previous `head`
 * pipeline — the shell is never responsible for correctness.
 */
export async function runGrepSearch(
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
    policy: SearchPolicy;
    excludeDirs: readonly string[];
    /** The caller explicitly targeted a tree the ignore rules would skip. */
    noIgnore: boolean;
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

    // `rg` absent: prefer the repository's own ignore machinery over a raw recursive grep.
    if (!options.searchPathIsFile && !options.noIgnore && options.policy.respectVcsIgnore) {
      if (await isGitWorkTree(env, options.signal)) {
        const gitResult = await execArgs(env, "git", buildGitGrepArgs(pattern, searchPath, options), {
          cwd: env.rootPath,
          signal: options.signal,
        });
        if (!gitResult.missing) {
          if (gitResult.killed && !gitResult.truncated && gitResult.stdout.length === 0) {
            throw new ExecutionError("timeout", "git grep was killed before it produced a complete result");
          }
          // A repository-level failure (128: bad options, unreadable object) is a real error; a
          // clean "no matches" is exit 1, which `failure` already lets through.
          const error = failure("git grep", gitResult);
          if (error) throw error;
          return truncateLines(gitResult.stdout, lineCap);
        }
      }
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
  //
  // No `git grep` rung here on purpose: that path only exists for a remote server predating the
  // exec-file route, where an extra "is this a repo" probe would double the round-trips it is
  // already paying. The `--exclude-dir` half of the policy still applies, so the runtime data
  // directory is never walked even without VCS ignore support.
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

export function parseLineNumber(value: string): number | null {
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
export function parseGrepLine(
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
export function parseCountLine(
  line: string,
  defaultFile?: string
): { file: string; lineNumber: number; content: string } {
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
