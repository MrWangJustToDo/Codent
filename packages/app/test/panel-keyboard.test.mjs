/**
 * The panel gate: which keystrokes reach the app at all.
 *
 * Both functions read the SAME panel list (`PANEL_SURFACES` in `keybindings/context.ts`), and this
 * file pins the two properties the central handlers depend on:
 *
 * 1. a panel that is up blocks the keyboard (`isAnyPanelOpen`);
 * 2. a panel that just closed — because its own `useInput` handled the very keystroke now being
 *    dispatched to everyone else — is still remembered for its debounce window
 *    (`panelJustClosed`).
 *
 * (2) is the one that regressed: the config editor had no `lastClosedAt`, so the Esc that closed
 * it fell through to the global branch and aborted the in-flight run. A panel missing from the
 * list is the failure mode, so every panel is asserted here.
 *
 * Run: node packages/app/test/panel-keyboard.test.mjs
 */
import assert from "node:assert/strict";

import { isAnyPanelOpen, panelJustClosed } from "../dist/hooks/keybindings/context.mjs";
import { useConfigEditor } from "../dist/hooks/use-config-editor.mjs";
import { useExtensionPanel } from "../dist/hooks/use-extension-panel.mjs";
import { useSubagentPanel } from "../dist/hooks/use-subagent-panel.mjs";
import { useWorkspacePanel } from "../dist/hooks/use-workspace-panel.mjs";

// Nothing has happened yet: no panel is up, and none has just closed (a `lastClosedAt` of 0 is
// far outside the window, which is what keeps a fresh process from swallowing the first Esc).
assert.equal(isAnyPanelOpen(), false, "no panel is open to begin with");
assert.equal(panelJustClosed(), false, "and none has just closed");

/** Each panel, in the order a user reaches it. `open` is the action that brings it up. */
const PANELS = [
  {
    name: "config editor",
    open: () => useConfigEditor.getActions().open(),
    close: () => useConfigEditor.getActions().close(),
  },
  {
    name: "workspace",
    open: () => useWorkspacePanel.getActions().open(),
    close: () => useWorkspacePanel.getActions().close(),
  },
  {
    name: "task panel",
    open: () => useSubagentPanel.getActions().openList(),
    close: () => useSubagentPanel.getActions().close(),
  },
  {
    name: "extensions",
    open: () => useExtensionPanel.getActions().open(),
    close: () => useExtensionPanel.getActions().close(),
  },
];

for (const panel of PANELS) {
  panel.open();
  assert.equal(isAnyPanelOpen(), true, `${panel.name}: blocks the keyboard while it is up`);

  panel.close();
  assert.equal(isAnyPanelOpen(), false, `${panel.name}: releases the keyboard when closed`);
  assert.equal(panelJustClosed(), true, `${panel.name}: the keystroke that closed it must not reach the global abort`);
}

console.log("panel-keyboard validation passed");
