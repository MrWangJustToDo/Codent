/**
 * Read-only command rules — the table behind the default approval decision.
 *
 * The analyzer answers "may this run without asking?" from a command's *name and arguments*
 * (`command-analyzer.ts` builds the report). The table for that decision lives here because it
 * is data: it grows whenever a read-only command turns out to be missing, and keeping it beside
 * the classification logic made that file outgrow its line budget without adding behaviour.
 *
 * ## The rule every entry must obey
 *
 * Read-only is a property of the whole INVOCATION, not of the command's name. A name earns an
 * entry only when every way it can write or execute something else is ruled out by an explicit
 * guard here. The historical failure is exactly this one: `sort` was listed beside `cat`, so
 * `sort -o out.txt` was auto-approved. `uniq` has the same shape and was still open —
 * `uniq in.txt out.txt` writes `out.txt` while the name says "filter" — which is why
 * {@link ARGUMENT_GUARDS} exists and why `uniq` carries a guard rather than a bare entry.
 *
 * Two guard shapes, both fail-closed:
 *
 * - {@link WRITE_MODE_TOKENS} — a flag that turns the command into a writer or an executor
 *   (`tree -o`, `date -s`, `eslint --fix`, `rg --pre`).
 * - {@link ARGUMENT_GUARDS} — a whole-invocation verdict, for commands whose *argument count*
 *   or *subcommand* decides (`uniq in out`, `git branch NAME`, `git config k v`).
 *
 * A command with no guard must be read-only under every possible argument list. When that is
 * not obviously true, it does not belong in the table.
 */

// ============================================================================
// Read-only by name
// ============================================================================

/**
 * Normalized prefixes that are read-only, subject to their guard (if any).
 *
 * `sed` / `sort` / `awk` are deliberately absent, not forgotten: each has a write mode that a
 * name-only entry cannot see (`sed -i`, `sort -o`, `awk 'BEGIN{system(…)}'`), and each is
 * classified from its flags and script by the analyzer's `MUTATING_FILTER_FLAGS`. `env` and
 * `find` are absent for the same reason — both write through their *arguments*
 * (`env rm -rf x`, `find . -delete`) — and have dedicated checks in the analyzer.
 */
export const READONLY_PREFIXES: ReadonlySet<string> = new Set([
  // ---- file inspection ----
  "ls",
  "cat",
  "head",
  "tail",
  "grep",
  "wc",
  "stat",
  "file",
  "readlink",
  "realpath",
  "diff",
  "du",
  "df",
  "tree",
  "column",
  "hexdump",
  "od",
  "strings",

  // ---- text transforms that write only to stdout ----
  "cut",
  "uniq",
  "tr",
  "jq",

  // ---- shell / process introspection ----
  "pwd",
  "echo",
  "printf",
  "which",
  "command",
  "help",
  "uname",
  "dirname",
  "basename",
  "ps",
  "id",
  "whoami",
  "hostname",
  "date",
  "free",
  "printenv",
  "sleep",
  "expr",
  "seq",
  "yes",
  "true",
  "test",

  // ---- checksums / encoders (stdout only) ----
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "base64",
  "xxd",

  // ---- git: the subcommand, and often its arguments, decide (see `gitReadOnly`) ----
  "git",

  // ---- version probes ----
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

  // ---- project tooling, non-writing form only ----
  // Each writes under a flag (`eslint --fix`, `prettier --write`, plain `tsc` emitting JS), so
  // each carries a guard. `pnpm run <script>` is deliberately absent: the script body is
  // arbitrary, so a name-based entry would approve whatever that script does.
  "eslint",
  "prettier",
  "tsc",
  "rg",
  "ag",
  "ack",
  "pnpm list",
  "npm ls",

  // ---- Windows-native read-only commands ----
  // `where` is the platform counterpart of `which`; `dir`/`more`/`findstr` are the read-only
  // file commands. Grouped separately so the POSIX list stays visually intact.
  "dir",
  "type",
  "more",
  "findstr",
  "where",
  "tasklist",
]);

// ============================================================================
// Guards
// ============================================================================

/** Flags that turn an otherwise read-only command into a writer or an executor. */
export const WRITE_MODE_TOKENS: Readonly<Record<string, (token: string) => boolean>> = {
  // `tree -o file` writes the listing to `file`.
  tree: (token) => token === "-o" || (token.startsWith("-o") && token.length > 2) || token === "--output",
  // `date -s "2020-01-01"` sets the system clock.
  date: (token) => token === "-s" || token === "--set" || token.startsWith("--set="),
  // `eslint --fix` rewrites sources; `-o/--output-file` writes the report.
  eslint: (token) =>
    token === "--fix" || token === "-o" || token === "--output-file" || token.startsWith("--output-file="),
  // `prettier --write` rewrites sources.
  prettier: (token) => token === "--write" || token === "-w",
  // `rg --pre CMD` runs CMD over every file it searches; `--pager` runs a pager command.
  rg: (token) => token === "--pre" || token.startsWith("--pre=") || token === "--pager" || token.startsWith("--pager="),
  ag: (token) => token === "--pager" || token.startsWith("--pager="),
  ack: (token) => token === "--pager" || token.startsWith("--pager="),
  // `jq -i` edits its input files in place (jq 1.7+).
  jq: (token) => token === "-i" || token === "--in-place" || token.startsWith("--in-place="),
  // `man` is deliberately NOT in the table: `-P pager` / `--pager` / `-H` hand the page to a
  // program of the caller's choosing, so a name-only (or flag-only) entry would be an executor.
};

/** Whole-invocation verdicts for commands whose arguments decide read-only status. */
export const ARGUMENT_GUARDS: Readonly<Record<string, (tokens: string[]) => boolean>> = {
  // `xxd [in [out]]` writes `out` whenever a second operand is present — with or without `-r`
  // (`xxd in out` is a hex dump written to `out`). Only the one-operand forms print to stdout.
  xxd: (tokens) => positionalArgs(tokens).length <= 1,

  // `uniq` takes an OUTPUT file as its second positional operand: `uniq in.txt out.txt` writes
  // `out.txt` and prints nothing. One operand at most.
  uniq: (tokens) => positionalArgs(tokens).length <= 1,

  // `hostname NEWNAME` renames the machine; only the no-operand forms read.
  hostname: (tokens) => positionalArgs(tokens).length === 0,

  // `command -v NAME` looks a name up; `command ANYTHING` RUNS anything.
  command: (tokens) => tokens.slice(1).some((token) => token === "-v" || token === "-V"),

  // `tsc` EMITS JavaScript by default; only `--noEmit` makes it a type check. Requiring the
  // flag (rather than blocking the emitting forms) is the fail-closed direction: a future tsc
  // flag that also writes cannot silently open the gate.
  tsc: (tokens) => tokens.some((token) => token === "--noEmit" || token === "--noEmit=true"),

  git: gitReadOnly,
};

/** Operands — arguments that are neither the command name nor a flag. */
function positionalArgs(tokens: string[]): string[] {
  return tokens.slice(1).filter((token) => token !== "" && !token.startsWith("-"));
}

// ============================================================================
// Git
// ============================================================================

/** Read-only by subcommand; the guard only has to exclude file-writing flags. */
const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "describe",
  "shortlog",
  "whatchanged",
  "merge-base",
  "name-rev",
  "show-ref",
  "for-each-ref",
  "rev-list",
  "cherry",
  "count-objects",
]);

/** `--output[=FILE]` makes a read-only git command create a file. `--output-indicator-*` is not. */
function writesGitFile(token: string): boolean {
  return token === "--output" || token.startsWith("--output=");
}

/** Git global options that appear BEFORE the subcommand and consume a separate value. */
const GIT_GLOBAL_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);

/**
 * Git global options that inject CONFIG or a PROGRAM, so the invocation is not read-only no
 * matter how harmless the subcommand looks.
 *
 * `-c core.pager=…` makes `git log --paginate` execute it; `-c diff.external=…` makes `git diff`
 * execute it; `--exec-path` relocates every git subcommand. All three were previously skipped as
 * ordinary value options, so `git -c core.pager="sh -c id" log` was classified read-only.
 */
const GIT_EXEC_OPTIONS: ReadonlySet<string> = new Set(["-c", "--config-env", "--exec-path"]);

/**
 * Split git's tokens into its subcommand and that subcommand's own arguments.
 *
 * Global options are skipped so `git -C dir log` resolves to `log` rather than to `-C`, and so
 * the table key can be `git log` even though arity normalization kept `-C`.
 * Returns `null` for a shape it cannot follow, which the caller reads as not read-only.
 */
function gitSubcommand(tokens: string[]): { sub: string; args: string[] } | null {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (!token.startsWith("-")) break;
    if (GIT_EXEC_OPTIONS.has(token) || token.startsWith("--config-env=") || token.startsWith("--exec-path=")) {
      return null;
    }
    if (GIT_GLOBAL_VALUE_OPTIONS.has(token)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  const sub = tokens[i];
  if (!sub) return null;
  return { sub: sub.toLowerCase(), args: tokens.slice(i + 1) };
}

/** The table key for a `git …` invocation (`git log`), or `null` when the shape is unknown. */
export function gitTableKey(tokens: string[]): string | null {
  const split = gitSubcommand(tokens);
  return split ? `git ${split.sub}` : null;
}
/**
 * Whether a whole `git …` invocation is read-only.
 *
 * The listing subcommands (`branch`, `tag`, `remote`, `config`, `stash`, `reflog`) switch to
 * mutating on their ARGUMENTS rather than on a flag, which is why they cannot be name-only
 * entries: `git branch` lists but `git branch NAME` creates, and `git tag v1` tags. Each is
 * spelled out below with the form that is actually read-only.
 */
function gitReadOnly(tokens: string[]): boolean {
  const split = gitSubcommand(tokens);
  if (!split) return false;
  const { sub, args } = split;

  if (GIT_READONLY_SUBCOMMANDS.has(sub)) return !args.some(writesGitFile);

  const firstWord = (args[0] ?? "").toLowerCase();
  const operands = positionalArgs(["git", ...args]);

  switch (sub) {
    // `git branch -a` lists; `git branch NAME` creates; `-d/-D/-m/-M/-c/-C/-u` mutate.
    case "branch":
      if (args.some((token) => /^-[dDmMcCu]$/.test(token) || token === "--delete" || token === "--move")) return false;
      return operands.length === 0;

    // `git tag -l` lists; `git tag v1` creates; `-d/-a/-s/-f/-u` mutate.
    case "tag": {
      if (args.some((token) => /^-[dasfu]$/.test(token) || token === "--delete")) return false;
      const listing = args.some(
        (token) =>
          token === "-l" ||
          token === "--list" ||
          token === "-n" ||
          token.startsWith("--contains") ||
          token.startsWith("--points-at") ||
          token.startsWith("--sort") ||
          token.startsWith("--merged") ||
          token.startsWith("--no-merged")
      );
      return listing || operands.length === 0;
    }

    // `git config user.name` / `--get …` read; `git config key value` writes.
    case "config": {
      const mutating = [
        "--unset",
        "--unset-all",
        "--add",
        "--replace-all",
        "--rename-section",
        "--remove-section",
        "--edit",
        "-e",
      ];
      // Scope flags (`--global`, `-f FILE`) are context, not writes; drop them before judging
      // the operands, or `git config --global --get user.name` would look like an assignment.
      const shape = args.filter(
        (token) => !["--global", "--system", "--local", "--worktree", "-f", "--file"].includes(token)
      );
      if (shape.some((token) => mutating.includes(token))) return false;
      const reads = shape.some(
        (token) =>
          token === "--get" || token === "--get-all" || token === "--get-regexp" || token === "--list" || token === "-l"
      );
      if (reads) return true;
      // One operand is a key lookup; two assign a value.
      return positionalArgs(["git", ...shape]).length <= 1;
    }

    // `git remote` / `-v` list; `show` / `get-url` read; add/remove/rename/set-* mutate.
    case "remote":
      return operands.length === 0 || firstWord === "show" || firstWord === "get-url";

    // Only `git stash list` reads.
    case "stash":
      return firstWord === "list" && !args.some(writesGitFile);

    // `git reflog` and `git reflog show` read; `expire` / `delete` rewrite the log.
    case "reflog":
      return firstWord === "" || firstWord === "show" || firstWord.startsWith("-");

    default:
      return false;
  }
}

// ============================================================================
// Lookup
// ============================================================================

/** Whether a token list carries a flag that makes the named command write. */
export function hasWriteModeToken(name: string, tokens: string[]): boolean {
  const probe = WRITE_MODE_TOKENS[name];
  if (!probe) return false;
  return tokens.slice(1).some(probe);
}

/**
 * Whether an invocation of a table-listed command is read-only.
 *
 * `false` for anything the table does not know, so an unrecognised command keeps the
 * conservative outcome. `git` is keyed by its SUBCOMMAND rather than by the arity-normalized
 * prefix: arity keeps three tokens for `git config` / `git remote` / `git stash`, so
 * `git config --get user.name` normalizes to `git config --get` and would never match a
 * `git config` entry.
 */
export function isReadOnlyInvocation(normalized: string, prefix: string[], tokens: string[]): boolean {
  const name = tokens[0]?.toLowerCase() ?? "";
  // A command-level entry (`git`) matches by NAME, and its argument guard then decides the
  // rest. Looking the command up by its subcommand key instead would require one table row
  // per git subcommand, which is what `gitReadOnly` already encodes.
  const matched =
    READONLY_PREFIXES.has(name) || READONLY_PREFIXES.has(normalized) || READONLY_PREFIXES.has(prefix.join(" "));
  if (!matched) return false;
  if (hasWriteModeToken(name, tokens)) return false;
  const guard = ARGUMENT_GUARDS[name];
  return guard ? guard(tokens) : true;
}
