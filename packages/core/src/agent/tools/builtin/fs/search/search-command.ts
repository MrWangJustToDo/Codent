import { defaultPath } from "../../../../../env";
import { FileError } from "../../../../../env/types";
import { splitDisplayLines } from "../../../../../utils/display-lines.js";
import { toPosixPathKey } from "../../../../../utils/posix-path.js";

import type { CoreEnv } from "../../../../../env";

/** Default command timeout in ms */
export const SEARCH_COMMAND_TIMEOUT = 30_000;

/**
 * Byte ceiling for captured search output.
 *
 * Truncation to the requested entry count happens after capture, so without a ceiling a
 * search over a huge tree would buffer everything before discarding most of it.
 *
 * Applied against the UTF-8 byte size, not JS string length: `"é".length` is 1 but its UTF-8
 * size is 2, so a `.length` comparison would let a multi-byte-heavy result through at up to
 * several times this ceiling.
 */
export const SEARCH_OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;

/**
 * Exit codes meaning "the shell could not find the command binary".
 *
 * POSIX shells use 127. cmd.exe uses 9009 for "is not recognized as an internal or external
 * command". 127 is also what a host adapter should report for a Node spawn failure
 * (`err.code === "ENOENT"`) — and that is the case that matters most here, because `ENOENT` is
 * a *string* code: an adapter that coerces it to `1` produces a value no detector can
 * recognise, which is exactly how the fallback silently stopped being reachable.
 */
export const COMMAND_NOT_FOUND_CODES = new Set([127, 9009]);

/** Whether an exit code means "binary not found" on any platform. */
export function isCommandNotFound(exitCode: number | null | undefined): boolean {
  return typeof exitCode === "number" && COMMAND_NOT_FOUND_CODES.has(exitCode);
}

/**
 * Evidence that a failed launch was "binary absent" rather than "ran and failed".
 *
 * Deliberately narrow. An earlier version matched `no such file or directory`, which any tool
 * emits about a missing *input* file — so a genuine failure inside `find` looked like a
 * missing `find`. Only messages that name the executable are matched:
 *
 * - a Node spawn failure: `spawn rg ENOENT`
 * - a shell's own report: `sh: 1: rg: not found`, `rg: command not found`,
 *   `'rg' is not recognized as an internal or external command`
 */
export function looksLikeMissingBinary(exitCode: number | null | undefined, stderr: string): boolean {
  // `null` means "no exit status", which is a kill or a failure to launch — never evidence that
  // a *different* binary is missing. Treating it as missing would turn a killed search into a
  // silent fallthrough, hiding the real cause.
  if (exitCode === null || exitCode === undefined) return false;
  if (isCommandNotFound(exitCode)) return true;
  return /\b(ENOENT|EACCES)\b|command not found|is not recognized as an internal or external|:\s*not found\b/i.test(
    stderr
  );
}

/**
 * Truncate captured output to at most `count` lines, in-process.
 *
 * Replaces the previous `| head -n <count>` shell pipeline. Doing this in JS is what lets
 * the search tools run without a shell, which is the only way to stay shell-agnostic — a
 * pipeline valid in bash is a parse error in PowerShell. Also drops a single trailing
 * empty line so the boundary matches `head`'s output for a trailing newline.
 */
export function truncateLines(output: string, count: number): string {
  if (count <= 0) return "";
  return splitDisplayLines(output, { normalizeCrlf: false, dropTrailingEmpty: true }).slice(0, count).join("\n");
}

/**
 * POSIX-quote one argument for the legacy shell path.
 *
 * Reached only when the host cannot execute with an argv vector — a remote environment on a
 * server that predates the exec-file route. That makes this a compatibility shim, so it
 * keeps the POSIX assumption the previous implementation already made. It must not
 * reintroduce a `pipefail` prefix, stderr redirection, or a `head` pipeline: truncation
 * stays in JS on every path so the shell is never responsible for correctness.
 */
export function quoteForShell(arg: string): string {
  if (/^[A-Za-z0-9_\-./=]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve a search tool's caller-supplied `path` against the workspace root and reject escapes.
 *
 * The search tools spawn external binaries (`fd`/`find`, `rg`/`grep`, `tree`) that read the
 * filesystem directly, so they never pass through `CoreEnv.fs` and its traversal guard
 * (`resolvePath` in the Node adapter). Without a check here, `grep { path: "/etc" }` or
 * `path: "../../.."` reads outside the workspace with no approval — these are auto-approved
 * read-only tools. This restates the same rule the fs layer already enforces, for the one
 * path that bypasses it.
 *
 * Resolution is anchored to {@link CoreEnv.rootPath}, never `process.cwd()`: on a host whose
 * cwd differs from the workspace root (server `ROOT_PATH`, `codent acp --cwd`, a remote env) a
 * default `"."` must mean the workspace root, not wherever the process happens to be. The
 * comparison folds to a canonical forward-slash key ({@link toPosixPathKey}) so a Windows
 * separator cannot produce a false verdict — the same rule `containsPath` uses.
 *
 * Returns the caller's original path string (relative stays relative), so the binary's output
 * paths remain root-relative exactly as before; only the `cwd` handed to the spawn anchors
 * resolution to the root. When the host exposes `fs.realpath`, the real path is also required
 * to stay inside the real workspace root (a lexical check alone cannot see a symlink).
 * Throws the fs layer's traversal error ({@link FileError} `permission_denied`) on an escape,
 * so callers surface one error shape.
 */
export async function resolveSearchPath(coreEnv: CoreEnv, inputPath: string | undefined): Promise<string> {
  const path = coreEnv.path ?? defaultPath;
  // Keep a legitimate path whose name starts/ends with a space; only fall back to the
  // workspace root when the value is missing or contains no non-whitespace characters.
  const raw = inputPath && inputPath.trim().length > 0 ? inputPath : ".";
  const resolved = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(coreEnv.rootPath, raw);
  // A Windows host compares paths case-insensitively, so a case-only difference from the root is
  // the same place rather than an escape. The separator is the one synchronous platform signal a
  // `CoreEnvPath` exposes (`pathe`/POSIX report "/"), and it mirrors the fold in `@codent/node`'s
  // fs gate. Folding is permissive only for this guard: the value returned — and searched — stays
  // the caller's own string.
  const foldCase = path.getSep() === "\\" ? (p: string) => p.toLowerCase() : (p: string) => p;
  const rootKey = foldCase(toPosixPathKey(path.normalize(coreEnv.rootPath)));
  const resolvedKey = foldCase(toPosixPathKey(resolved));

  if (resolvedKey === rootKey || resolvedKey.startsWith(`${rootKey}/`)) {
    // Normalize only for the spawn/filter path (`packages/core//src` → `packages/core/src`).
    // Path.normalize preserves leading/trailing spaces in individual segments, and keeps
    // a trailing separator — which makes grep emit `dir//file` and defeats the result
    // filter; strip it except when the value is a filesystem root.
    const normalized = path.normalize(raw);
    if (/^[A-Za-z]:[\\/]$/.test(normalized)) return normalized;
    const trailing = path.getSep() === "\\" ? /\\+$/ : /\/+$/;
    const result = normalized.length > 1 ? normalized.replace(trailing, "") : normalized;

    // The lexical check above cannot see symlinks. Search binaries bypass CoreEnv.fs, so
    // resolve the real path here when the host exposes the capability and require it to
    // remain inside the real workspace root.
    if (coreEnv.fs.realpath) {
      const realPath = path.normalize(await coreEnv.fs.realpath(result));
      const realRoot = path.normalize(await coreEnv.fs.realpath(path.normalize(coreEnv.rootPath)));
      // A pre-capability remote server answers 404 with the lexical path, which may be
      // relative ("."). Only compare when both sides are real absolute paths; the client
      // itself already degrades a missing route to the lexical path.
      if (path.isAbsolute(realPath) && path.isAbsolute(realRoot)) {
        const realPathKey = foldCase(toPosixPathKey(realPath));
        const realRootKey = foldCase(toPosixPathKey(realRoot));
        const rootPrefix = realRootKey.endsWith("/") ? realRootKey : `${realRootKey}/`;
        if (realPathKey !== realRootKey && !realPathKey.startsWith(rootPrefix)) {
          throw new FileError(
            "permission_denied",
            `Path traversal blocked: "${raw}" resolves outside workspace root`,
            raw
          );
        }
      }
    }
    return result;
  }

  throw new FileError("permission_denied", `Path traversal blocked: "${raw}" resolves outside workspace root`, raw);
}

/**
 * Model-facing body for the filesystem search tools: cancel notice, pagination header, rows.
 *
 * `glob` / `grep` / `list_file` render the same envelope, and this text is what the model reads —
 * one definition keeps a cancelled-search notice (and the header wording) from drifting between
 * them. `body` overrides the rows for grep's match/files summary; the row array is still used for
 * the cancelled case.
 */
export function formatSearchModelOutput(input: {
  cancelled?: boolean;
  rows: readonly string[];
  offset: number;
  limit: number;
  body?: string;
}): string {
  if (input.cancelled) {
    return input.rows.length > 0
      ? `[Search cancelled by user — this result is incomplete.]\n${input.rows.join("\n")}`
      : "[Search cancelled by user.]";
  }
  return (
    `offset(current pagination): ${input.offset}; limit(Maximum number of items to return): ${input.limit}\n` +
    (input.body ?? input.rows.join("\n"))
  );
}
