/**
 * Redirection analysis for the command-safety report.
 *
 * A shell command's risk is not only in its name: `cat < /etc/passwd` reads a file the token view
 * never shows, and `cmd > out.txt` writes one the token view also drops. Both ends of the analysis
 * are here, next to the benign-redirection table they share — one module per concern, so the
 * analyzer's classification loop stays readable and the "read" and "write" questions cannot drift.
 */

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
// `&>word` is `>word 2>&1` — a named file, NOT a descriptor duplication (`cmd &>2` creates a file
// named "2"). Only a null-device target is benign there. The `/dev/null` branch is boundary-anchored
// so `>/dev/null.txt` stays a write.
export const BENIGN_REDIRECTION =
  /(?:[12]?>&[12-]|[12]?>\s*\/dev\/null(?=$|[\s;&|)<>])|&>\s*\/dev\/null(?=$|[\s;&|)<>]))/g;

/** Devices that discard a stream, so opening one is not reading project data. */
const NULL_DEVICES = new Set(["/dev/null", "/dev/zero", "NUL", "nul"]);

/** Strip one pair of matching outer quotes (shared by path and redirection operands). */
export function unquote(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1);
  return text;
}

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
export function hasWriteRedirection(source: string): boolean {
  return />/.test(source.replace(BENIGN_REDIRECTION, " ").replace(/<<<?/g, ""));
}

/**
 * Operands of input redirections (`cmd < file`, `cmd 0< file`, `cmd</etc/passwd`).
 *
 * `<` is not a write, so {@link hasWriteRedirection} deliberately ignores it — but it names a file
 * the command READS, and dropping it left `cat < /etc/passwd` with the tokens `["cat"]` and no path
 * at all: read-only, project-internal, auto-approved. (The same held for the no-space spelling
 * `cat</etc/passwd`, which a regex keyed on a whitespace boundary missed.)
 *
 * This is a small scanner rather than a regex because quotes matter in both directions: a `<`
 * inside `grep "a < /etc/x"` is literal text, while the operand itself may be quoted
 * (`cat < "/etc/passwd"`). Heredocs / here-strings, descriptor duplications (`<&2`) and process
 * substitution (`<(...)`, whose inner command is analyzed on its own) name no file and are
 * skipped. A heredoc *body* is not skipped (the delimiter grammar is per-command); a `<` inside it
 * is treated conservatively as a redirection, which can only ask more often.
 */
export function readRedirectionTargets(source: string): string[] {
  const out: string[] = [];
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch !== "<") {
      i += 1;
      continue;
    }

    const next = source[i + 1];
    // `<<`, `<<<`, `<&` and `<(` are not input files.
    if (next === "<") {
      i += source[i + 2] === "<" ? 3 : 2;
      continue;
    }
    if (next === "&" || next === "(") {
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < source.length && /\s/.test(source[j]!)) j += 1;

    let operand = "";
    const opener = source[j];
    if (opener === '"' || opener === "'") {
      j += 1;
      while (j < source.length && source[j] !== opener) {
        if (source[j] === "\\" && opener === '"') {
          operand += source[j + 1] ?? "";
          j += 2;
          continue;
        }
        operand += source[j];
        j += 1;
      }
      j += 1; // closing quote
    } else {
      while (j < source.length && !/[\s;|&()<>]/.test(source[j]!)) {
        operand += source[j];
        j += 1;
      }
    }

    if (operand && !NULL_DEVICES.has(operand)) out.push(operand);
    i = j;
  }

  return out;
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
export function hasWriteRedirectionAcrossCommands(command: string): boolean {
  // Strip benign redirections BEFORE splitting on `&` / `|`: the separators cut `2>&1` into
  // `2>` and `1`, and the orphaned `>` then reads as a write in an otherwise read-only line.
  return command
    .replace(BENIGN_REDIRECTION, " ")
    .split(/&&|\|\||[;|\n]|&/)
    .some((segment) => hasWriteRedirection(segment));
}
