/**
 * Pins how the diff view reads a git RENAME, against a real repository.
 *
 * The defect this exists for is not a parsing detail: a rename is one change, but every layer
 * read it as two. `git status --porcelain -z` reports `R  new\0old`, so indexing both records
 * produced a row per side; the old path is gone from the worktree, so its row rendered a
 * whole-file deletion, and `HEAD:<new>` does not exist, so the new row rendered a whole-file
 * addition. An edit made *inside* the move was then unreachable — the user's report was
 * literally "after renaming, an edit can't be viewed at all".
 *
 * A hand-written NUL payload cannot catch that, because the case is about what git prints and
 * what a reader can then open. So these cases build a scratch repository and run the real
 * commands through a CoreEnv backed by node's fs + git, exactly as the diff view does.
 *
 * Run: node packages/app/test/workspace-git-rename.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real CoreEnv, not a hand-rolled shell shim: the runner must be one that really executes
// git, and `createNodeEnv` is what the app itself runs commands through. A `bash -c` stub would
// prove the parser against a command surface the product never uses (and would not run on
// Windows, where the validators job does execute this suite's siblings).
const { createNodeEnv } = await import("../../node/dist/index.mjs");
const { clearGitStatusCache, fetchGitStatusSnapshot } = await import("../dist/utils/workspace-git-status.mjs");
const { clearWorkspaceDiffCache, fetchWorkspaceFileDiff } = await import("../dist/utils/workspace-git-diff.mjs");
const { clearWorkspaceDiffStatsCache, fetchWorkspaceDiffStats } =
  await import("../dist/utils/workspace-diff-stats.mjs");

const repo = mkdtempSync(join(tmpdir(), "codent-rename-"));
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
const write = (rel, content) => writeFileSync(join(repo, rel), content);
const env = createNodeEnv({ rootPath: repo });

try {
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  // Pin the two settings a developer's global gitconfig could otherwise contribute: signed
  // commits (which fail here with no key configured) and line-ending conversion (which would
  // make `oldContent === newContent` false for a pure move on a Windows checkout).
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");

  write("plain.md", "alpha\nbeta\ngamma\ndelta\nepsilon\n");
  write("edited.md", "one\ntwo\nthree\nfour\nfive\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");

  // Pure move: same bytes, new name. Git detects this on its own (100% similarity).
  renameSync(join(repo, "plain.md"), join(repo, "plain-renamed.md"));
  // Move + edit: one line changed. Git still detects the rename and reports 1/1.
  renameSync(join(repo, "edited.md"), join(repo, "edited-renamed.md"));
  write("edited-renamed.md", "one\ntwo\nCHANGED\nfour\nfive\n");

  git("add", "-A");
  clearGitStatusCache();
  clearWorkspaceDiffStatsCache();
  clearWorkspaceDiffCache();

  // ==========================================================================
  // One row per rename
  // ==========================================================================

  const snapshot = await fetchGitStatusSnapshot(env, repo);
  const rows = [...snapshot.status.keys()].sort();
  assert.deepEqual(
    rows,
    ["edited-renamed.md", "plain-renamed.md"],
    "a rename is ONE changed path — the source is gone from the worktree, so it is not a row"
  );
  assert.equal(snapshot.status.get("plain-renamed.md"), "R", "a pure move keeps the R status");
  assert.equal(snapshot.status.get("edited-renamed.md"), "R", "so does a move that was also edited");

  // ==========================================================================
  // The pairing survives, keyed by destination
  // ==========================================================================

  assert.deepEqual(
    [...snapshot.renames].sort(),
    [
      ["edited-renamed.md", "edited.md"],
      ["plain-renamed.md", "plain.md"],
    ],
    "destination → source, so the diff can read the old side and the label can say `old → new`"
  );

  // ==========================================================================
  // The old side comes from HEAD:<source> — without it every rename reads as "added"
  // ==========================================================================

  const pureMove = await fetchWorkspaceFileDiff(env, repo, join(repo, "plain-renamed.md"), "plain.md");
  assert.equal(pureMove.renamedFrom, "plain.md");
  assert.equal(
    pureMove.oldContent,
    "alpha\nbeta\ngamma\ndelta\nepsilon\n",
    "the old side is the SOURCE path in HEAD; `HEAD:<destination>` does not exist"
  );
  assert.equal(
    pureMove.hasChanges,
    false,
    "a pure move changed no content, so there is no diff to show — only the label differs"
  );

  const moveAndEdit = await fetchWorkspaceFileDiff(env, repo, join(repo, "edited-renamed.md"), "edited.md");
  assert.equal(moveAndEdit.renamedFrom, "edited.md");
  assert.equal(moveAndEdit.oldContent, "one\ntwo\nthree\nfour\nfive\n", "the pre-move content, not an empty string");
  assert.equal(
    moveAndEdit.newContent,
    "one\ntwo\nCHANGED\nfour\nfive\n",
    "the post-move content, read from the new path"
  );
  assert.equal(moveAndEdit.hasChanges, true, "the edit inside the move is visible — this is the reported bug");

  // ==========================================================================
  // A mode change on a move is still "contents identical" — and that is what the label says
  // ==========================================================================

  // `git status` reports this as `R` because the path moved, but no line changed. The row
  // therefore has to describe itself as a move with identical contents; calling it "no changes"
  // next to an `R` badge (and a non-zero mode change in `git diff`) reads as a bug.
  chmodSync(join(repo, "plain-renamed.md"), 0o755);
  clearWorkspaceDiffCache();
  const modeOnly = await fetchWorkspaceFileDiff(env, repo, join(repo, "plain-renamed.md"), "plain.md");
  assert.equal(modeOnly.hasChanges, false, "no line differs, so there is no content diff to draw");
  assert.equal(
    modeOnly.oldContent,
    modeOnly.newContent,
    "and the two sides really are byte-identical — the label's claim has to be true"
  );

  // ==========================================================================
  // The stats row agrees with the single row
  // ==========================================================================

  const stats = await fetchWorkspaceDiffStats(env, repo, []);
  assert.deepEqual(
    [...stats.files.keys()].sort(),
    ["edited-renamed.md", "plain-renamed.md"],
    "numstat is keyed by the destination too, so it lines up with the one row instead of adding a second"
  );
  assert.deepEqual(
    stats.files.get("edited-renamed.md"),
    { added: 1, deleted: 1 },
    "the move-and-edit reports its real line counts (git pairs them under the destination)"
  );
  assert.deepEqual(
    stats.files.get("plain-renamed.md"),
    { added: 0, deleted: 0 },
    "a pure move changes no lines, so the row must not claim additions"
  );

  // ==========================================================================
  // A move git cannot see is NOT a rename — the view must not invent a pairing
  // ==========================================================================

  git("commit", "-q", "-m", "renamed");
  // A plain `mv` with no staging is reported by git as a deletion plus an untracked file:
  // untracked paths are not part of HEAD, so there is nothing to pair and nothing to diff.
  // The view must render those two real states rather than guess a rename — this is the
  // boundary of the fix, recorded so a future "why doesn't my mv show as a rename" is answered
  // by the test instead of by the code.
  renameSync(join(repo, "plain-renamed.md"), join(repo, "plain-moved.md"));
  clearGitStatusCache();
  const unstaged = await fetchGitStatusSnapshot(env, repo);
  assert.equal(unstaged.status.get("plain-renamed.md"), "D", "the source is a real deletion");
  assert.equal(unstaged.status.get("plain-moved.md"), "??", "the destination is a real untracked file");
  assert.deepEqual([...unstaged.renames], [], "git reported no rename, so none is invented");
} finally {
  rmSync(repo, { recursive: true, force: true });
}

console.log("workspace-git-rename validation passed");
