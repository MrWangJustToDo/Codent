import { ExecutionError } from "../../../../env/types";
import { truncateToUtf8Bytes } from "../../../../utils/bytes.js";
import {
  SEARCH_COMMAND_TIMEOUT,
  SEARCH_OUTPUT_BYTE_LIMIT,
  looksLikeMissingBinary,
} from "../fs/search/search-command.js";

import type { CoreEnv } from "../../../../env";

/** Options shared by {@link execArgs} and {@link execArgsCapture}. */
export interface ExecArgsOptions {
  /**
   * Working directory for the child process. Omitted means the host's own default, which is the
   * wrong tree for a search tool unless the process cwd happens to equal the workspace root —
   * callers pass {@link CoreEnv.rootPath} so resolution is anchored there.
   */
  cwd?: string;
  /** Milliseconds before the child is killed. Defaults to {@link SEARCH_COMMAND_TIMEOUT}. */
  timeout?: number;
  /**
   * The RUN's signal, forwarded to the host so the child dies with the run instead of running to
   * its deadline. A search tool that ignores it keeps burning CPU on a workspace the user has
   * already stopped looking at, and — worse — reports the empty stdout of the killed child as "no
   * matches" (see {@link execArgs}).
   */
  signal?: AbortSignal;
}

/** The one shape a run abort is reported in (see {@link execArgs}). */
function abortedCommand(file: string): ExecutionError {
  return new ExecutionError("aborted", `"${file}" was stopped with the run`);
}

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
  /** True when the host stopped capturing at its buffer ceiling and stdout is partial. */
  truncated: boolean;
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
 *
 * THROWS `ExecutionError("aborted")` when `options.signal` aborted. That is the one exception to
 * "returns a shape rather than throwing", and it is deliberate: the candidates are a chain
 * (`rg` → `grep`, `fd` → `find`), so a killed child returning empty stdout would be read as
 * "try the next binary" and end at "no matches" — the one verdict that is certainly wrong for a
 * search that never finished. Callers catch it with the signal they passed (see
 * `isAbortError`) and report the run as cancelled.
 *
 * SCOPE: the signal reaches the host only where the host takes one. A local Node host kills the child
 * (`execFile`/`runCommand` accept a signal). Over a remote CoreEnv it does NOT: the command routes declare
 * no signal field and the client sends only `{ cwd, timeout, env }`, so a remote search runs to its own
 * deadline and this check fires only once it returns. That is the remote half of the search-abort item in
 * docs/tool-audit-findings.md, and it needs the HTTP contract to change (an OpenSpec change), not a
 * caller.
 */
export async function execArgs(
  env: CoreEnv,
  file: string,
  args: string[],
  options: ExecArgsOptions = {}
): Promise<ExecArgsResult> {
  // Feature-detect: hosts without argument-vector execution (a remote environment on an
  // older server, or a runtime with no process API) must degrade rather than fail. The
  // caller decides what fallback to use; reporting `missing` here keeps that decision with
  // the caller instead of silently producing wrong output.
  if (!env.execFile) {
    return { stdout: "", stderr: "", code: null, missing: true, killed: false, truncated: false };
  }

  // Never spawn for a run that is already over: the child would be killed immediately anyway, and
  // on a host that cannot be told the signal it would run in full.
  if (options.signal?.aborted) throw abortedCommand(file);

  const result = await env.execFile(file, args, {
    timeout: options.timeout ?? SEARCH_COMMAND_TIMEOUT,
    cwd: options.cwd,
    signal: options.signal,
  });
  if (!result) {
    return { stdout: "", stderr: "", code: null, missing: true, killed: false, truncated: false };
  }

  // Prefer the host's own classification when it provides one (the Node adapter does), and fall
  // back to inspecting the text for hosts that only report a status. A host that reports
  // `missing` is authoritative — it knows how spawning failed; the fallback is for the others.
  // The signal is the strongest evidence of why the child died: a timeout and an abort both arrive
  // as `killed` with no status, so the host cannot be the one to tell them apart (see
  // `isAbortError`). Checked before the shape below is returned.
  if (options.signal?.aborted) throw abortedCommand(file);

  const code = result.code ?? null;
  const missing = result.missing === true || (code !== 0 && looksLikeMissingBinary(code, result.stderr));
  const killed = result.killed === true;
  const truncated = result.truncated === true;

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code,
    // A killed process never had a chance to be "missing", and must not be reported as such: the
    // distinction decides whether a killed search reads as "no matches" or as a failure.
    missing,
    killed,
    truncated,
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
  options: ExecArgsOptions = {}
): Promise<string | undefined> {
  const result = await execArgs(env, file, args, options);
  // A buffer-ceiling kill still carries usable partial output. A plain kill (timeout or
  // abort) does not: returning its partial output as a complete answer would be a lie.
  if (result.missing || (result.killed && !result.truncated)) return undefined;
  return truncateToUtf8Bytes(result.stdout, SEARCH_OUTPUT_BYTE_LIMIT).text;
}

/** True when the host can run binaries with an argument vector (no shell). */
export function canExecArgs(env: CoreEnv): boolean {
  return Boolean(env.execFile);
}
