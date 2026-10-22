/**
 * Command analyzer — build a structured safety report for a shell command.
 *
 * Pure functions + injected context (root/cwd/home/env/path). All runtime
 * access flows through the injected {@link CommandAnalysisContext}, which is
 * constructed from CoreEnv by {@link createAnalysisContext} — no direct
 * `process`/`os`/global access (runtime-agnostic).
 *
 * Ported from opencode (`tmp/sst-opencode/.../tool/shell.ts`): file-command
 * sets, path-arg expansion (`~`, `$VAR`, `$HOME`/`$PWD`), glob truncation,
 * and `containsPath` for project-internal/external classification. PowerShell
 * cmdlets and win32 path handling from opencode are intentionally trimmed
 * (bash-first).
 */

import { toPosixPathKey } from "../../../../../utils/posix-path.js";

import { canonicalizeCommandName, commandName, commandPrefix } from "./command-arity.js";
import { extractCommands, parseCommandTree, resolveShellKind } from "./command-parser.js";
import { hasCommandSubstitution, tokenizeCommandString } from "./command-tokenizer.js";

import type { ParsedCommand, ShellKind } from "./command-parser.js";
import type { ResolvedCoreEnv, CoreEnvPath } from "../../../../../env";

// ============================================================================
// Types
// ============================================================================

export interface CommandAnalysisContext {
  /** Workspace root path (CoreEnv.rootPath). */
  rootPath: string;
  /** Working directory for relative path resolution. */
  cwd: string;
  /** Home directory (CoreEnv.homedir()) for `~` expansion. */
  home?: string;
  /** Environment variables (CoreEnv.getEnv()) for `$VAR` expansion. */
  env?: Record<string, string | undefined>;
  /** Path utilities (CoreEnvPath — POSIX via pathe by default). */
  path: CoreEnvPath;
  /** Owning runtime environment; command parsing/grammar lookup is scoped to it. */
  coreEnv?: ResolvedCoreEnv;
  /**
   * Shell the command will run under. Resolved from the host when omitted; callers that
   * already know it should pass it so the grammar choice and the execution agree.
   */
  shellKind?: ShellKind;
}

export interface FileOpAnalysis {
  /** Command name performing the file operation. */
  op: string;
  /** Original argument as written. */
  arg: string;
  /** Resolved absolute path (empty when unresolvable). */
  resolvedPath: string;
  /** True when the resolved path is outside the project root. */
  external: boolean;
  /** True when the argument could not be statically resolved (variables/globs). */
  unresolvable?: boolean;
}

export interface CommandAnalysis {
  /** Raw argument tokens (command name first). */
  tokens: string[];
  /** Command source text. */
  source: string;
  /** Normalized command + subcommand prefix tokens. */
  prefix: string[];
  /** Normalized prefix joined (e.g. `"git status"`). */
  normalized: string;
  /** True when the command is read-only and safe to auto-approve. */
  isReadOnly: boolean;
  /** File operations detected on this command. */
  fileOps: FileOpAnalysis[];
}

export interface CommandSafetyReport {
  /** False when the command was not parsed from an AST (grammar unavailable or parse failed). */
  ok: boolean;
  /**
   * True when the target shell has no bundled grammar, so the report was built from the
   * table-driven fallback rather than an AST. Distinct from `ok: false` with `parsed: true`,
   * which means a grammar existed but the command did not parse.
   */
  grammarUnavailable?: boolean;
  commands: CommandAnalysis[];
  /** True when any file path resolves outside the project root. */
  anyExternalDir: boolean;
  /** True when any command writes the filesystem (write ops / write redirects). */
  anyWriteOp: boolean;
}

// ============================================================================
// File-command sets (opencode shell.ts FILES / CMD_FILES, bash-focused)
// ============================================================================

const CWD_COMMANDS = new Set(["cd", "chdir"]);
const READ_FILE_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "sed",
  "wc",
  "sort",
  "ls",
  // Windows-native read-only file commands
  "dir",
  "type",
  "more",
  "findstr",
]);
/** Commands that mutate the filesystem (path args are treated as write targets). */
const WRITE_OPS = new Set([
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  // cmd.exe variants (kept for parity with opencode; not primary on bash hosts)
  "copy",
  "del",
  "erase",
  "md",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
]);

/** All commands whose arguments are file paths (path-external analysis applies). */
const FILE_COMMANDS = new Set([...CWD_COMMANDS, ...READ_FILE_COMMANDS, ...WRITE_OPS]);

/** Normalized prefixes that are considered read-only (safe to auto-approve). */
const READONLY_PREFIXES = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "pwd",
  "echo",
  "printf",
  "wc",
  "which",
  "uname",
  "dirname",
  "basename",
  "ps",
  // Text filters that are read-only on their own. `sed` / `sort` / `awk` are deliberately NOT
  // here: each has a write mode (`-i` / `-o` / `system()`), so they are classified separately by
  // {@link classifyReadOnly}. Listing `sort` alongside `cat` auto-approved `sort -o`, i.e. a file
  // write wearing a filter's name; `sed -i` was likewise one `sed` entry away from the same hole.
  // `env` and `find` are absent for the same reason: both are write-capable through their
  // *arguments*, not surfaced by a flag. `env rm -rf x` / `env -i sh -c …` launch another
  // program, and `find . -delete` / `find . -exec rm {} ;` mutate — a name-only entry
  // auto-approved all of them. Both are now classified from their tokens by
  // {@link classifyReadOnly}.
  "cut",
  "uniq",
  "test",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git stash list",
  "git remote -v",
  "node -v",
  "node --version",
  "npm -v",
  "npm --version",
  "pnpm -v",
  "pnpm --version",
  "yarn -v",
  "yarn --version",
  "python -V",
  "python --version",

  // ---- Windows-native read-only commands ----
  // `where` is the platform counterpart of `which`; `dir`/`type`/`more`/`findstr` are the
  // read-only file commands. Grouped separately so the POSIX list stays visually intact.
  "dir",
  "type",
  "more",
  "findstr",
  "where",
  "tasklist",
]);

// ============================================================================
// Path argument expansion (opencode unquote/home/envValue/expand/prefix)
// ============================================================================

function unquote(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1);
  return text;
}

function homeExpand(text: string, ctx: CommandAnalysisContext): string {
  if (!ctx.home) return text;
  if (text === "~") return ctx.home;
  if (text.startsWith("~/") || text.startsWith("~\\")) return ctx.path.join(ctx.home, text.slice(2));
  return text;
}

function envExpand(text: string, ctx: CommandAnalysisContext): string {
  return text
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => ctx.env?.[key] ?? "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => ctx.env?.[key] ?? "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, key: string) => {
      if (key === "HOME") return ctx.home ?? "";
      if (key === "PWD") return ctx.cwd;
      return ctx.env?.[key] ?? "";
    });
}

/** Expand a raw argument into a concrete string (unquote → env → home). */
function expandArg(text: string, ctx: CommandAnalysisContext): string {
  return homeExpand(envExpand(unquote(text), ctx), ctx);
}

/** True when the argument cannot be statically resolved to a concrete path. */
function isDynamicArg(text: string): boolean {
  if (text.startsWith("(") || text.startsWith("@(")) return true;
  return text.includes("$(") || text.includes("${") || text.includes("`") || text.includes("$");
}

/** Truncate a path at the first glob metacharacter (`?`, `*`, `[`). */
function globPrefix(text: string): string | undefined {
  const match = /[?*[]/.exec(text);
  if (!match) return text;
  if (match.index === 0) return undefined;
  return text.slice(0, match.index);
}

/** Commands whose first non-flag argument is a search pattern, not a path. */
const PATTERN_FIRST_COMMANDS = new Set(["grep", "rg", "ag", "ack"]);

/**
 * The STARTING POINTS of a `find` invocation — the only arguments that are filesystem operands.
 *
 * `find`'s grammar is `find [starting-point…] [expression]`: from the first token that begins with
 * `-` (or is a standalone `(`, `!`, `,`) everything is the expression, and its values are predicates
 * or patterns (`-name "*.d.mts"`, `-path ./x`, `-type f`), not paths. The generic path extractor
 * treated those values as operands: `-name "*.d.mts"` became a glob with no prefix to resolve, which
 * the analyzer reports as an unresolvable external path, so an ordinary read-only traversal demanded
 * approval. GNU's leading global options (`-L` / `-H` / `-P`, `-D debugopts`, `-O0..3`) are not
 * starting points either — skipping them keeps `find -L /etc` classified as external.
 */
function findStartingPoints(tokens: string[]): string[] {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === "-L" || token === "-H" || token === "-P") {
      i += 1;
      continue;
    }
    if (token === "-D") {
      i += 2;
      continue;
    }
    if (/^-O[0-9]?$/.test(token)) {
      i += 1;
      continue;
    }
    break;
  }

  const paths: string[] = [];
  for (; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-") || token === "(" || token === "!" || token === ",") break;
    paths.push(token);
  }
  return paths;
}

/**
 * Collect path arguments for a command, dropping flags (opencode `pathArgs`).
 *
 * `grep`-family commands are also skipped over their leading *pattern* argument, which is not a
 * path. Treating it as one produced a bogus external-dir verdict — and therefore an approval
 * prompt — for an ordinary read-only search: the pattern `\.todoManager\b` "resolved" to
 * `/.todoManager/b`, i.e. outside the root. The pattern carries no shell meaning that a path
 * check could act on, so dropping it is strictly more correct; the files it is searched for
 * are still checked normally.
 */
function pathArgs(tokens: string[]): string[] {
  const name = tokens[0]?.toLowerCase() ?? "";
  // `find` is the one command whose remaining arguments are a small expression language: only the
  // leading starting points are paths (see {@link findStartingPoints}).
  if (name === "find") return findStartingPoints(tokens);

  const args = tokens.slice(1).filter((item) => {
    if (item.startsWith("-")) return false;
    if (name === "chmod" && item.startsWith("+")) return false;
    return true;
  });
  if (PATTERN_FIRST_COMMANDS.has(name)) return args.slice(1);
  return args;
}

/**
 * Whether `child` resolves inside `parent`.
 *
 * Both sides are compared in a canonical forward-slash form. That is deliberate: the host's
 * `path.normalize` and its separator can disagree — `pathe` normalizes `C:\repo` to `C:/repo`
 * while reporting `\` as its separator — so building a prefix from a normalized path and a
 * separator of a different flavour produced a false "outside the root" verdict for Windows
 * paths. Comparing in one canonical form is immune to which flavour produced the values, and
 * it is the shared path rule rather than a convention re-stated here.
 *
 * The host's own `normalize` is still used, so a Windows env resolves `C:\a\..\b` correctly;
 * only the separator used for the comparison is fixed.
 */
function containsPath(parent: string, child: string, path: CoreEnvPath): boolean {
  const canonical = (p: string) => toPosixPathKey(path.normalize(p));
  const normalizedParent = canonical(parent);
  const normalizedChild = canonical(child);
  if (normalizedChild === normalizedParent) return true;
  return normalizedChild.startsWith(`${normalizedParent}/`);
}

/**
 * Output redirections that cannot create, truncate, or modify a file — so they are not writes.
 *
 * - `2>&1` / `1>&2` / `>&2` — duplicate a descriptor onto another *descriptor*.
 * - `>/dev/null` / `2>/dev/null` — the null device discards the stream.
 *
 * Everything else containing `>` keeps the conservative write verdict. A `>` inside a quoted
 * argument (`grep ">" file`) is not shell syntax and is still counted as one; the whole-string
 * scan cannot tell, and the asymmetry is deliberate — a false positive costs one approval
 * prompt, while a false negative would auto-approve a real write.
 *
 * Only these two forms qualify: a redirection to a *named* target is exactly how a shell
 * creates or truncates a file, so it must keep asking. `2>&1` was the single most common cause
 * of spurious prompts in real plan/debug sessions (`cmd 2>&1 | tail`), i.e. shell noise that
 * every command carries and none of it writes.
 */
const BENIGN_REDIRECTION = /(?:[12]?&>|[12]?>)\s*(&[12-]|\/dev\/null|[12][>&]?)/g;

/**
 * Whether a command string redirects to a file (a write).
 *
 * `>>>` is not a redirection (it is not shell syntax); everything else containing `>` is
 * treated as one. Input redirection (`<`) is not a write. Known-benign output redirections
 * ({@link BENIGN_REDIRECTION}) are removed before the scan.
 *
 * Only consulted when the *per-command* source is unavailable — see
 * {@link hasWriteRedirectionAcrossCommands} for why a whole-string scan is wrong.
 */
function hasWriteRedirection(source: string): boolean {
  return />/.test(source.replace(BENIGN_REDIRECTION, " ").replace(/<<<?/g, ""));
}

/**
 * Filters that are read-only *unless* given a flag that writes.
 *
 * These names are otherwise pure stdin→stdout transforms, which is why they appear all over
 * read-only inspection pipelines (`grep … | sed -n '1,20p' | head`). Their whole-command
 * read-only status is therefore conditional: `sed -i` edits in place, `sort -o` writes a file,
 * and `awk` can shell out. A name-only allowlist would have granted write access to all three,
 * so the flag is part of the classification.
 */
const MUTATING_FILTER_FLAGS: Record<string, (token: string) => boolean> = {
  sed: (token) => token === "-i" || token.startsWith("-i") || token === "--in-place" || token.startsWith("--in-place"),
  sort: (token) => token === "-o" || token.startsWith("-o") || token === "--output" || token.startsWith("--output"),
  // `awk` may run arbitrary commands from its program: `awk 'BEGIN{system("rm -rf x")}'`.
  // `print > "file"` is caught separately by the write-redirection scan.
  awk: (token) => /system\s*\(/.test(token),
};

/**
 * `find` predicates that write or execute.
 *
 * `find` is a read-only traversal on its own (`find . -name "*.ts"`), so its *predicate* — not
 * its name — decides. `-delete` removes matches; `-exec` / `-execdir` / `-ok` / `-okdir` run an
 * arbitrary command per match; `-fprint` / `-fprint0` / `-fprintf` / `-fls` write their listing
 * to a file. Any one of them makes the whole invocation a write, so a name-only read-only entry
 * would have auto-approved `find . -delete` and `find . -exec rm -rf {} ;`.
 */
const FIND_WRITE_PREDICATES = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/** Index of the `delim` closing the field starting at `start`, honouring escapes; `-1` if absent. */
function skipDelimited(script: string, start: number, delim: string): number {
  let i = start;
  while (i < script.length) {
    if (script[i] === "\\") {
      i += 2;
      continue;
    }
    if (script[i] === delim) return i;
    i += 1;
  }
  return -1;
}

/**
 * Index just past a single sed address at `i` (`$`, `N`, `N~M`, `/re/`, `\crec`, `+N`), or `i`
 * unchanged when no address starts here.
 */
function skipSedAddress(script: string, i: number): number {
  const c = script[i];
  if (c === "$") return i + 1;
  if (c === "+") {
    let j = i + 1;
    while (j < script.length && script[j] >= "0" && script[j] <= "9") j += 1;
    return j;
  }
  if (c >= "0" && c <= "9") {
    let j = i;
    while (j < script.length && script[j] >= "0" && script[j] <= "9") j += 1;
    if (script[j] === "~") {
      j += 1;
      while (j < script.length && script[j] >= "0" && script[j] <= "9") j += 1;
    }
    return j;
  }
  if (c === "/") {
    const end = skipDelimited(script, i + 1, "/");
    return end < 0 ? script.length : end + 1;
  }
  if (c === "\\") {
    if (i + 1 >= script.length) return script.length;
    const end = skipDelimited(script, i + 2, script[i + 1]);
    return end < 0 ? script.length : end + 1;
  }
  return i;
}

/** Skip an optional `addr` / `addr1,addr2` prefix, returning the index of the command character. */
function skipSedAddresses(script: string, i: number): number {
  let j = skipSedAddress(script, i);
  if (j === i) return i;
  while (j < script.length && /\s/.test(script[j])) j += 1;
  if (script[j] === ",") {
    j += 1;
    while (j < script.length && /\s/.test(script[j])) j += 1;
    const after = skipSedAddress(script, j);
    if (after > j) j = after;
  }
  return j;
}

/**
 * Whether a sed script writes or executes.
 *
 * A bare scan for the letters `w` / `e` would flag `s/world/earth/`, because those letters sit
 * inside the pattern and replacement. Sed commands are addressed (`1,20p`, `/foo/w file`) and the
 * `s` / `y` commands carry a delimited pattern/replacement, so this walks each command instead:
 * skip the address prefix, read the command character, and for `s` / `y` skip both delimited
 * fields before reading flags. `w` / `W` (write to a file), `r` / `R` (read a file into the
 * stream) and `e` (execute a command) are mutating wherever they appear — as the command itself
 * or as an `s` flag. A malformed delimited command is treated as mutating (conservative).
 */
function sedScriptMutates(script: string): boolean {
  let i = 0;
  const n = script.length;
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i])) i += 1;
    if (i >= n) break;
    i = skipSedAddresses(script, i);
    while (i < n && /\s/.test(script[i])) i += 1;
    if (i >= n) break;
    const cmd = script[i];
    if (cmd === "w" || cmd === "W" || cmd === "r" || cmd === "R" || cmd === "e") return true;
    if (cmd === "s" || cmd === "y") {
      if (i + 1 >= n) return true; // malformed — conservative
      const delim = script[i + 1];
      const patternEnd = skipDelimited(script, i + 2, delim);
      if (patternEnd < 0) return true;
      const replacementEnd = skipDelimited(script, patternEnd + 1, delim);
      if (replacementEnd < 0) return true;
      if (cmd === "s") {
        // Trailing flags: only `w` / `W` / `e` write or execute.
        let j = replacementEnd + 1;
        while (j < n && !/[\s;]/.test(script[j])) {
          const flag = script[j];
          if (flag === "w" || flag === "W" || flag === "e") return true;
          j += 1;
        }
        i = j;
        continue;
      }
      i = replacementEnd + 1;
      continue;
    }
    i += 1;
  }
  return false;
}

/**
 * The script argument(s) of a `sed` command's tokens.
 *
 * Sed takes its script either from `-e` / `--expression` (repeatable) or, when neither is present,
 * from the first non-flag argument (`sed 's/a/b/' file`). Both spellings must be inspected.
 */
function sedScriptArgs(tokens: string[]): string[] {
  const args = tokens.slice(1);
  const explicit: string[] = [];
  let hasExpression = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-e" || arg === "--expression") {
      hasExpression = true;
      if (i + 1 < args.length) explicit.push(args[i + 1]);
      i += 1;
    } else if (arg.startsWith("--expression=")) {
      hasExpression = true;
      explicit.push(arg.slice("--expression=".length));
    } else if (arg.startsWith("-e") && arg.length > 2) {
      hasExpression = true;
      explicit.push(arg.slice(2));
    }
  }
  if (hasExpression) return explicit;
  const script = args.find((arg) => !arg.startsWith("-"));
  return script === undefined ? [] : [script];
}

/** True when a would-be read-only filter carries a flag or script that makes it write. */
function usesMutatingFilterFlag(name: string, tokens: string[]): boolean {
  const probe = MUTATING_FILTER_FLAGS[name];
  if (!probe) return false;
  if (tokens.slice(1).some(probe)) return true;
  // `sed` additionally mutates when its *script* contains a write/exec command — a whole class
  // the flag probe above cannot see, since `sed 'w /tmp/pwn' f` carries no flag at all.
  return name === "sed" && sedScriptArgs(tokens).some(sedScriptMutates);
}

/**
 * Whether a single command is read-only, given it already carries no write op, no write
 * redirection, and no background marker.
 *
 * Cases, all conservative:
 *
 * - `cd` — read-only by nature: it changes only the shell's working directory, and it is the
 *   one command whose path argument must be checked here instead of via the generic file-arg
 *   scan. That check is what keeps `cd /etc` (an *absolute* path outside the project) asking;
 *   a bare `cd` or an in-root relative one is not a write by any reading.
 * - `env` — read-only only as a pure assignment list (`env FOO=1`); any option or trailing
 *   command (`env -i sh -c …`, `env rm -rf x`) makes it a launcher for another program.
 * - `find` — read-only unless a write/exec predicate (`-delete`, `-exec`, `-fprint`, …) is
 *   present; the predicate, not the command name, is what mutates.
 * - `git … --output…` — `git diff` / `log` / `show` are otherwise read-only but `--output[=]`
 *   writes a file, so it is excluded (the `--output-indicator-*` options are not writes).
 * - {@link MUTATING_FILTER_FLAGS} names — read-only *unless* the write flag/script is present.
 * - {@link READONLY_PREFIXES} — the command is read-only by name (`cat`, `ls`, `git status`).
 *
 * The `cd` case exists because it is in every chained inspection command (`cd repo && grep …`)
 * but in neither READONLY_PREFIXES nor — as a path argument — `FILE_COMMANDS`, so an entire
 * read-only exploration chain was blocked by its first segment.
 */
function classifyReadOnly(
  name: string,
  prefix: string[],
  normalized: string,
  tokens: string[],
  ctx: CommandAnalysisContext
): boolean {
  if (name === "cd") {
    const target = pathArgs(tokens)[0];
    if (target === undefined) return true;
    const expanded = expandArg(target, ctx);
    const globbed = globPrefix(expanded);
    if (isDynamicArg(target) || expanded.includes("$") || expanded === "" || globbed === undefined) return false;
    const resolved = ctx.path.isAbsolute(globbed) ? ctx.path.normalize(globbed) : ctx.path.resolve(ctx.cwd, globbed);
    return containsPath(ctx.rootPath, resolved, ctx.path);
  }

  if (name === "env") {
    // `env` is read-only only as a pure assignment list: `env`, `env FOO=1`, `env A=1 B=2`.
    // Any option or command word (`env -i sh -c …`, `env rm -rf x`, `env -u FOO cmd`) turns it
    // into a launcher for another program — that program, not `env`, decides what runs.
    return tokens.slice(1).every((token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  }

  if (name === "find") {
    return !tokens.slice(1).some((token) => FIND_WRITE_PREDICATES.has(token));
  }

  // `git diff` / `log` / `show` can write a file directly with `--output` / `--output=…`, which
  // their read-only prefixes would otherwise wave through. `--output-indicator-*` is a display
  // option, not a write, so only the exact/`=` forms count.
  if (normalized.startsWith("git ")) {
    const writesOutput = tokens.slice(1).some((token) => token === "--output" || token.startsWith("--output="));
    if (writesOutput) return false;
  }

  if (normalized in MUTATING_FILTER_FLAGS) return !usesMutatingFilterFlag(normalized, tokens);

  // `node -v` style prefixes are the only multi-token entries; keep the original lookup for them.
  return READONLY_PREFIXES.has(normalized) || READONLY_PREFIXES.has(prefix.join(" "));
}

/**
 * Whether any command inside a compound string writes via redirection.
 *
 * Split from {@link hasWriteRedirection} because the tokenizer strips a redirection's
 * *operator* before the analyzer sees a command: it deliberately drops `> out.txt` (the AST
 * path skips those nodes too), so `cmd.source` no longer contains the `>`.
 *
 * The fallback therefore has to look for redirection somewhere else, and an earlier version
 * looked at the whole original string — which is wrong whenever the shells being classified
 * assign a different meaning to `>`:
 *
 * - PowerShell comparison operators: `if ($a -gt $b)`, and `->` in an argument
 * - cmd.exe: `>` is the redirection, but the surrounding syntax differs enough that a global
 *   scan cannot attribute it to a command
 *
 * Attributing the redirection to the specific segment it appears in keeps the result tied to a
 * real shell operator. A segment whose redirection cannot be parsed this way still ends up
 * `not read-only`, so the conservative outcome is preserved.
 *
 * Only `>` counts. `|` is a separator (the tokenizer splits on it), and treating other
 * operators as writes would misclassify read-only commands on the shells this fallback exists
 * for.
 */
function hasWriteRedirectionAcrossCommands(command: string): boolean {
  // Strip benign redirections BEFORE splitting on `&` / `|`: the separators cut `2>&1` into
  // `2>` and `1`, and the orphaned `>` then reads as a write in an otherwise read-only line.
  return command
    .replace(BENIGN_REDIRECTION, " ")
    .split(/&&|\|\||[;|\n]|&/)
    .some((segment) => hasWriteRedirection(segment));
}

/** Background marker (` & ` / trailing `&`), excluding `&&`. */
/**
 * Background marker (` & ` / trailing `&`), excluding `&&`.
 *
 * A `&` that is part of a redirection is not a background marker: `2>&1` duplicated a
 * descriptor, it did not put the command in the background. Reading it as one was the reason
 * `cmd 2>&1` — shell noise every inspection command carries — was classified as a background
 * write and promoted the *other* commands in the same line to non-read-only as well.
 */
function isBackgroundCommand(command: string, source: string): boolean {
  const stripped = command.replace(BENIGN_REDIRECTION, " ");
  if (/(^|[^&])&([^&]|$)/.test(stripped)) return true;
  return /&\s*$/.test(source.replace(BENIGN_REDIRECTION, " "));
}

// ============================================================================
// Analysis
// ============================================================================

/**
 * Build a safety report for a shell command.
 *
 * Two paths, selected by the shell the command will actually run under:
 *
 * - **Grammar available** (bash): parse an AST and classify each command from it, as before.
 * - **Grammar unavailable** (PowerShell, cmd.exe, unknown): tokenize and classify from the
 *   built-in tables. This exists because a parse failure used to return `commands: []`, which
 *   meant no command could ever be recognised as read-only and evaluators always fell through
 *   to "requires approval" — and subagents downgrade that to a denial. The visible effect was
 *   that a subagent could not run *any* command on Windows, with a message implying a user
 *   prompt would unblock it.
 *
 * FAIL-SAFE INVARIANT (the security-relevant part): the fallback may only ever grant read-only
 * status for a command whose normalized prefix is in {@link READONLY_PREFIXES} and which is
 * not a write op, carries no write redirection, and whose path arguments stay inside the
 * project root. It must never grant write or external-dir status, and anything it cannot
 * confidently classify stays as it was — unrecognised commands are simply not read-only, so
 * they keep the conservative outcome.
 */
export async function analyzeCommand(command: string, ctx: CommandAnalysisContext): Promise<CommandSafetyReport> {
  const shellKind = ctx.shellKind ?? (await resolveShellKind(ctx.coreEnv));

  // `unknown` means the host did not report a shell. Try the grammar anyway — plenty of hosts
  // are bash and simply do not advertise it — but only trust a *productive* parse. If the
  // bash grammar finds nothing, the command is more likely some other shell's syntax, so fall
  // through to the tables rather than reporting an empty (and therefore always-ask) report.
  if (shellKind === "bash" || shellKind === "unknown") {
    const tree = ctx.coreEnv ? await parseCommandTree(command, ctx.coreEnv) : null;
    if (tree) {
      const parsed = extractCommands(tree);
      // A command substitution is itself a command that runs, and the substitution body is
      // what carries the risk (`echo "$(rm -rf x)"`). The bash grammar does surface it, so
      // requiring the parse to have found it is a cheap consistency check: if it did not — a
      // grammar that is older or narrower than the syntax in use — the parse is not
      // trustworthy for this string, and the token table view is the conservative answer even
      // for a reported `bash`.
      const substitutionsCovered = !hasCommandSubstitution(command) || parsed.length > 1;
      if ((parsed.length > 0 || shellKind === "bash") && substitutionsCovered) {
        return analyzeParsedCommands(parsed, command, ctx);
      }
    } else if (shellKind === "bash") {
      // A grammar exists for this shell but the command did not parse. There is no token view
      // more trustworthy than the parser's own failure, so stay conservative.
      return { ok: false, commands: [], anyExternalDir: true, anyWriteOp: true };
    }
  }

  // No grammar for this shell (PowerShell, cmd.exe, or an unproductive unknown): classify from
  // the tables, and say so in the report.
  const tokens = tokenizeCommandString(command);
  const fallbackCommands: ParsedCommand[] = tokens.map((parts) => ({ tokens: parts, source: parts.join(" ") }));
  return {
    ...analyzeParsedCommands(fallbackCommands, command, ctx, {
      // The tokenizer strips redirections, so `cmd.source` no longer carries them. Detect them
      // on the original string instead — but per segment, so a `>` that belongs to a different
      // command (or to PowerShell syntax) is not attributed to a read-only one.
      globalWriteRedirection: hasWriteRedirectionAcrossCommands(command),
      globalBackground: isBackgroundCommand(command, command),
    }),
    ok: false,
    grammarUnavailable: true,
  };
}

/**
 * Classify a list of tokenized commands.
 *
 * Shared by the AST path and the fallback so both apply the identical read-only rule — a
 * second implementation is what would let the fallback drift permissive.
 *
 * `overrides` exists only for the fallback, whose input has had redirections tokenized away.
 */
function analyzeParsedCommands(
  parsed: ParsedCommand[],
  originalCommand: string,
  ctx: CommandAnalysisContext,
  overrides: { globalWriteRedirection?: boolean; globalBackground?: boolean } = {}
): CommandSafetyReport {
  const commands: CommandAnalysis[] = [];
  let anyExternalDir = false;
  let anyWriteOp = false;

  for (const cmd of parsed) {
    const name = canonicalizeCommandName(commandName(cmd.tokens));
    const prefix = commandPrefix(cmd.tokens);
    const normalized = prefix.join(" ");
    const isWriteCmd = WRITE_OPS.has(name);
    const writeRedirection = overrides.globalWriteRedirection ?? hasWriteRedirection(cmd.source);
    const background = overrides.globalBackground ?? isBackgroundCommand(originalCommand, cmd.source);
    const harmless = !isWriteCmd && !writeRedirection && !background;
    const isReadOnly = harmless && classifyReadOnly(name, prefix, normalized, cmd.tokens, ctx);

    const fileOps: FileOpAnalysis[] = [];
    if (FILE_COMMANDS.has(name)) {
      for (const rawArg of pathArgs(cmd.tokens)) {
        const expanded = expandArg(rawArg, ctx);
        const globbed = globPrefix(expanded);
        if (isDynamicArg(rawArg) || expanded.includes("$") || expanded === "" || globbed === undefined) {
          // Unresolvable path (variables/globs) — conservative: treat as external.
          fileOps.push({ op: name, arg: rawArg, resolvedPath: "", external: true, unresolvable: true });
          anyExternalDir = true;
          continue;
        }
        const resolved = ctx.path.isAbsolute(globbed)
          ? ctx.path.normalize(globbed)
          : ctx.path.resolve(ctx.cwd, globbed);
        const external = !containsPath(ctx.rootPath, resolved, ctx.path);
        fileOps.push({ op: name, arg: rawArg, resolvedPath: resolved, external });
        if (external) anyExternalDir = true;
      }
    }

    if (isWriteCmd || writeRedirection) anyWriteOp = true;
    commands.push({ tokens: cmd.tokens, source: cmd.source, prefix, normalized, isReadOnly, fileOps });
  }

  return { ok: true, commands, anyExternalDir, anyWriteOp };
}

/**
 * Build an analysis context from CoreEnv (runtime-agnostic).
 * `overrides` allow callers to pin cwd/home/env for testing or specific runs.
 */
export async function createAnalysisContext(
  env: ResolvedCoreEnv,
  overrides?: Partial<CommandAnalysisContext>
): Promise<CommandAnalysisContext> {
  const [home, envVars] = await Promise.all([env.homedir(), env.getEnv()]);
  return {
    rootPath: overrides?.rootPath ?? env.rootPath,
    cwd: overrides?.cwd ?? env.rootPath,
    home: overrides?.home ?? home,
    env: overrides?.env ?? envVars,
    path: overrides?.path ?? env.path,
    coreEnv: env,
  };
}
