/**
 * Tokenizer for command strings when no grammar is available.
 *
 * The grammar path (`command-parser.ts` → tree-sitter bash) gives a real AST. When the target
 * shell has no bundled grammar — PowerShell and cmd.exe today — there is nothing to parse
 * with, so the analyzer needs a token view that is good enough to name the commands in a
 * pipeline or chain.
 *
 * Splits on the separators that introduce a *new* command (`;`, `&&`, `||`, `|`, newline) and
 * on command substitution (`$(...)`, backticks), and otherwise does simple quote-aware word
 * splitting. It makes no attempt to interpret the rest of shell syntax, because anything it
 * cannot understand must end up classified as unknown → not read-only → the conservative
 * approval outcome.
 *
 * SECURITY NOTE — why command substitution is split.
 *
 * An earlier version of this file argued that under-splitting is safe "because a missed command
 * means the report has fewer known commands, and read-only is granted only when *every*
 * command is read-only." That reasoning is wrong, and it hid a real fail-open: as long as the
 * one command the tokenizer *did* see was read-only, the gate opened — the missed command was
 * not a missing vote against, it was simply absent from the vote.
 *
 * Concretely, `echo "$(rm -rf /repo/src)"` tokenized to a single command `echo`, `echo` is
 * read-only, and the whole string was granted read-only status. The substitution's `rm` was
 * never classified, so nothing could deny it. That is the opposite of fail-safe, and it
 * mattered most on exactly the platforms this module exists for (no bash grammar → fallback).
 *
 * Missing a command is therefore the *dangerous* direction, not a safe one. Over-splitting
 * remains harmless: extra tokens are unrecognised names that simply are not read-only.
 *
 * Substitution is honoured only where a shell would honour it: inside single quotes it is
 * literal text, so it is not executed and not split.
 */

/** Separators that begin a new command within a compound command string. */
const COMMAND_SEPARATORS = [";", "&&", "||", "|", "\n", "&"];

/**
 * Stands in for a substitution's output in the outer token stream.
 *
 * The real value cannot be known without running it, and it only ever occupies an argument
 * position in the outer command, so a placeholder is enough to keep the token positions
 * intact. It is deliberately not a name any read-only table matches.
 */
const SUBSTITUTION_PLACEHOLDER = "__substitution__";

/** Bound on substitution nesting, so a pathological input cannot recurse without limit. */
const MAX_SUBSTITUTION_DEPTH = 8;

/**
 * Split a command string into per-command token arrays.
 *
 * Quote-aware: separators inside single or double quotes are literal. Quotes are stripped from
 * the resulting tokens so `commandName` sees `git`, not `'git'`.
 *
 * Commands inside a command substitution are emitted as their own entries, because they really
 * do execute — see the security note above.
 */
export function tokenizeCommandString(command: string): string[][] {
  const commands: string[][] = [];
  collectCommands(command, commands, 0);
  return commands;
}

/** Tokenize `command`, then recurse into each command substitution's body. */
function collectCommands(command: string, out: string[][], depth: number): void {
  if (depth > MAX_SUBSTITUTION_DEPTH) {
    // Too deeply nested to reason about. Emit the raw text as one unrecognised command, which
    // is not read-only — never grant on a structure this module cannot follow.
    out.push([command]);
    return;
  }

  const { flattened, substitutions } = extractSubstitutions(command);

  // The outer command goes first so a denial message names what the user actually typed.
  out.push(...splitTopLevelCommands(flattened));

  for (const body of substitutions) {
    collectCommands(body, out, depth + 1);
  }
}

/**
 * Whether a command string contains a command substitution.
 *
 * Used by the analyzer as a trust guard: a substitution body is a command that really
 * executes, so a parse that did not surface it says nothing about the whole string. Exposed
 * so the fallback and the AST path cannot disagree about what counts as a substitution.
 */
export function hasCommandSubstitution(command: string): boolean {
  return extractSubstitutions(command).substitutions.length > 0;
}

/**
 * Replace every command substitution with a placeholder, returning the bodies separately.
 *
 * Recognises `$(...)` (with balanced nested parens) and `` `...` ``. A `$((...))` arithmetic
 * expansion is *not* a command substitution and is left as ordinary text. Substitutions inside
 * single quotes are literal to a shell, so they are left untouched.
 */
function extractSubstitutions(command: string): { flattened: string; substitutions: string[] } {
  const substitutions: string[] = [];
  let flattened = "";
  let singleQuoted = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;

    // A backslash escapes the next character outside single quotes.
    if (char === "\\" && !singleQuoted && i + 1 < command.length) {
      flattened += char + command[i + 1]!;
      i += 1;
      continue;
    }

    if (char === "'") {
      singleQuoted = !singleQuoted;
      flattened += char;
      continue;
    }

    if (singleQuoted) {
      flattened += char;
      continue;
    }

    // Arithmetic expansion `$((...))`, not a command substitution.
    if (char === "$" && command[i + 1] === "(" && command[i + 2] === "(") {
      flattened += char;
      continue;
    }

    if (char === "$" && command[i + 1] === "(") {
      const end = findMatchingParen(command, i + 1);
      if (end !== -1) {
        substitutions.push(command.slice(i + 2, end));
        flattened += SUBSTITUTION_PLACEHOLDER;
        i = end;
        continue;
      }
      // Unbalanced: leave it as text so it cannot be mistaken for a complete command.
      flattened += char;
      continue;
    }

    if (char === "`") {
      const end = findClosingBacktick(command, i + 1);
      if (end !== -1) {
        substitutions.push(command.slice(i + 1, end));
        flattened += SUBSTITUTION_PLACEHOLDER;
        i = end;
        continue;
      }
      flattened += char;
      continue;
    }

    flattened += char;
  }

  return { flattened, substitutions };
}

/** Index of the `)` matching the `(` at `openIndex`, or -1. Ignores quoted and escaped parens. */
function findMatchingParen(command: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;

  for (let i = openIndex; i < command.length; i += 1) {
    const char = command[i]!;

    if (char === "\\" && quote !== "'") {
      i += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/** Index of the backtick closing the one at `startIndex`, or -1. An escaped backtick is literal. */
function findClosingBacktick(command: string, startIndex: number): number {
  for (let i = startIndex; i < command.length; i += 1) {
    const char = command[i]!;
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "`") return i;
  }
  return -1;
}

/** The original quote-aware split: separators, redirection stripping, whitespace. */
function splitTopLevelCommands(command: string): string[][] {
  const commands: string[][] = [];
  let current: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;

  const flushToken = () => {
    if (token.length > 0) {
      current.push(stripQuotes(token));
      token = "";
    }
  };

  const flushCommand = () => {
    flushToken();
    if (current.length > 0) commands.push(current);
    current = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (quote) {
      token += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      token += char;
      continue;
    }

    // Two-character separators first so `&&` is not read as two `&`.
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      flushCommand();
      i += 1;
      continue;
    }

    if (COMMAND_SEPARATORS.includes(char!)) {
      flushCommand();
      continue;
    }

    // Redirections are dropped, matching the AST path (`commandParts` skips them). Both the
    // operator and its target must go, or `> out.txt` would leave `out.txt` as a command
    // token, and a file-descriptor prefix (`2>` in `2>&1`) must not survive either.
    if (char === ">" || char === "<") {
      // A pending all-digits token is a file descriptor, not an argument.
      if (/^\d+$/.test(token)) token = "";
      else flushToken();

      i += 1;
      if (command[i] === ">" || command[i] === "<") i += 1; // `>>`, `<<`
      if (command[i] === "&") i += 1; // `>&`, `<&`
      while (i < command.length && /\s/.test(command[i]!)) i += 1;
      // Consume the target word (the `&1` of `>&1` is already behind us).
      while (i < command.length && !/\s/.test(command[i]!) && !COMMAND_SEPARATORS.includes(command[i]!)) {
        i += 1;
      }
      i -= 1; // the for-loop increment moves past what we consumed
      continue;
    }

    if (/\s/.test(char!)) {
      flushToken();
      continue;
    }

    token += char;
  }

  flushCommand();
  return commands;
}

/** Strip one matching outer quote pair, and unescape the shell's `\"` inside double quotes. */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      const inner = token.slice(1, -1);
      return first === '"' ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
    }
  }
  return token;
}
