/**
 * The ONE resolution of a path for the ACP wire.
 *
 * ACP requires absolute paths on every path-bearing method we call — `fs/read_text_file` and
 * `fs/write_text_file` take an "Absolute path to the file", `terminal/create.cwd` "Must be an
 * absolute path", and a `tool_call.location` is a path the client follows — while every producer in
 * this package is handed whatever the caller had, which for the tools is a workspace-RELATIVE path.
 *
 * There used to be two implementations of this (`toAbsolute` in `tools.ts` for `locations` /
 * `diff.path`, and a newer local helper in `client-env.ts` for the `fs/*` bodies), and they answered
 * the same question differently: the first did string concatenation, so the same file could reach a
 * client as two different path strings — `/ws/packages/core/../acp/README.md` from a location and
 * `/ws/packages/acp/README.md` from the read that followed it. The client cannot tell those are one
 * file. They are one contract, so they are one function.
 *
 * Two things this must NOT do:
 *
 * - **Fall back to `process.cwd()`.** `pathe.resolve("", target)` silently resolves against the
 *   process's own cwd, which is a different workspace the moment a host is handed one. An empty root
 *   means "no base to resolve against", and the honest answer is the path unchanged.
 * - **Decide absoluteness with `startsWith("/")`.** That is POSIX-only: a Windows path (`C:\dev\x.ts`)
 *   or a UNC path (`\\srv\share\x`) does not start with `/`, so it would be resolved as though it were
 *   relative and become `<root>/C:/dev/x.ts` — a path pointing at a file that does not exist.
 *   `defaultPath.isAbsolute` is the platform-aware predicate, and it treats both shapes as absolute.
 *
 * Normalization comes for free with `resolve` (it collapses `..` and `//`), which is the other half
 * of "one file, one string".
 */

import { defaultPath } from "@codent/core";

/**
 * Resolve `target` against `rootPath` for the wire: absolute, normalized, idempotent.
 *
 * Already-absolute paths (POSIX, Windows drive-letter, or UNC) are normalized but never re-based, so
 * a caller that passed a correct absolute path gets that same path back.
 *
 * An empty `rootPath` returns `target` unchanged rather than resolving against `process.cwd()`: there
 * is no workspace to resolve against, and inventing one is exactly the bug this guards.
 *
 * **Precondition: `rootPath` is absolute.** This guards the *empty* root, not a *relative* one —
 * `resolve("rel/ws", t)` is still a path that depends on `process.cwd()`. {@link resolveRoot} is that
 * precondition made executable, and every entry point that accepts a root goes through it, so the
 * precondition holds for every caller in this package.
 */
export function toWirePath(target: string, rootPath: string | undefined): string {
  if (!rootPath) return target;
  if (defaultPath.isAbsolute(target)) return defaultPath.normalize(target);
  return defaultPath.resolve(rootPath, target);
}

/**
 * The workspace root, normalized to absolute — the entry-side half of {@link toWirePath}.
 *
 * A caller-supplied root may be relative (`bootstrapLocalAcp({ cwd })`, `createAcpAgent({ rootPath })`
 * are both public), and a relative root does not fail loudly: `toWirePath` would resolve *through* it
 * with `process.cwd()` underneath, silently anchoring a session's paths to whichever directory this
 * process happens to sit in. Resolving at the boundary is what makes "MUST NOT use `process.cwd()`"
 * true rather than aspirational — and `process.cwd()` is the right base for a *relative* caller root,
 * which is exactly why it is allowed here and nowhere downstream.
 *
 * Every entry that takes a root calls this. It lives next to `toWirePath` so the precondition and its
 * enforcement cannot drift apart.
 */
export function resolveRoot(cwd: string | undefined): string {
  return defaultPath.resolve(cwd ?? process.cwd());
}
