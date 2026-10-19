import { namesAFile } from "./workspace-git-paths.js";
import { workspaceRelativePath } from "./workspace-path.js";

import type { CoreEnv } from "@codent/core";

export type WorkspaceFileDiff = {
  relativePath: string;
  fileName: string;
  oldContent: string;
  newContent: string;
  hasChanges: boolean;
  /**
   * For a rename: the path the file came from. `undefined` for every other row.
   *
   * Present because a rename is ONE change whose old and new sides live at different paths, so
   * nothing else in this payload can describe it: `relativePath` is the destination (the file
   * that exists), and the old content has to be read from the source path. Without this the two
   * sides were read from the SAME path — `HEAD:<new>` does not exist and `<old>` is gone from the
   * worktree — so a rename rendered as a whole-file deletion plus a whole-file addition, and any
   * real edit inside the moved file was invisible among them.
   */
  renamedFrom?: string;
};

const diffCache = new Map<string, Promise<WorkspaceFileDiff>>();

/** Shell-safe single-quoted argument for git commands. */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function clearWorkspaceDiffCache(): void {
  diffCache.clear();
}

export function fetchWorkspaceFileDiff(
  env: CoreEnv,
  rootPath: string,
  filePath: string,
  renamedFrom?: string
): Promise<WorkspaceFileDiff> {
  const key = `${rootPath}\0${filePath}\0${renamedFrom ?? ""}`;
  const cached = diffCache.get(key);
  if (cached) return cached;

  const promise = loadWorkspaceFileDiff(env, rootPath, filePath, renamedFrom).catch((error: unknown) => {
    diffCache.delete(key);
    throw error;
  });
  diffCache.set(key, promise);
  return promise;
}

async function loadWorkspaceFileDiff(
  env: CoreEnv,
  rootPath: string,
  filePath: string,
  renamedFrom?: string
): Promise<WorkspaceFileDiff> {
  // The caller passes an absolute path taken from a diff-tree row, and the tree excludes
  // directory-shaped paths (`workspace-git-paths`), so this is unreachable with a directory
  // today. Guarded anyway: it is the third consumer of git output in this view, and it is the
  // one that *reads* the path, so a directory here would silently produce an empty diff rather
  // than an error. Recorded so the next reader does not have to re-derive reachability.
  const relativePath = workspaceRelativePath(rootPath, filePath);
  if (!namesAFile(relativePath)) {
    // No throw: this module reports "no changes" for anything it cannot read, and the caller
    // renders an empty diff. A directory is not an error to surface — it should simply never
    // have been asked about.
    return {
      relativePath,
      fileName: filePath.split("/").pop() || filePath,
      oldContent: "",
      newContent: "",
      hasChanges: false,
      // Kept even on this early exit: the label describes the row, not the payload, and a
      // rename heading that vanished because the content could not be read would be a second
      // defect on top of the first.
      ...(renamedFrom !== undefined ? { renamedFrom } : {}),
    };
  }
  const fileName = filePath.split("/").pop() || filePath;

  // The old side is read from the source path on a rename, and from this path otherwise. Reading
  // `HEAD:<new>` on a rename always fails (the file is not in HEAD under that name), which is what
  // reduced every rename to "added".
  const oldPath = renamedFrom ?? relativePath;
  let oldContent = "";
  const quoted = quoteShellArg(oldPath);
  try {
    const head = await env.runCommand(`git show HEAD:${quoted}`, { cwd: rootPath });
    if (head.exitCode === 0) oldContent = head.stdout;
  } catch {
    oldContent = "";
  }

  let newContent = "";
  try {
    newContent = await env.fs.readFile(filePath);
  } catch {
    newContent = "";
  }

  let hasChanges = oldContent !== newContent;
  // A rename is decided by the content comparison alone. Its per-path diff is not evidence: the
  // pair straddles two paths, so a pathspec limited to either side shows a whole-file delete or
  // add, which would report "changes" even for a pure move (where there is nothing to show).
  if (renamedFrom === undefined) {
    try {
      // `--` keeps a path that names a revision out of the revisions argument.
      const diff = await env.runCommand(`git diff HEAD -- ${quoted}`, { cwd: rootPath });
      if (diff.exitCode === 0 && diff.stdout.trim().length > 0) {
        hasChanges = true;
      }
    } catch {
      // Fall back to content comparison above.
    }
  }

  return {
    relativePath,
    fileName,
    oldContent,
    newContent,
    hasChanges,
    ...(renamedFrom !== undefined ? { renamedFrom } : {}),
  };
}
