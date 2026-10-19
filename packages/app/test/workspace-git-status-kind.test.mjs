/**
 * Pins the status-code classification behind the diff-view badges and directory counts.
 *
 * A rename that was then edited reads `RM` from `git status`. The classification is what tells
 * the user the row moved — the diff only shows the edit — so the rename has to win. It did not:
 * both the badge and the per-directory counts tested `endsWith("M")` first, so `RM` reported a
 * plain modification and the row's whole point was invisible. Because the two surfaces each
 * carried their own copy of the order, fixing one would have left the other wrong; they now read
 * this single function.
 *
 * Run: node packages/app/test/workspace-git-status-kind.test.mjs
 */
import assert from "node:assert/strict";

const { classifyGitStatus, isMoveKind } = await import("../dist/utils/workspace-git-status.mjs");
const { computeDirStatuses } = await import("../dist/utils/workspace-dir-status.mjs");

// The case the old ordering got wrong: renamed AND modified.
assert.equal(classifyGitStatus("RM"), "renamed", "a rename that was also edited is still a rename");
assert.equal(classifyGitStatus("R"), "renamed", "a pure move");
assert.equal(classifyGitStatus("C"), "copied", "a copy is its own kind, so the badge can show C");
assert.equal(isMoveKind("copied"), true, "but for counting it is still a move");
assert.equal(isMoveKind("renamed"), true);
assert.equal(isMoveKind("modified"), false);

// The precedence must not swallow the cases it was moved ahead of.
assert.equal(classifyGitStatus("M"), "modified");
assert.equal(classifyGitStatus("MM"), "modified", "staged + unstaged edits, no rename involved");
assert.equal(classifyGitStatus(" M"), "modified", "worktree-only modification is trimmed before matching");
assert.equal(classifyGitStatus("A"), "added");
// `AM` reads as a modification both before and after this change (`endsWith("M")` claimed it) —
// deliberately unchanged: the fix is scoped to renames, and rewriting an unrelated badge would be
// a behaviour change nobody asked for. Recorded so it is a decision, not an oversight.
assert.equal(classifyGitStatus("AM"), "modified");
assert.equal(classifyGitStatus("D"), "deleted");
assert.equal(classifyGitStatus("??"), "untracked", "checked before the M rule, which cannot match it anyway");

// Anything else is not a status this view paints.
assert.equal(classifyGitStatus(""), null);
assert.equal(classifyGitStatus("U"), null);

// The two surfaces that read the classifier are the row badge and the directory counts. The
// badge is switched on the kind directly (so R and C cannot drift), and the counts go through
// `computeDirStatuses` — which is why these assertions live here: the ordering bug was in BOTH,
// each with its own copy of the rule.
{
  const env = { rootPath: "/repo" };

  const moved = computeDirStatuses(env, new Map([["src/moved.ts", "RM"]]), "/repo").get("/repo/src");
  assert.ok(moved, "the ancestor directory is summarised");
  assert.equal(moved.renamed, 1, "a rename that was also edited is counted as a rename");
  assert.equal(moved.modified, 0, "and must not be double-counted as a modification");
  assert.equal(moved.total, 1);

  const copied = computeDirStatuses(env, new Map([["src/copied.ts", "C"]]), "/repo").get("/repo/src");
  assert.equal(copied.renamed, 1, "a copy is counted as a move");
  assert.equal(copied.total, 1, "and is counted at all — it used to fall through every bucket");

  const edited = computeDirStatuses(env, new Map([["src/edited.ts", "M"]]), "/repo").get("/repo/src");
  assert.equal(edited.modified, 1, "the precedence must not swallow the plain modification");
  assert.equal(edited.renamed, 0);
}

console.log("workspace-git-status-kind validation passed");
