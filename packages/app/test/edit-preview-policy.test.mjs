/**
 * Validates that an edit_file diff is never PREDICTED after the write has landed.
 *
 * `previewEdit` resolves the edit against the file as it is NOW, so for a call whose part has no
 * `output` yet it recomputed against the already-edited file, failed to match, and rendered
 * `⚠ edit_file will refuse this` plus a `newFile === oldFile` diff ("no changes") for an edit that
 * had succeeded. The reachable window is "after the write, before the result lands": a part is
 * `approval-responded` with no output until then, and it can stay there (the session log shows
 * `approval-responded → complete` normally, `→ error` when the run ends first).
 *
 * Run: node --test test/edit-preview-policy.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

const { isPreExecutionToolState } = await import(new URL("../dist/index.mjs", import.meta.url).href);

test("a diff is predicted only for a call that has not executed", () => {
  // Pre-execution: the write has not happened, so the prediction is meaningful.
  assert.equal(isPreExecutionToolState("approval-requested"), true, "the approval decision");
  assert.equal(isPreExecutionToolState("input-available"), true, "args complete, not run");
  assert.equal(isPreExecutionToolState("input-streaming"), true, "args still streaming → not run");

  // Post-execution. `approval-responded` is the state the false refusal was rendered from: the
  // approval was answered, so the write may already have landed.
  assert.equal(isPreExecutionToolState("approval-responded"), false, "answered — may be written");
  assert.equal(isPreExecutionToolState("output-available"), false);
  assert.equal(isPreExecutionToolState("output-error"), false);
  assert.equal(isPreExecutionToolState("output-denied"), false);
});

test("the preview is gated on that predicate at both ends", () => {
  const component = readFileSync(new URL("../src/messages/EditFilePreview.tsx", import.meta.url), "utf8");
  assert.ok(component.includes("canPreview"), "the component takes the execution-state flag");
  assert.ok(
    component.includes("!canPreview ? undefined"),
    "the preview input is withheld unless the call may still be predicted"
  );
  assert.ok(
    component.includes("usePreviewEdit(previewInput?.toolCallId"),
    "…and the preview hook is fed only from that decision"
  );

  const caller = readFileSync(new URL("../src/messages/ToolInputView.tsx", import.meta.url), "utf8");
  assert.ok(
    caller.includes("isPreExecutionToolState(uiState)"),
    "…which the call site derives from the tool state, not from the presence of an output"
  );
});
