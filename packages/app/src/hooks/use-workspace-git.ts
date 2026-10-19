import { useCallback, useEffect, useRef, useState } from "react";

import { useCoreEnv } from "../context/core-env-context.js";
import { clearWorkspaceDiffStatsCache, fetchWorkspaceDiffStats } from "../utils/workspace-diff-stats.js";
import { clearWorkspaceDiffCache } from "../utils/workspace-git-diff.js";
import { fetchWorkspaceGitInfo } from "../utils/workspace-git-info.js";
import { clearGitStatusCache, fetchGitStatusSnapshot } from "../utils/workspace-git-status.js";

import type { WorkspaceDiffStats } from "../utils/workspace-diff-stats.js";
import type { WorkspaceGitInfo } from "../utils/workspace-git-info.js";

const GIT_REFRESH_INTERVAL_MS = 10_000;

/**
 * The changed paths AND the moves among them, as ONE value.
 *
 * Deliberately not two `useState`s. `status` and `renames` come from a single `git status`
 * read, and a difference between them is not a rendering detail — it is a wrong answer. Two
 * independent states (each keeping its previous reference when unchanged) can settle on
 * `status` from one read and `renames` from another, and the visible symptom is a row that
 * was un-renamed still titled `old → new` and still diffed against a source path it no longer
 * has. One value cannot disagree with itself.
 */
interface GitStatusState {
  status: Map<string, string>;
  renames: Map<string, string>;
}

const EMPTY_GIT_STATUS: GitStatusState = { status: new Map(), renames: new Map() };

/** Two status maps describe the same worktree when their entries all agree. */
function sameStatus(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [path, status] of a) {
    if (b.get(path) !== status) return false;
  }
  return true;
}

/** Two rename maps describe the same moves when their pairs all agree. */
function sameRenames(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [destination, source] of a) {
    if (b.get(destination) !== source) return false;
  }
  return true;
}

/** One read has reproduced the previous one — both halves, not either. */
function sameGitStatus(a: GitStatusState, b: GitStatusState): boolean {
  return sameStatus(a.status, b.status) && sameRenames(a.renames, b.renames);
}

/**
 * Git status / branch info / diff stats for a workspace root.
 *
 * Loads once when the root resolves, then re-fetches on an interval so external
 * edits show up without a manual refresh. `refresh` clears the caches first, so
 * callers can also force a fresh read (the `r` key in the file browser).
 *
 * Refreshes are generation-guarded: only the **latest** call may write state.
 * Without the guard, a slow in-flight interval fetch that started before the
 * user's manual `r` would resolve *after* it and overwrite the fresh result —
 * the manual refresh visibly did nothing (and with a remote env, where each git
 * call is an HTTP round trip, the window is wide). A remount never loses this
 * race because the stale closure's setState lands on an unmounted component;
 * the generation guard gives the mounted hook the same property.
 *
 * A refresh that finds the worktree unchanged deliberately keeps the PREVIOUS
 * `gitStatus` reference instead of writing the freshly fetched one. The two maps
 * are equal, so nothing on screen should change — but a NEW map identity is not
 * nothing: the diff tree derives its rows from it, and every derived row list is
 * a new array that re-runs the consumers effectful on row identity (the reveal
 * effect snaps the tree cursor back to the selected file). A 10s tick was
 * therefore enough to yank the cursor out from under the user with no edit and
 * no key pressed. `statusVersion` separates the two questions the consumers
 * actually ask: "did the git state change" (the state) from "did we read it
 * again" (the version).
 */
export const useWorkspaceGit = (rootPath: string) => {
  const env = useCoreEnv();
  const [gitStatusState, setGitStatusState] = useState<GitStatusState>(EMPTY_GIT_STATUS);
  const [gitInfo, setGitInfo] = useState<WorkspaceGitInfo | null>(null);
  const [diffStats, setDiffStats] = useState<WorkspaceDiffStats | null>(null);
  /** Incremented on every completed refresh, even one that found nothing changed. */
  const [statusVersion, setStatusVersion] = useState(0);
  const generationRef = useRef(0);

  const refresh = useCallback(
    async (path: string) => {
      if (!path) return;
      const generation = ++generationRef.current;
      try {
        clearGitStatusCache();
        clearWorkspaceDiffStatsCache();
        // The per-file diff cache is a function of the file's content AND, for a rename, of the
        // source path it is compared against. A move that is staged, un-staged, or re-pointed
        // changes the answer for a path that did not change, so the entry cannot outlive a
        // status read the way it used to.
        clearWorkspaceDiffCache();
        const snapshot = await fetchGitStatusSnapshot(env, path);
        const status = snapshot.status;
        const untracked = [...status.entries()].filter(([, s]) => s.trim() === "??").map(([rel]) => rel);
        const [info, stats] = await Promise.all([
          fetchWorkspaceGitInfo(env, path),
          fetchWorkspaceDiffStats(env, path, untracked),
        ]);
        // A newer refresh was started while this one was in flight — its results
        // are the ones the user asked for. Discard ours entirely (state AND the
        // module cache the newer call already cleared and repopulated).
        if (generation !== generationRef.current) return;
        // Keep the previous reference when the worktree is unchanged — see the hook doc.
        setGitStatusState((prev) =>
          sameGitStatus(prev, snapshot) ? prev : { status: snapshot.status, renames: snapshot.renames }
        );
        setGitInfo(info);
        setDiffStats(stats);
        setStatusVersion((version) => version + 1);
      } catch {
        if (generation !== generationRef.current) return;
        setGitStatusState(EMPTY_GIT_STATUS);
        setGitInfo(null);
        setDiffStats(null);
        setStatusVersion((version) => version + 1);
      }
    },
    [env]
  );

  useEffect(() => {
    if (!rootPath) return;
    void refresh(rootPath);
  }, [rootPath, refresh]);

  useEffect(() => {
    if (!rootPath) return;
    const interval = setInterval(() => {
      void refresh(rootPath);
    }, GIT_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [rootPath, refresh]);

  return {
    gitStatus: gitStatusState.status,
    gitRenames: gitStatusState.renames,
    gitInfo,
    diffStats,
    statusVersion,
    refreshGit: refresh,
  };
};
