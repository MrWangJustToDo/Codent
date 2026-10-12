import { toPosixPathKey } from "@codent/core";

import type { CoreEnv } from "@codent/core";

/** Join paths using the active session's CoreEnv path utilities (POSIX-safe). */
export function joinWorkspacePath(env: CoreEnv, ...parts: string[]): string {
  return env.path?.join(...parts) ?? parts.join("/");
}

/** Convert an absolute workspace path to a root-relative path for git status lookup. */
export function workspaceRelativePath(rootPath: string, fullPath: string): string {
  // Normalize separators and strip a trailing one, so a Windows root (`C:\repo`) matches a
  // forward-slash path and a root given as `/repo/` still works. The previous version only
  // handled the trailing-slash case and compared raw strings, so a Windows root never matched
  // and the function silently returned the absolute path — which the git-status lookup then
  // could not resolve to an entry.
  //
  // The result is deliberately forward-slashed rather than echoing the input's separator.
  // Every consumer keys on `/` (the shared path rule in core), and `FileTree` looks `diffStats`
  // up with no fallback, so returning a `\`-separated relative path on Windows would miss
  // every entry. The one consumer that needs the other flavour already tries both (`FileTree`'s
  // git-status lookup falls back to the normalized form), which is the direction that tolerates
  // either.
  const root = toPosixPathKey(rootPath);
  const full = toPosixPathKey(fullPath);
  if (full === root) return ".";
  const prefix = `${root}/`;
  if (full.startsWith(prefix)) return full.slice(prefix.length);
  return fullPath;
}
