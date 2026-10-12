import { namesAFile } from "./workspace-git-paths.js";
import { workspaceRelativePath } from "./workspace-path.js";

import type { CoreEnv } from "@codent/core";

export type WorkspaceFileDiff = {
  relativePath: string;
  fileName: string;
  oldContent: string;
  newContent: string;
  hasChanges: boolean;
};

const diffCache = new Map<string, Promise<WorkspaceFileDiff>>();

/** Shell-safe single-quoted argument for git commands. */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function clearWorkspaceDiffCache(): void {
  diffCache.clear();
}

export function fetchWorkspaceFileDiff(env: CoreEnv, rootPath: string, filePath: string): Promise<WorkspaceFileDiff> {
  const key = `${rootPath}\0${filePath}`;
  const cached = diffCache.get(key);
  if (cached) return cached;

  const promise = loadWorkspaceFileDiff(env, rootPath, filePath).catch((error: unknown) => {
    diffCache.delete(key);
    throw error;
  });
  diffCache.set(key, promise);
  return promise;
}

async function loadWorkspaceFileDiff(env: CoreEnv, rootPath: string, filePath: string): Promise<WorkspaceFileDiff> {
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
    };
  }
  const fileName = filePath.split("/").pop() || filePath;

  let oldContent = "";
  const quoted = quoteShellArg(relativePath);
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
  try {
    const diff = await env.runCommand(`git diff HEAD -- ${quoted}`, { cwd: rootPath });
    if (diff.exitCode === 0 && diff.stdout.trim().length > 0) {
      hasChanges = true;
    }
  } catch {
    // Fall back to content comparison above.
  }

  return {
    relativePath,
    fileName,
    oldContent,
    newContent,
    hasChanges,
  };
}
