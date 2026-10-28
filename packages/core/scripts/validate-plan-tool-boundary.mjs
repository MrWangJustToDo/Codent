/**
 * Validation: plan mode withholds every tool that declares itself as editing the workspace.
 *
 * Run: pnpm --filter @codent/core run validate:plan-tool-boundary
 *
 * The withheld set used to be a four-name list, and the built-in `code_rewrite` — declared
 * `category: "edits"`, able to write in place with `dry_run: false` — was on no list. A plan could
 * therefore be authored while the code it described was being edited underneath it, and plan mode's
 * verification gate (its only hard gate) had no way to notice. The set is derived from the tool's own
 * declaration now.
 *
 * The declared truth is `BUILTIN_PRESENTATION` — the table the presentation registry falls back to,
 * which `validate:tool-presentation` pins to the definition sites, so the two cannot disagree. That is
 * also why this can assert the LSP tools (`code_rewrite`, `lsp_rename`) without activating the LSP
 * extension: their category is declared, not inferred here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILTIN_PRESENTATION,
  createPlanModeMiddleware,
  formatToolOutput,
  PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES,
  createDeleteFileTool,
  createEditFileTool,
  createWriteFileTool,
  getPlanModeToolBlockReason,
  getPlanModeToolExcludeSet,
  isPlanModeForbiddenTool,
  isWorkspaceEditingTool,
} from "../dist/dev.mjs";

// A plan refusal is a DENIAL, not a tool failure (and definitely not a success).
//
// It used to return a bare `{ error }`: the UI reads no `success` from that shape, so a blocked
// tool rendered as a green success row with no body while the extension refusal (which carries
// `denied: true`) rendered as denied. One refusal, two looks — and this one looked successful.
{
  const middleware = createPlanModeMiddleware({
    getPlanMode: () => ({ isRestrictingTools: () => true }),
  });
  const action = await middleware.onBeforeToolCall?.({}, { toolName: "write_file", args: {} });
  assert.equal(action?.type, "skip", "plan mode skips a blocked tool");
  assert.equal(action.result.success, false, "…with the shared denial marker");
  assert.equal(action.result.denied, true);
  assert.equal(action.result.cancelled, false);
  assert.match(String(action.result.error), /blocked while planning/);
  assert.match(
    formatToolOutput(action.result, "write_file"),
    /Denied/,
    "the row says denied instead of rendering as a successful empty result"
  );
}

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every tool whose declaration says it edits the workspace. */
const editing = Object.entries(BUILTIN_PRESENTATION)
  .filter(([, entry]) => entry.category === "edits")
  .map(([name]) => name)
  .sort();

assert.ok(editing.length >= 5, `expected the editing tools, found ${editing.join(", ") || "none"}`);
for (const expected of ["write_file", "edit_file", "delete_file", "code_rewrite", "lsp_rename", "memory_write"]) {
  assert.ok(editing.includes(expected), `${expected} declares \`edits\` and must be part of the set`);
}

// ============================================================================
// 1. The rule withholds every editing tool, by declaration
// ============================================================================

{
  // Real instantiation first: `defineServerTool` registers the same category as a side effect, which
  // is the other half of "the declaration and the rule agree".
  createWriteFileTool();
  createEditFileTool();
  createDeleteFileTool();

  for (const name of editing) {
    assert.ok(
      isWorkspaceEditingTool(name),
      `${name} declares \`edits\`, so the boundary's read of the declaration must see it`
    );
    assert.ok(
      isPlanModeForbiddenTool(name),
      `${name} edits the workspace, so plan mode must withhold it — a name list is what missed \`code_rewrite\``
    );
  }

  // The end the model sees: withheld tools are absent from the record, so they cannot be named at all.
  // Only the keys are read.
  const record = Object.fromEntries([...editing.map((name) => [name, {}]), ["read_file", {}], ["run_command", {}]]);
  const exclude = getPlanModeToolExcludeSet(record);
  for (const name of editing) {
    assert.ok(exclude.has(name), `${name} must be excluded from the tool record while planning`);
  }
  assert.ok(!exclude.has("read_file"), "a read-only tool is not excluded");
  assert.ok(!exclude.has("run_command"), "run_command is governed by the command allowlist, not withheld");

  // …and the end that catches a call arriving anyway (a stale record, a queued call).
  const restricting = { isRestrictingTools: () => true };
  for (const name of editing) {
    assert.match(
      getPlanModeToolBlockReason(restricting, name, {}) ?? "",
      /blocked while planning/i,
      `${name}: a call that arrives anyway is refused before it executes`
    );
  }
  assert.equal(
    getPlanModeToolBlockReason({ isRestrictingTools: () => false }, "write_file", {}),
    null,
    "nothing is refused when plan mode is not restricting"
  );

  // Tools that stay available: reading, exploration, and the shell under the command allowlist.
  for (const name of ["read_file", "glob", "grep", "tree", "list_file", "task", "run_command", "ask_user"]) {
    assert.equal(isPlanModeForbiddenTool(name), false, `${name} must remain available while planning`);
  }

  // An extension tool that declares nothing has unknown effects. Plan mode is a safety boundary:
  // fail closed instead of letting a third-party write tool run during planning.
  assert.equal(
    isPlanModeForbiddenTool("ext_write_config"),
    true,
    "an undeclared extension tool is treated as editing/unknown while planning"
  );
  assert.equal(
    isWorkspaceEditingTool("ext_write_config"),
    true,
    "the unknown-effect rule is the same one the exclusion set uses"
  );
}

// ============================================================================
// 2. The exceptions are named, reasoned, and are not editing tools
// ============================================================================

{
  assert.deepEqual(
    [...PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES].sort(),
    ["kill_command"],
    "the tools withheld for a reason other than editing are named (each with its reason beside it)"
  );
  for (const name of PLAN_MODE_EXCLUDED_NON_EDIT_TOOL_NAMES) {
    assert.equal(isPlanModeForbiddenTool(name), true, `${name} is withheld`);
    assert.equal(
      isWorkspaceEditingTool(name),
      false,
      `${name} is withheld by the exception rule, which carries its own reason — not by the category rule`
    );
  }

  const planTools = readFileSync(join(SRC, "agent/plan/plan-tools.ts"), "utf8");
  assert.match(planTools, /`kill_command` — background-job control/, "the exception states why it is withheld");
  assert.match(planTools, /isWorkspaceEditingTool/, "the derivation goes through the declaration");
  assert.ok(
    !/PLAN_MODE_EXCLUDED_TOOL_NAMES/.test(planTools),
    "the old four-name list is gone (no second source for the boundary)"
  );
  // The category is documented as load-bearing where it is declared, so re-categorizing reads as a
  // boundary change.
  assert.match(
    readFileSync(join(SRC, "agent/tools/presentation/types.ts"), "utf8"),
    /`edits` is \*\*load-bearing beyond display\*\*/,
    "the category's role in plan mode is recorded at its declaration"
  );
}

// ============================================================================
// 3. Editing tools are approval-gated, not just plan-mode-gated
// ============================================================================
//
// Plan mode withholding a write tool protects the PLANNING phase. Outside it, the user still has to
// be asked, and that is `needsApproval` — a separate declaration. `code_rewrite` (category `edits`,
// writes with `dry_run: false`) had neither: plan mode withheld it after the boundary was made
// declarative, but with no approval it applied multi-file rewrites with no prompt at all.
//
// Source-level because the LSP tool is a plain object built from live deps (a grammar locator and
// manager), while the fs tools are instantiable — both are `defineServerTool` declarations, so the
// literal is the contract in each case.
{
  const read = (relative) => readFileSync(join(SRC, relative), "utf8");
  assert.match(
    read("agent/lsp/tools/code-rewrite.ts"),
    /needsApproval:\s*true/,
    "code_rewrite declares `edits` and can write, so it must be approval-gated"
  );
  for (const tool of [createWriteFileTool(), createEditFileTool(), createDeleteFileTool()]) {
    assert.equal(tool.needsApproval, true, `${tool.name}: a workspace-mutating tool must declare needsApproval`);
  }
}

console.log("plan-tool-boundary validation passed");
