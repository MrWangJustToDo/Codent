import { parseGitStatusRenamesZ, parseGitStatusZ } from "./workspace-git-paths.js";

import type { CoreEnv } from "@codent/core";

// ============================================================================
// Git Status
// ============================================================================

/**
 * Which bucket a `git status` code belongs to.
 *
 * The ONE definition of this precedence, because three surfaces read it: the file tree's badge,
 * the per-directory counts (both in `FileTree`), and anything else that needs to know a path's
 * kind. They had drifted — both in-tree copies tested `endsWith("M")` before `startsWith("R")`,
 * so a rename that was then edited (`RM`) was reported as a plain modification and the row's
 * entire point — that the file moved — was invisible in both places.
 *
 * `renamed` and `copied` are separate members rather than one `renamed` bucket with the code
 * recoverable from the raw string: the badge shows the letter, so a caller that had to re-read
 * the status to pick it would be re-deciding what this function already decided. They travel
 * together everywhere a count is needed (both mean "this path came from another one").
 *
 * R/C win over M because they are the *narrower* claim: `RM` is a rename whose diff happens to
 * show an edit, not a modification that happens to have moved. The modification is still visible
 * where it matters (the diff); the badge is what says the path changed identity.
 */
export type GitStatusKind = "renamed" | "copied" | "modified" | "added" | "deleted" | "untracked";

export function classifyGitStatus(status: string): GitStatusKind | null {
  const s = status.trim();
  if (s.startsWith("R")) return "renamed";
  if (s.startsWith("C")) return "copied";
  if (s === "??") return "untracked";
  if (s.startsWith("M") || s.endsWith("M")) return "modified";
  if (s.startsWith("A")) return "added";
  if (s.startsWith("D")) return "deleted";
  return null;
}

/** Whether a kind means "this path was produced from another one" (counts as a move). */
export function isMoveKind(kind: GitStatusKind | null): boolean {
  return kind === "renamed" || kind === "copied";
}

/** Both readings of one `git status` payload: the changed paths, and the moves among them. */
export interface GitStatusSnapshot {
  /** relative path → status code, one entry per changed file (renames under the destination) */
  status: Map<string, string>;
  /** rename/copy destination → source, for the entries that moved */
  renames: Map<string, string>;
}

let gitStatusCache: { rootPath: string; snapshot: GitStatusSnapshot } | null = null;

export function clearGitStatusCache(): void {
  gitStatusCache = null;
}

export async function fetchGitStatusSnapshot(env: CoreEnv, rootPath: string): Promise<GitStatusSnapshot> {
  if (gitStatusCache && gitStatusCache.rootPath === rootPath) {
    return gitStatusCache.snapshot;
  }
  try {
    // `-z` (NUL-delimited, never quoted) and `--untracked-files=all` (expand untracked
    // directories into their files). Without `-uall` git reports one record for a wholly
    // untracked directory, which has no file behind it and no name of its own — the
    // nameless row this parsing exists to avoid.
    const result = await env.runCommand("git status --porcelain -z --untracked-files=all", {
      cwd: rootPath,
    });
    const snapshot: GitStatusSnapshot = {
      status: parseGitStatusZ(result.stdout),
      renames: parseGitStatusRenamesZ(result.stdout),
    };
    gitStatusCache = { rootPath, snapshot };
    return snapshot;
  } catch {
    const empty: GitStatusSnapshot = { status: new Map(), renames: new Map() };
    return empty;
  }
}
