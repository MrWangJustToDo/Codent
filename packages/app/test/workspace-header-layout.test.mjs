import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

const { planWorkspaceHeader, workspaceHeaderWidth, textDisplayWidth } = await import(
  new URL("../dist/index.mjs", import.meta.url).href
);

/** A wide workspace: busy agent, full path, branch + sha + sync, files count and diff totals. */
const full = {
  busy: "● running",
  mode: "diff",
  path: "/Users/me/projects/translate",
  branch: "main*",
  shortSha: "abc1234",
  sync: "↑1 ↓2",
  files: "3 files",
  added: "+12",
  deleted: "−4",
};

/** Title + activity + view mode + branch: the groups the bar never drops. */
const FLOOR = "Workspace · ● running · diff · main*";

test("a wide bar keeps every group", () => {
  const plan = planWorkspaceHeader(full, 200);
  assert.deepEqual(plan, { busy: true, path: "full", sha: true, sync: true, files: true, diffs: true });
  assert.equal(
    workspaceHeaderWidth(full, plan),
    textDisplayWidth(
      "Workspace · ● running · diff · /Users/me/projects/translate · main* abc1234 ↑1 ↓2 · 3 files +12 −4"
    )
  );
});

test("the plan always fits the width it was given", () => {
  for (let available = 140; available >= 4; available -= 1) {
    const plan = planWorkspaceHeader(full, available);
    const width = workspaceHeaderWidth(full, plan);
    // Below the floor the bar keeps the non-negotiable groups and the renderer truncates the tail.
    assert.ok(width <= available || width === textDisplayWidth(FLOOR), `available=${available} planned ${width}`);
  }
});

test("sha, then sync, go before anything structural", () => {
  const noSha = planWorkspaceHeader(full, 95);
  assert.equal(noSha.sha, false);
  assert.equal(noSha.sync, true);
  assert.equal(noSha.path, "full");

  const noSync = planWorkspaceHeader(full, 85);
  assert.equal(noSync.sync, false);
  assert.equal(noSync.path, "full");
  assert.equal(noSync.files, true);
});

test("the path survives longer than the file count", () => {
  const plan = planWorkspaceHeader(full, 80);
  assert.equal(plan.path, "full");
  assert.equal(plan.files, false, "the file count is what the path costs");
  assert.equal(plan.diffs, true, "+a −d outlive both");
});

test("the path collapses to its last segment, then disappears", () => {
  assert.equal(planWorkspaceHeader(full, 70).path, "basename");
  assert.equal(planWorkspaceHeader(full, 40).path, "none");
});

test("an unmeasured width never degrades the bar", () => {
  assert.deepEqual(planWorkspaceHeader(full, 0), {
    busy: true,
    path: "full",
    sha: true,
    sync: true,
    files: true,
    diffs: true,
  });
});

test("absent groups never widen the bar", () => {
  const idle = {
    busy: null,
    mode: "preview",
    path: "",
    branch: null,
    shortSha: null,
    sync: null,
    files: null,
    added: null,
    deleted: null,
  };
  const plan = planWorkspaceHeader(idle, 20);
  assert.equal(workspaceHeaderWidth(idle, plan), textDisplayWidth("Workspace · preview"));
});
