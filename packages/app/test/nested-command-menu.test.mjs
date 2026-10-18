/**
 * Nested option menus — the generic two-level interaction `/models` relies on.
 *
 * The menu used to be one level deep: every row executed `/cmd <value>`. `/models` needs a model
 * level and, for models that advertise thinking depth, a depth level under it — with `Esc` retreating
 * one level instead of closing the whole menu, and **nothing committed** until a leaf is accepted.
 *
 * This suite drives `useAutocomplete` directly (it is a plain reactivity-store state, no renderer
 * needed), which is also where the retreat / path / in-flight bookkeeping lives. The probe command is
 * registered through the PUBLIC extension-command entry point rather than a test-only export, so the
 * suite exercises the same registration path a real extension command takes.
 *
 * Run: node packages/app/test/nested-command-menu.test.mjs
 */
import assert from "node:assert/strict";

import { getAllCommands, registerExtensionCommand, useAutocomplete, useUserInput } from "../dist/index.mjs";

const autocomplete = useAutocomplete.getActions();
const state = () => useAutocomplete.getReadonlyState();
const labels = () => state().suggestions.map((s) => s.label);

/** Reset between cases: the store is module state shared by every test in this file. */
function reset(input = "/nested-probe ") {
  autocomplete.dismiss();
  useUserInput.getActions().setValue("");
  autocomplete.update(input);
}

/** Move the cursor to the row with this label (fails loudly rather than looping forever). */
function select(label) {
  const target = state().suggestions.findIndex((s) => s.label === label);
  assert.ok(target >= 0, `row "${label}" is in the menu (have: ${labels().join(", ")})`);
  let guard = 0;
  while (state().selectedIndex !== target) {
    autocomplete.selectNext();
    assert.ok((guard += 1) < 100, "selectNext terminates");
  }
}

const DEPTHS = ["low", "high"];

// ---------------------------------------------------------------------------
// Two probe commands: a synchronous one, and one whose submenu resolves later
// (the `/models` shape — a depth list needs a metadata lookup).
// ---------------------------------------------------------------------------
registerExtensionCommand({
  name: "nested-probe",
  description: "probe",
  usage: "/nested-probe",
  immediate: false,
  allowCustomInput: true,
  getOptions: (_ctx, path) => {
    if (path && path.length > 0) return DEPTHS.map((d) => ({ label: d, value: d }));
    return [
      { label: "leaf", value: "leaf", description: "no submenu" },
      { label: "branch", value: "branch", description: "opens a submenu", getOptions: () => buildDepth() },
      // Declares a submenu that answers nothing — must behave like a leaf.
      { label: "empty", value: "empty", description: "empty submenu", getOptions: () => [] },
      // Same, but resolved asynchronously — the case that cannot be known synchronously.
      {
        label: "slow-empty",
        value: "slow-empty",
        description: "async, resolves empty",
        getOptions: () => Promise.resolve([]),
      },
      { label: "slow", value: "slow", description: "async submenu", getOptions: () => deferred.promise },
    ];
  },
  execute: () => ({ ok: true }),
});
function buildDepth() {
  return DEPTHS.map((d) => ({ label: d, value: d }));
}

// A row whose VALUE has uppercase letters, like a real model id (`Qwen/Qwen3`). The typed prefix is
// lowercased before matching, so a case-sensitive prefix comparison would decide the user had typed
// past the level and close the menu the moment it opened.
registerExtensionCommand({
  name: "case-probe",
  description: "probe",
  usage: "/case-probe",
  immediate: false,
  getOptions: (_ctx, path) =>
    path && path.length > 0
      ? [{ label: "high", value: "high" }]
      : [{ label: "Upper-Model", value: "Upper-Model", getOptions: () => [{ label: "high", value: "high" }] }],
  execute: () => ({ ok: true }),
});

/** A submenu whose promise the test settles by hand, to drive the in-flight window. */
function makeDeferred() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}
let deferred = makeDeferred();

const probe = getAllCommands().find((c) => c.name === "nested-probe");
assert.ok(probe, "the probe command is registered through the public entry point");

// ---------------------------------------------------------------------------
// 1. Opening the command shows the root level; nothing has executed
// ---------------------------------------------------------------------------
reset();
assert.equal(state().mode, "options");
assert.deepEqual(
  labels(),
  ["leaf", "branch", "empty", "slow-empty", "slow", "type custom…"],
  "root level rows (plus the typed-argument row)"
);
assert.deepEqual(state().optionPath, [], "the root level has an empty path");
assert.equal(state().suggestions.find((s) => s.label === "branch")?.hasSubmenu, true, "getOptions = submenu");
assert.equal(state().suggestions.find((s) => s.label === "leaf")?.hasSubmenu, false, "no getOptions = leaf");

// ---------------------------------------------------------------------------
// 2. Descending: the path grows and the input becomes the level's prefix
// ---------------------------------------------------------------------------
{
  select("branch");
  assert.deepEqual(autocomplete.accept("/nested-probe "), { type: "input", value: "/nested-probe branch " });
  assert.deepEqual(state().optionPath, ["branch"], "the path records the level");
  assert.deepEqual(labels(), DEPTHS, "the submenu's rows are shown");
  assert.equal(state().visible, true, "descending keeps the menu open");
}

// ---------------------------------------------------------------------------
// 3. Esc retreats one level (and does NOT close the menu)
// ---------------------------------------------------------------------------
{
  // Still one level deep from the previous case.
  assert.equal(autocomplete.back(), "/nested-probe ", "back() returns the parent level's input");
  assert.deepEqual(state().optionPath, [], "the path is popped");
  assert.equal(state().visible, true, "the menu stays open on retreat");
  assert.ok(labels().includes("branch"), "the parent level's rows are restored");
  assert.equal(state().levels.length, state().optionPath.length + 1, "stack and path stay in step");
  // Only the root has nowhere to retreat to — that is when Esc closes.
  assert.equal(autocomplete.back(), null, "the root level has no parent");
}

// ---------------------------------------------------------------------------
// 4. A leaf executes `/cmd <path…> <value>` — the whole chain travels in the args
// ---------------------------------------------------------------------------
{
  select("leaf");
  assert.deepEqual(autocomplete.accept("/nested-probe "), { type: "execute", value: "/nested-probe leaf" });
  assert.equal(state().visible, false, "executing closes the menu");
  assert.deepEqual(state().optionPath, [], "the path is cleared");
}

// ---------------------------------------------------------------------------
// 5. A nested leaf carries the parent's value in its args
// ---------------------------------------------------------------------------
{
  reset();
  select("branch");
  autocomplete.accept("/nested-probe ");
  select("high");
  assert.deepEqual(
    autocomplete.accept("/nested-probe branch "),
    { type: "execute", value: "/nested-probe branch high" },
    "the args are the full chain, which is what the command re-parses"
  );
}

// ---------------------------------------------------------------------------
// 6. A SYNCHRONOUSLY empty submenu is treated as a leaf
// ---------------------------------------------------------------------------
{
  reset();
  select("empty");
  assert.deepEqual(
    autocomplete.accept("/nested-probe "),
    { type: "execute", value: "/nested-probe empty" },
    "an empty submenu executes instead of opening an empty level"
  );
  assert.deepEqual(state().optionPath, [], "no level was pushed for the empty submenu");
}

// ---------------------------------------------------------------------------
// 7. An ASYNCHRONOUS submenu that resolves empty behaves as a LEAF
//
// This is the `/models` case: the depth list needs a metadata lookup, so "does this model have a
// level?" is not knowable when the row is accepted. The accept already wrote the row's full path into
// the input, so when the answer is empty the menu closes and that path stays as the leaf — the next
// Enter runs it. (Restoring the parent was the bug: the input still named the deeper path, so the
// parent's first row was displayed as selected while typing re-filtered back to the row that had just
// answered empty. A model with no thinking depth could never be switched.)
// ---------------------------------------------------------------------------
{
  reset();
  select("slow-empty");
  assert.deepEqual(
    autocomplete.accept("/nested-probe "),
    { type: "input", value: "/nested-probe slow-empty " },
    "the row's path is written to the input before the resolver answers"
  );
  assert.deepEqual(state().optionPath, ["slow-empty"], "the level is entered optimistically");
  // Let the resolver settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state().visible, false, "an empty async level closes instead of stranding the user");
  assert.deepEqual(state().optionPath, [], "no level is left on the path");
  assert.deepEqual(state().levels, [], "no level is left on the stack");
}

// ---------------------------------------------------------------------------
// 8. Retreating WHILE a level is still loading must not let its rows land later
//
// The continuation is positional (`slice(0, -1)`), so without a load token a late answer would
// replace the PARENT level and leave `levels.length` and `optionPath.length` describing different
// depths — rows rendered for a level the user already left.
// ---------------------------------------------------------------------------
{
  deferred = makeDeferred();
  reset();
  select("slow");
  autocomplete.accept("/nested-probe ");
  assert.deepEqual(state().optionPath, ["slow"], "entered the async level");
  assert.equal(state().levels.length, 2);

  assert.equal(autocomplete.back(), "/nested-probe ", "Esc during the load still retreats");
  assert.deepEqual(state().optionPath, [], "back at the root");
  assert.equal(state().levels.length, 1, "one level, not a leaked placeholder");

  // The late answer arrives AFTER the retreat.
  deferred.settle(DEPTHS.map((d) => ({ label: d, value: d })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(state().optionPath, [], "the stale load did not re-enter the level");
  assert.equal(state().levels.length, 1, "the stale load did not push a level");
  assert.ok(
    state().suggestions.every((s) => !DEPTHS.includes(s.label)),
    `stale rows did not overwrite the parent level (have: ${labels().join(", ")})`
  );
}

// ---------------------------------------------------------------------------
// 9. Dismissing WHILE loading must not reopen the menu
// ---------------------------------------------------------------------------
{
  deferred = makeDeferred();
  reset();
  select("slow");
  autocomplete.accept("/nested-probe ");
  autocomplete.dismiss();
  assert.equal(state().visible, false);
  deferred.settle(DEPTHS.map((d) => ({ label: d, value: d })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state().visible, false, "the late answer did not reopen the menu");
  assert.deepEqual(state().levels, [], "no level was written after dismiss");
}

// ---------------------------------------------------------------------------
// 10. Typing past the level closes the menu instead of filtering against it
// ---------------------------------------------------------------------------
{
  reset();
  select("branch");
  autocomplete.accept("/nested-probe ");
  // `hig` is inside the level, so filtering works and the level prefix is stripped first.
  autocomplete.update("/nested-probe branch hig");
  assert.deepEqual(labels(), ["high"], "the level prefix is stripped before matching");
  // A hand-written full argument list is not a level any more.
  autocomplete.update("/nested-probe branch low extra");
  assert.equal(state().visible, false, "typing past the level leaves the menu");
}

// ---------------------------------------------------------------------------
// 11. `/effort` is gone; `/models` owns depth
// ---------------------------------------------------------------------------
{
  assert.equal(
    getAllCommands().find((c) => c.name === "effort"),
    undefined,
    "/effort is no longer a built-in command"
  );
  assert.ok(
    getAllCommands().find((c) => c.name === "models"),
    "/models is the one model command"
  );
}

console.log("nested-command-menu: ok");

// ---------------------------------------------------------------------------
// 12. The typed-argument row belongs to the ROOT level only
//
// `allowCustomInput` describes a command's top-level arguments. A submenu is a closed set (a depth
// list defines every legal value), so offering "type custom…" there would present a value the resolver
// deliberately did not enumerate — and executing it would send the parent path, not a depth.
// ---------------------------------------------------------------------------
{
  reset();
  assert.ok(labels().includes("type custom…"), "the root level offers the typed-argument row");
  select("branch");
  autocomplete.accept("/nested-probe ");
  assert.ok(!labels().includes("type custom…"), "a submenu is a closed set: no freeform row");
}

// ---------------------------------------------------------------------------
// 13. A level value's case does not end the level
// ---------------------------------------------------------------------------
{
  autocomplete.dismiss();
  autocomplete.update("/case-probe ");
  select("Upper-Model");
  assert.deepEqual(autocomplete.accept("/case-probe "), { type: "input", value: "/case-probe Upper-Model " });
  // The input layer lowercases for matching; the path keeps the option's spelling.
  autocomplete.update("/case-probe Upper-Model ");
  assert.equal(state().visible, true, "the level survives the case difference");
  assert.deepEqual(labels(), ["high"], "the level's rows are shown");
}
