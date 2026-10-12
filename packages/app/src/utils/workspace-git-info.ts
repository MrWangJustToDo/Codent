import type { CoreEnv } from "@codent/core";

/**
 * Resolve lightweight git workspace metadata for header display.
 */

export type WorkspaceGitInfo = {
  /** Current branch, or a detached label */
  branch: string;
  /** Short HEAD sha when available */
  shortSha: string;
  /** Whether the worktree has uncommitted changes */
  dirty: boolean;
  /** Commits ahead of the upstream (0 when no upstream / not computable) */
  ahead: number;
  /** Commits behind the upstream (0 when no upstream / not computable) */
  behind: number;
};

/**
 * Return git branch/sha/dirty for `rootPath`, or null when not a git worktree.
 */
export async function fetchWorkspaceGitInfo(env: CoreEnv, rootPath: string): Promise<WorkspaceGitInfo | null> {
  if (!rootPath) return null;

  try {
    const inside = await env.runCommand("git rev-parse --is-inside-work-tree", { cwd: rootPath });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return null;
    }

    const [branchResult, shaResult, statusResult, aheadBehindResult] = await Promise.all([
      env.runCommand("git rev-parse --abbrev-ref HEAD", { cwd: rootPath }),
      env.runCommand("git rev-parse --short HEAD", { cwd: rootPath }),
      env.runCommand("git status --porcelain", { cwd: rootPath }),
      env.runCommand("git status -sb --porcelain", { cwd: rootPath }),
    ]);

    const shortSha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : "";
    let branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
    if (!branch || branch === "HEAD") {
      branch = shortSha ? `detached@${shortSha}` : "detached";
    }

    const dirty = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;
    const { ahead, behind } = parseAheadBehind(aheadBehindResult.exitCode === 0 ? aheadBehindResult.stdout : "");
    return { branch, shortSha, dirty, ahead, behind };
  } catch {
    return null;
  }
}

/**
 * Parse ahead/behind counts from `git status -sb` branch line.
 *
 * Examples of the first line:
 *   `## main`                       → 0/0 (no upstream)
 *   `## main...origin/main [ahead 2]`
 *   `## main...origin/main [behind 3]`
 *   `## main...origin/main [ahead 1, behind 2]`
 */
export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const result = { ahead: 0, behind: 0 };
  const branchLine = output.split(/\n/)[0] ?? "";
  const match = branchLine.match(/\[(ahead|behind)\s+(\d+)(?:,\s*(ahead|behind)\s+(\d+))?\]/);
  if (!match) return result;

  const firstKey = match[1];
  const firstVal = Number(match[2]);
  if (firstKey === "ahead") result.ahead = firstVal;
  else result.behind = firstVal;

  if (match[3] && match[4]) {
    const secondKey = match[3];
    const secondVal = Number(match[4]);
    if (secondKey === "ahead") result.ahead = secondVal;
    else result.behind = secondVal;
  }
  return result;
}

/** Compact single-line label, e.g. `main* abc1234`. */
export function formatWorkspaceGitInfo(info: WorkspaceGitInfo): string {
  const dirty = info.dirty ? "*" : "";
  const head = `${info.branch}${dirty}`;
  if (info.shortSha && !info.branch.includes(info.shortSha)) {
    return `${head} ${info.shortSha}`;
  }
  return head;
}
