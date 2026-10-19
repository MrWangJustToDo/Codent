## Why

The diff view lists git's changes as rows, and a rename is the one change that straddles two paths. It
was read as two changes: `git status --porcelain -z` emits `R  new\0old` and the parse indexed **both**
records, so the source and the destination each became a row. Neither row could show anything useful —
the source is gone from the worktree (its row rendered a whole-file deletion) and `HEAD:<destination>`
does not exist (its row rendered a whole-file addition). A rename that was also edited therefore showed
the edit **nowhere**: it was buried between a fabricated delete and a fabricated add. Reported as "after
renaming, an edit can't be viewed at all".

Three further consequences of the same split:

- `git diff HEAD --numstat -z` already keys a rename by its destination, so the stats row lined up with
  the *addition* half only, and the pair claimed `+N` on one row while `−N` appeared on another.
- The file tree's badge tested `endsWith("M")` before `startsWith("R")`, so a rename-then-edit (`RM`)
  rendered as a plain modification — the row's entire point (the path moved) was invisible. The
  per-directory counts carried a hand-copied version of the same order, so fixing one would have left
  the other wrong.
- Nothing in the UI said where a moved file came from.

## What Changes

- **A rename is one row, keyed by its destination.** `parseGitStatusZ` stops indexing the source record
  and consumes it instead (a copy record is handled the same way). The destination is the path that
  exists, so it is the only one the view can read.
- **The pairing is carried separately.** New `parseGitStatusRenamesZ` returns
  `destination → source`. `fetchGitStatus` becomes `fetchGitStatusSnapshot`, returning
  `{ status, renames }`, and `useWorkspaceGit` exposes `gitRenames` alongside `gitStatus`.
- **The old side is read from the source path.** `fetchWorkspaceFileDiff` takes the rename source and
  reads `git show HEAD:<source>` against the worktree's `<destination>`, so an edit inside a move is
  visible. A pure move (no edit) legitimately reports no content change — only the label differs. The
  rename's `hasChanges` is decided by content comparison alone, because a pathspec limited to either
  side of a rename always shows a whole-file delete or add.
- **The preview title names both sides** (`old → new`, both workspace-relative so the two halves read
  in one frame), and the tree shows the destination name. A pure move says "renamed, contents
  identical" rather than "no changes vs HEAD", which contradicted its own `R` badge.
- **One status-code precedence rule** (`classifyGitStatus`), read by both the tree badge and the
  per-directory counts: R/C outrank M, because `RM` is a rename whose diff happens to show an edit, not
  a modification that happens to have moved. `R` and `C` stay separate kinds so the badge's letter comes
  from the classification rather than a second read of the raw status.

Out of scope, stated because the fix deliberately stops here: a plain filesystem move that git has not
been asked to stage is reported as a real deletion plus a real untracked file (` D old` / `?? new`).
That is not a rename in git's own view — there is no source blob to compare against — so the view
renders those two real states rather than guessing a pairing.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `workspace-diff-view`: the rename rule changes from "both sides are indexed" to one row per rename,
  with the pairing carried separately for the diff and its label; the "every registered path is one the
  view can read" invariant now explicitly applies to the source side of a rename (it is read from
  `HEAD`, not from the worktree); the badge precedence is pinned.

## Impact

- `packages/app/src/utils/workspace-git-paths.ts` (`parseGitStatusZ` skips the source;
  `parseGitStatusRenamesZ` added).
- `packages/app/src/utils/workspace-git-status.ts` (`GitStatusSnapshot`, `fetchGitStatusSnapshot`,
  `classifyGitStatus`).
- `packages/app/src/utils/workspace-git-diff.ts` (`WorkspaceFileDiff.renamedFrom`; old side read from the
  source path).
- `packages/app/src/hooks/use-workspace-git.ts` (`status` + `renames` as one value; the diff cache is
  invalidated with the status caches).
- `packages/app/src/utils/workspace-dir-status.ts` (new): `computeDirStatuses`, moved out of the
  component so the rule it shares with the badge is testable.
- `packages/app/tsdown.shared.ts` (register the new util as a build entry).
- `packages/app/src/components/{FileTree,WorkspaceFileMode,WorkspacePreviewPane,FileDiffContent}.tsx`
  (badge precedence, rename lookup, `old → new` title).
- `packages/app/scripts/workspace-refresh-check/run.mjs` (reads `parseGitStatusZ` directly; the
  `parseGitStatus` wrapper is gone).
- `packages/app/src/utils/workspace-diff-stats.ts`: unchanged — `--numstat -z` already keys a rename by
  its destination, which is what the one-row rule needs.
- Tests: `test/workspace-git-paths.test.mjs` (rename assertions move to the one-row rule),
  `test/workspace-git-rename.test.mjs` (new, against a real repository through `createNodeEnv`: a pure
  move, a move-and-edit, and a mode-only move), `test/workspace-git-status-kind.test.mjs` (new, the `RM`
  precedence across both consumers), `test/workspace-diff-tree.test.mjs` (the one-row rule).
- Spec: `openspec/specs/workspace-diff-view/spec.md`.
