/**
 * Which tokens of a command are an OPTION'S VALUE rather than a file operand.
 *
 * The generic path extractor keeps every non-dash token, so `tree -P '*.ts'` / `diff -x '*.o'` /
 * `rg -g '*.ts'` resolved the pattern as a path. A leading glob has no static prefix, which the
 * analyzer reports as an unresolvable external path — so an ordinary read-only command required
 * approval on the main agent and was denied outright for a subagent. The tables here describe only
 * the flags whose values are commonly non-path (patterns, numbers, type names); everything else is
 * still treated as a path, which is the safe direction.
 *
 * `awk` / `jq` also take their PROGRAM as the first positional, which is handled separately because
 * `$1` / `$x` inside it would otherwise look like an unresolved variable path.
 */

/** Options whose next token(s) are values: `command -> flag -> value count` (jq's `--arg` takes 2). */
const FLAG_VALUE_COUNTS: Record<string, Readonly<Record<string, number>>> = {
  tree: { "-I": 1, "-P": 1, "-L": 1, "--ignore": 1, "--charset": 1, "--sort": 1, "--timefmt": 1, "--filelimit": 1 },
  diff: {
    "-x": 1,
    "-I": 1,
    "-U": 1,
    "-C": 1,
    "-F": 1,
    "-W": 1,
    "--exclude": 1,
    "--ignore-matching-lines": 1,
    "--label": 1,
    "--horizon-lines": 1,
    "--width": 1,
    "--tabsize": 1,
  },
  column: { "-s": 1, "-c": 1, "-o": 1, "-R": 1, "-W": 1 },
  awk: { "-F": 1, "-v": 1 },
  // `--slurpfile NAME FILE` / `--rawfile NAME FILE` read FILE, so only the NAME is dropped.
  jq: { "--arg": 2, "--argjson": 2, "--indent": 1, "--slurpfile": 1, "--rawfile": 1 },
  // Search engines: patterns / types / numbers, never files.
  rg: {
    "-g": 1,
    "--glob": 1,
    "-t": 1,
    "--type": 1,
    "-T": 1,
    "--type-not": 1,
    "--type-add": 1,
    "-A": 1,
    "-B": 1,
    "-C": 1,
    "-m": 1,
    "--max-count": 1,
    "-j": 1,
    "--max-depth": 1,
    "-r": 1,
    "--replace": 1,
    "--context-separator": 1,
  },
  ag: { "-G": 1, "--file-search-regex": 1, "-m": 1, "--max-count": 1, "--depth": 1, "-A": 1, "-B": 1, "-C": 1 },
  ack: { "-g": 1, "--match": 1, "-m": 1, "--max-count": 1, "-A": 1, "-B": 1, "-C": 1, "--type": 1 },
};

/** Indices (into `tokens`, including index 0) that are an option value, not an operand. */
export function optionValueIndexes(tokens: string[]): Set<number> {
  const counts = FLAG_VALUE_COUNTS[tokens[0]?.toLowerCase() ?? ""];
  const out = new Set<number>();
  if (!counts) return out;
  for (let i = 1; i < tokens.length; i += 1) {
    const count = counts[tokens[i]!];
    if (count === undefined) continue;
    for (let k = 1; k <= count; k += 1) out.add(i + k);
  }
  return out;
}

/** Commands whose first positional is a program/filter, not a file (unless an option supplies it). */
export const PROGRAM_FIRST_COMMANDS = new Set(["awk", "jq"]);

/** Whether the program/filter comes from an option (`awk -f FILE`, `jq --from-file FILE`). */
export function programSuppliedByOption(name: string, tokens: string[]): boolean {
  if (name === "awk") {
    return tokens.some(
      (token) => token === "-f" || token === "--file" || token.startsWith("--file=") || /^-f./.test(token)
    );
  }
  return tokens.some((token) => token === "-f" || token === "--from-file" || token.startsWith("--from-file="));
}
