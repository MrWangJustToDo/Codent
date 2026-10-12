import { SEARCH_COMMAND_TIMEOUT, SEARCH_OUTPUT_BYTE_LIMIT, looksLikeMissingBinary } from "./search-command.js";

import type { CoreEnv } from "../../../env";

/** Outcome of an argv-based external command. */
export interface ExecArgsResult {
  stdout: string;
  stderr: string;
  /**
   * Process exit status, or `null` when the process produced none (never launched, or killed).
   */
  code: number | null;
  /** True when the binary could not be launched at all (absent, or not executable). */
  missing: boolean;
  /** True when the process was killed (timeout or abort) and so has no exit status. */
  killed: boolean;
}

/**
 * Run an external binary with an explicit argument vector, without a shell.
 *
 * This is the replacement for building shell command strings. Strings cannot be portable:
 * syntax valid in one shell is a parse error in another (`set -o pipefail` is not a
 * PowerShell option), so any tool that concatenates a command has silently committed to a
 * single shell family. Passing argv sidesteps the question entirely — nothing is re-parsed,
 * re-quoted, or expanded.
 *
 * Returns `missing: true` rather than throwing when the binary is absent, so callers can
 * treat "not installed" as a normal branch (which is how search tools choose between
 * candidates).
 *
 * Also treats a `null` result as missing. The remote client returns null when a server does
 * not implement the exec-file route, and dereferencing that produced a TypeError — a crash
 * where callers were written to handle an absence.
 *
 * IMPORTANT: a non-zero exit is NOT a reason to discard stdout. `find` exits non-zero after
 * printing usable hits (an unreadable subdirectory is enough) and ripgrep/grep exit 1/2 to mean
 * "no matches". Only `missing` — the binary never ran — justifies falling through to another
 * candidate; anything else that produced output is a result.
 */
export async function execArgs(
  env: CoreEnv,
  file: string,
  args: string[],
  timeout = SEARCH_COMMAND_TIMEOUT
): Promise<ExecArgsResult> {
  // Feature-detect: hosts without argument-vector execution (a remote environment on an
  // older server, or a runtime with no process API) must degrade rather than fail. The
  // caller decides what fallback to use; reporting `missing` here keeps that decision with
  // the caller instead of silently producing wrong output.
  if (!env.execFile) {
    return { stdout: "", stderr: "", code: null, missing: true, killed: false };
  }

  const result = await env.execFile(file, args, { timeout });
  if (!result) {
    return { stdout: "", stderr: "", code: null, missing: true, killed: false };
  }

  // Prefer the host's own classification when it provides one (the Node adapter does), and fall
  // back to inspecting the text for hosts that only report a status. A host that reports
  // `missing` is authoritative — it knows how spawning failed; the fallback is for the others.
  const code = result.code ?? null;
  const missing = result.missing === true || (code !== 0 && looksLikeMissingBinary(code, result.stderr));
  const killed = result.killed === true;

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code,
    // A killed process never had a chance to be "missing", and must not be reported as such: the
    // distinction decides whether a killed search reads as "no matches" or as a failure.
    missing,
    killed,
  };
}

/**
 * Run a binary and return its stdout, or `undefined` when it produced no usable result.
 *
 * `undefined` means "do not trust this, try the next candidate", and it covers exactly two cases:
 *
 *   - `missing` — the binary could not be launched, so trying the next one is the point
 *   - `killed` — the process was terminated, so an empty stdout is the absence of an answer,
 *     not an answer of zero matches
 *
 * A non-zero exit is deliberately NOT one of them. Returning `undefined` for a status would
 * discard whatever the process managed to print before failing, and would make a failed search
 * indistinguishable from a successful empty one.
 *
 * Also enforces the byte ceiling: a search whose output exceeds
 * {@link SEARCH_OUTPUT_BYTE_LIMIT} is cut here rather than being buffered in full and then
 * discarded by the caller's entry-count truncation. The comparison is on UTF-8 bytes, so it
 * cannot be bypassed by multi-byte content, and the cut goes through `TextEncoder`/
 * `TextDecoder` so a multi-byte character is never split into an invalid one.
 */
export async function execArgsCapture(
  env: CoreEnv,
  file: string,
  args: string[],
  timeout = SEARCH_COMMAND_TIMEOUT
): Promise<string | undefined> {
  const result = await execArgs(env, file, args, timeout);
  if (result.missing || result.killed) return undefined;
  return truncateToBytes(result.stdout, SEARCH_OUTPUT_BYTE_LIMIT);
}

/**
 * Cut a string to at most `maxBytes` of UTF-8, without splitting a multi-byte character.
 *
 * `TextEncoder` gives the true byte size, and decoding with `fatal: false` replaces a
 * truncated lead byte rather than throwing, so the result is always valid text.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

/** True when the host can run binaries with an argument vector (no shell). */
export function canExecArgs(env: CoreEnv): boolean {
  return Boolean(env.execFile);
}
