/**
 * Command arity normalization — map a command's tokens to a normalized
 * "command + subcommand" prefix (e.g. `git checkout main` → `git checkout`).
 *
 * Ported (subset) from opencode's `permission/arity.ts`: each entry maps a
 * leading command prefix to the number of leading tokens to keep; longer
 * prefixes win (longest match first), so flags and extra arguments are
 * dropped. Pure functions — no runtime dependencies.
 */

/**
 * Leading command prefix → number of tokens to keep.
 *
 * `npm` → 2 keeps `npm install`, `npm exec ...` → 3 keeps `npm exec vite`.
 * Flags are never counted: they follow the normalized prefix.
 */
const ARITY: Record<string, number> = {
  // Single-command tools (arity 1 — the bare command is the normalized prefix).
  cat: 1,
  cd: 1,
  chmod: 1,
  chown: 1,
  cp: 1,
  dirname: 1,
  echo: 1,
  env: 1,
  find: 1,
  git: 2,
  "git config": 3,
  "git remote": 3,
  "git stash": 3,
  go: 2,
  grep: 1,
  head: 1,
  kill: 1,
  ls: 1,
  make: 2,
  mkdir: 1,
  mv: 1,
  node: 2,
  npm: 2,
  "npm exec": 3,
  "npm init": 3,
  "npm run": 3,
  "npm view": 3,
  pnpm: 2,
  "pnpm dlx": 3,
  "pnpm exec": 3,
  "pnpm run": 3,
  printf: 1,
  ps: 1,
  pwd: 1,
  python: 2,
  "python -m": 3,
  rm: 1,
  rmdir: 1,
  sed: 1,
  sort: 1,
  tail: 1,
  touch: 1,
  uname: 1,
  wc: 1,
  which: 1,
  yarn: 2,
  "yarn dlx": 3,
  "yarn run": 3,

  // ---- Windows-native commands (cmd.exe) ----
  // Additive: entries sit beside the POSIX ones so classification is not Unix-only. Without
  // them a Windows command normalizes to a prefix the read-only set cannot match, so every
  // such command looked unrecognised and a subagent's `run_command` was denied outright.
  dir: 1,
  type: 1,
  where: 1,
  findstr: 1,
  copy: 1,
  del: 1,
  erase: 1,
  md: 1,
  rd: 1,
  ren: 1,
  rename: 1,
  move: 1,
  more: 1,
  tasklist: 1,
  taskkill: 1,
};

/**
 * Normalize a command's tokens into its command + subcommand prefix.
 *
 * Mirrors opencode's `BashArity.prefix`: tries the longest leading prefix
 * that exists in {@link ARITY} and keeps that many tokens; falls back to the
 * first token (the command name itself).
 */
export function commandPrefix(tokens: string[]): string[] {
  for (let len = Math.min(tokens.length, 8); len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ");
    // Look the prefix up under both spellings of the first token, and return the *canonical*
    // spelling of that first token while keeping the rest of the matched prefix intact.
    //
    // Canonicalizing the joined string instead (and pushing it as one element) is what introduced
    // a regression here: a multi-word prefix like `npm exec` became a single token, so the
    // returned array lost its shape — `["npm exec", "exec", "vite"]` where callers expect
    // `["npm", "exec", "vite"]`. Only the command name is ever canonicalized; subcommands and
    // arguments are left exactly as written.
    const firstCanonical = canonicalizeCommandName(tokens[0] ?? "");
    const canonicalLookup = [firstCanonical, ...tokens.slice(1, len)].join(" ");
    const arity = ARITY[prefix] ?? ARITY[canonicalLookup];
    if (arity !== undefined) {
      return [firstCanonical, ...tokens.slice(1, Math.max(arity, 1))];
    }
  }
  if (tokens.length === 0) return [];
  return [canonicalizeCommandName(tokens[0] ?? "")];
}

/**
 * The lookup spelling of a command name: lowercase, without a Windows executable extension.
 *
 * `.exe` is stripped rather than kept as a separate table entry so `where` and `where.exe` cannot
 * drift apart — the previous table listed only `where`, and the `.exe` spelling that cmd.exe
 * actually reports was denied.
 *
 * Only `.exe` is stripped. `.cmd`/`.bat` wrappers are a *different* program with different
 * behaviour (`npm` is a `.cmd` shim), so folding them into their bare name would grant read-only
 * status to something that was never classified.
 */
export function canonicalizeCommandName(name: string): string {
  const lower = name.toLowerCase();
  return lower.endsWith(".exe") ? lower.slice(0, -4) : lower;
}

/** Normalized prefix joined as a string (e.g. `"git status"`). */
export function normalizedCommand(tokens: string[]): string {
  return commandPrefix(tokens).join(" ");
}

/** The raw command name (first token, lowercased). */
export function commandName(tokens: string[]): string {
  return tokens[0]?.toLowerCase() ?? "";
}
