import { toPosixPath } from "@codent/core";

import { classifyGitStatus, isMoveKind } from "./workspace-git-status.js";
import { joinWorkspacePath } from "./workspace-path.js";

import type { CoreEnv } from "@codent/core";

/**
 * Per-directory tally of the changes beneath it, for the tree's directory rows.
 *
 * A rename is counted as ONE change even when it was also edited: the file moved, and the edit
 * is what its own row's diff shows. Counting it as a modification instead was the same
 * precedence bug as the row badge, and it produced a directory labelled `M` over a child row
 * labelled `R`.
 */
export interface DirStatusSummary {
  modified: number;
  added: number;
  deleted: number;
  untracked: number;
  renamed: number;
  total: number;
}

function emptySummary(): DirStatusSummary {
  return { modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0, total: 0 };
}

/**
 * Aggregate the change statuses into every ancestor directory.
 *
 * Lives here rather than beside the row renderer because it is a pure function of (env, map,
 * root) with no React in it, and the badge's classification rule is the behaviour worth
 * testing: a rule that only exists inside a component is a rule no test can reach.
 */
export function computeDirStatuses(
  env: CoreEnv,
  gitStatus: Map<string, string>,
  rootPath: string
): Map<string, DirStatusSummary> {
  const dirStatuses = new Map<string, DirStatusSummary>();

  const ensureDir = (dir: string): DirStatusSummary => {
    let summary = dirStatuses.get(dir);
    if (!summary) {
      summary = emptySummary();
      dirStatuses.set(dir, summary);
    }
    return summary;
  };

  for (const [filepath, status] of gitStatus) {
    const parts = toPosixPath(filepath).split("/");
    // Accumulate the status into every ancestor, keyed by its absolute path.
    for (let i = 1; i < parts.length; i++) {
      const relativeDir = parts.slice(0, i).join("/");
      const summary = ensureDir(joinWorkspacePath(env, rootPath, relativeDir));
      // One precedence rule for the whole view — `classifyGitStatus` is the definition.
      const kind = classifyGitStatus(status);
      if (isMoveKind(kind)) summary.renamed++;
      else if (kind === "modified") summary.modified++;
      else if (kind === "added") summary.added++;
      else if (kind === "deleted") summary.deleted++;
      else if (kind === "untracked") summary.untracked++;
      summary.total++;
    }
  }

  return dirStatuses;
}
