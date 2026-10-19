## 1. Parse: one row per change, pairing separately

- [x] 1.1 `parseGitStatusZ` consumes the source record of an `R`/`C` entry instead of indexing it, so a
      rename contributes exactly one row (the destination).
- [x] 1.2 Add `parseGitStatusRenamesZ` returning `destination → source`, parsing the same payload. Document
      that `status -z` orders destination-then-source while `diff --numstat -z` orders source-then-destination,
      so the two rename parsers must not be shared.
- [x] 1.3 `fetchGitStatus` → `fetchGitStatusSnapshot`, returning `{ status, renames }`; the cache holds the
      whole snapshot.

## 2. Hook: carry the pairing

- [x] 2.1 `useWorkspaceGit` exposes `gitRenames` next to `gitStatus`, refreshed from the same snapshot and
      cleared with it.
- [x] 2.2 Compare renames structurally (`sameRenames`) so an unchanged worktree keeps the previous reference,
      matching how `gitStatus` avoids needless re-renders.

## 3. Diff content: read the old side from the source

- [x] 3.1 `WorkspaceFileDiff.renamedFrom` carries the source path through to the renderer.
- [x] 3.2 `fetchWorkspaceFileDiff(env, rootPath, filePath, renamedFrom?)` reads `git show HEAD:<source>` for
      the old side and the worktree destination for the new side; the cache key includes `renamedFrom`.
- [x] 3.3 `hasChanges` for a rename is decided by content comparison only — a pathspec-limited `git diff`
      reports a whole-file delete or add on either side of a rename and cannot distinguish a pure move.

## 4. Presentation: one row, both names

- [x] 4.1 `WorkspaceFileMode` looks the selected row's source up in `gitRenames` (relative-path key) and
      passes it to the preview.
- [x] 4.2 `WorkspacePreviewPane` forwards `renamedFrom`; its `key` includes it so a rename-to-rename
      selection refreshes the diff.
- [x] 4.3 `FileDiffContent` titles a rename `old → new` from two workspace-relative paths (both sides in
      one frame, not a relative path against a basename) and truncates the long ones; a pure move is
      described as a rename with identical contents rather than "no changes vs HEAD".
- [x] 4.4 Extract the status-code precedence to one definition, `classifyGitStatus`, and read it from both
      the tree badge and `computeDirStatuses` — `RM` is a rename, not a modification. Give `R` and `C`
      separate kinds so the badge reads its letter from the classification instead of re-deciding it.
- [x] 4.5 Move `computeDirStatuses` (a pure function with no React in it) to `utils/workspace-dir-status`,
      so the rule it shares with the badge is reachable from a test; register it as an app build entry.
- [x] 4.6 Carry `status` and `renames` as ONE hook value: two independent states could settle on a status
      from one read and renames from another, leaving an un-renamed row titled `old → new`.
- [x] 4.7 Invalidate the per-file diff cache on every status refresh — it is now a function of the path AND
      its rename source, a dimension a staged/un-staged re-point can change under an unchanged path.

## 5. Tests

- [x] 5.1 `test/workspace-git-paths.test.mjs`: rename assertions move to the one-row rule; add the pairing
      assertions, `RM`, `C`, "rename followed by another record", and the truncated-rename case.
- [x] 5.2 `test/workspace-git-rename.test.mjs` (new): against a real scratch repository driven through
      `createNodeEnv` — one row per rename, the pairing, a pure move reporting no content change, a
      move-and-edit showing the edit, a mode-only move staying "contents identical", stats agreeing with
      the single row, and an undetected move not being paired.
- [x] 5.3 `test/workspace-git-status-kind.test.mjs` (new): the `RM` precedence, the `copied` kind, both
      consumers (badge kind and `computeDirStatuses` bucket), plus the classifications the fix must not
      disturb.
- [x] 5.5 `test/workspace-diff-tree.test.mjs`: the old "both sides are rows" assertion moves to the one-row
      rule, so the tree test stops describing an input the parse no longer produces.
- [x] 5.4 Mutation-check each new assertion: reverting the source-path read, re-indexing the source record,
      and restoring the old precedence must each fail a test.

## 6. Verification

- [x] 6.1 `pnpm build`, `pnpm typecheck`, app test suite (126 passing), `validate:render-smoke`, `pnpm lint`.
- [x] 6.2 `pnpm exec openspec validate workspace-diff-rename --strict`.
- [x] 6.3 `pnpm run validate:all` (256 passed / 0 failed).
