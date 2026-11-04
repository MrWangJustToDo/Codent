/**
 * Path-bearing command sets and operand extraction for the command-safety report.
 *
 * The analyzer decides whether a command is read-only; this module decides WHICH arguments of it
 * are files. The two questions are separate, and keeping the sets next to the extractor is what
 * lets a new read-only command be added in one place without the path axis silently missing it.
 */

import { optionValueIndexes, PROGRAM_FIRST_COMMANDS, programSuppliedByOption } from "./option-values.js";

/**
 * Commands whose operands are paths but whose names are not "file commands".
 *
 * `git` is here because its *global options* take directories: `git -C /etc log` and
 * `git --git-dir=/etc/.git log` read outside the workspace while the command text looks read-only.
 * Without the name in this set, `pathArgs` never ran for git at all, so the analyzer returned an
 * auto-approved read. (The subcommand itself stays classified by the read-only table.)
 */
export const PATH_OPERAND_COMMANDS = new Set(["git"]);

/**
 * Read-only commands whose *operands* are files but which are not in {@link READ_FILE_COMMANDS}.
 *
 * Their names pass {@link classifyReadOnly}, so before this set existed the path axis never ran
 * for them: `base64 ~/.ssh/id_rsa`, `tree /etc`, `strings /etc/shadow`, `xxd /etc/passwd` all
 * reported `isReadOnly: true` with `anyExternalDir: false` and were auto-approved (and allowed for
 * subagents, which have no approval UI). The set is consulted by the SAME path loop as the file
 * commands, so the two classifications cannot drift apart again.
 */
export const PATH_INSPECTION_COMMANDS = new Set([
  // file metadata / inspection
  "stat",
  "file",
  "readlink",
  "realpath",
  "du",
  "df",
  "tree",
  "column",
  // content dumps / transforms that read their positional operands
  "diff",
  "hexdump",
  "od",
  "strings",
  "jq",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "base64",
  "xxd",
  "cut",
  "uniq",
  "awk",
  // Search engines: their positional operands are paths, the first one is the pattern (see
  // `PATTERN_FIRST_COMMANDS`). Missing them kept `rg secret /etc/passwd` auto-approved.
  "rg",
  "ag",
  "ack",
]);

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
export function pathArgs(tokens: string[]): string[] {
  const name = tokens[0]?.toLowerCase() ?? "";
  // `find` is the one command whose remaining arguments are a small expression language: only the
  // leading starting points are paths (see {@link findStartingPoints}).
  if (name === "find") return findStartingPoints(tokens);

  // Values of known value-taking flags are not operands (`tree -P '*.ts'`, `diff -x '*.o'`,
  // `rg -g '*.ts'`) — see `option-values.ts`.
  const valueIndexes = optionValueIndexes(tokens);

  const args = tokens.slice(1).filter((item, index) => {
    if (valueIndexes.has(index + 1)) return false;
    if (item.startsWith("-")) return false;
    if (name === "chmod" && item.startsWith("+")) return false;
    return true;
  });

  if (PATH_OPERAND_COMMANDS.has(name)) {
    return Array.from(new Set([...args, ...gitDirectoryOperands(tokens)]));
  }

  if (PROGRAM_FIRST_COMMANDS.has(name)) {
    // `awk`/`jq` take their program/filter first. Leaving it in the path axis made `$1` / `$x`
    // look like an unresolvable variable path — a subagent could not run `awk '{print $1}' file`.
    return programSuppliedByOption(name, tokens) ? args : args.slice(1);
  }

  if (PATTERN_FIRST_COMMANDS.has(name)) {
    // The first positional is the PATTERN only when the pattern is not supplied by an option.
    // `grep -f /etc/passwd src/index.ts` used to drop `/etc/passwd` as "the pattern" and approve the
    // read; with `-e`/`-f` every positional is a file.
    const positional = grepPatternFromOption(tokens) ? args : args.slice(1);
    // Attached short/`--file=` values are inside a dash token, so the filter above dropped them.
    return Array.from(new Set([...positional, ...grepAttachedFileValues(tokens)]));
  }

  return args;
}

/**
 * Directories carried by git's global options: `-C <dir>`, `--git-dir[=]<dir>`,
 * `--work-tree[=]<dir>`.
 *
 * `-C`'s value is also a plain positional (so it is already in `args`); the `=` forms and the
 * separate `--git-dir <dir>` value are not, because the dash filter drops the option token.
 */
function gitDirectoryOperands(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
      const value = tokens[i + 1];
      if (value !== undefined && !value.startsWith("-")) out.push(value);
    } else if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
      out.push(token.slice(token.indexOf("=") + 1));
    }
  }
  return out;
}

/**
 * Whether a `grep`-family invocation takes its pattern from an option (`-e` / `-f` and their long
 * forms, including attached values and short-flag clusters).
 */
function grepPatternFromOption(tokens: string[]): boolean {
  return tokens.some(
    (token, index) =>
      index > 0 &&
      (token === "-e" ||
        token === "--regexp" ||
        token.startsWith("--regexp=") ||
        token === "-f" ||
        token === "--file" ||
        token.startsWith("--file=") ||
        /^-[A-Za-z]*[ef]/.test(token))
  );
}

/** Paths carried INSIDE a `-f` cluster (`-fFILE`, `-rfFILE`) or `--file=FILE`. */
function grepAttachedFileValues(tokens: string[]): string[] {
  const out: string[] = [];
  for (const token of tokens.slice(1)) {
    if (token.startsWith("--file=")) {
      out.push(token.slice("--file=".length));
      continue;
    }
    const match = /^-[A-Za-z]*f(.+)$/.exec(token);
    if (match) out.push(match[1]!);
  }
  return out;
}
