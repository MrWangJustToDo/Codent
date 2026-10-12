import { toPosixPath } from "@codent/core";

import { namesAFile, parseGitNumstatZ } from "./workspace-git-paths.js";
import { joinWorkspacePath } from "./workspace-path.js";

import type { CoreEnv } from "@codent/core";

// ============================================================================
// Diff stats (per-file +/− line counts vs HEAD, plus untracked file lines)
//
// Powers the GitHub-PR-style "+N −M" labels in the file tree and the
// "N files · +X −Y" header summary. Tracked changes come from
// `git diff HEAD --numstat`; untracked (`??`) files are not part of any git
// diff, so their line count is measured directly from the working tree file.
// ============================================================================

export interface WorkspaceFileDiffStat {
  added: number;
  deleted: number;
}

export interface WorkspaceDiffStats {
  /** relative path → line counts */
  files: Map<string, WorkspaceFileDiffStat>;
  totalAdded: number;
  totalDeleted: number;
}

const MAX_UNTRACKED_STAT_CHARS = 200_000;

/**
 * Parse `git diff --numstat -z` output into a path → line-counts map.
 *
 * Shared path extraction lives in `workspace-git-paths`: this parse previously took git's
 * quoted output literally, so for a path containing a quote or a non-ASCII byte the map key
 * was not the real path and did not match the diff view's row — the row silently lost its
 * counts. Binary files report `-\t-` and are treated as 0/0.
 */
export function parseDiffNumstat(raw: string): Map<string, WorkspaceFileDiffStat> {
  return parseGitNumstatZ(raw);
}

const statsCache = new Map<string, Promise<WorkspaceDiffStats>>();

export function clearWorkspaceDiffStatsCache(): void {
  statsCache.clear();
}

export function fetchWorkspaceDiffStats(
  env: CoreEnv,
  rootPath: string,
  untracked: string[]
): Promise<WorkspaceDiffStats> {
  const key = `${rootPath}\0${untracked.join("\n")}`;
  const cached = statsCache.get(key);
  if (cached) return cached;

  const promise = loadWorkspaceDiffStats(env, rootPath, untracked).catch((error: unknown) => {
    statsCache.delete(key);
    throw error;
  });
  statsCache.set(key, promise);
  return promise;
}

async function loadWorkspaceDiffStats(
  env: CoreEnv,
  rootPath: string,
  untracked: string[]
): Promise<WorkspaceDiffStats> {
  const files = new Map<string, WorkspaceFileDiffStat>();
  let totalAdded = 0;
  let totalDeleted = 0;

  try {
    const result = await env.runCommand("git diff HEAD --numstat -z", { cwd: rootPath });
    if (result.exitCode === 0) {
      for (const [path, stat] of parseDiffNumstat(result.stdout)) {
        files.set(path, stat);
        totalAdded += stat.added;
        totalDeleted += stat.deleted;
      }
    }
  } catch {
    // Not a git worktree / unborn HEAD — untracked-only stats below.
  }

  for (const rel of untracked) {
    const stat = await countUntrackedLines(env, rootPath, rel);
    if (!stat) continue;
    const key = toPosixPath(rel);
    files.set(key, stat);
    totalAdded += stat.added;
    totalDeleted += stat.deleted;
  }

  return { files, totalAdded, totalDeleted };
}

async function countUntrackedLines(env: CoreEnv, rootPath: string, rel: string): Promise<WorkspaceFileDiffStat | null> {
  // The caller derives `rel` from the status parse, which already rejects directories. The
  // guard stays because this is the one place that *reads* the path: handed a directory it
  // would attempt a read that cannot succeed, and report no stat instead of a wrong one.
  if (!namesAFile(rel)) return null;
  try {
    const content = await env.fs.readFile(joinWorkspacePath(env, rootPath, rel));
    const capped = content.slice(0, MAX_UNTRACKED_STAT_CHARS);
    const added = capped.split("\n").length;
    return { added, deleted: 0 };
  } catch {
    return null;
  }
}
