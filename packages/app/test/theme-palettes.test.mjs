/**
 * Theme palette behavior.
 *
 * `applyColorPalette` reassigns the shared `COLORS` / `BG` objects in place, which only works if
 * every consumer reads them **at render time**. A module-level snapshot (`const STATUS_COLORS = {
 * pending: COLORS.muted }`) freezes the palette that was active at import, so `/settings theme`
 * changes the header and the input box while a todo list keeps the previous theme's colors.
 *
 * `scripts/validate-theme-palettes.mjs` guards the source shape (no module-scope capture, key
 * parity, contrast floors); this file proves the runtime seam actually repaints, driving the real
 * store rather than a copy.
 *
 * Run: node packages/app/test/theme-palettes.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

const load = (path) => import(new URL(`../dist/${path}`, import.meta.url).href);

const { useTheme } = await load("hooks/use-theme.mjs");
const { getFileIconStyle, getFolderIconStyle, setNerdIconsEnabledForTesting } = await load("utils/file-icons.mjs");
const { getToolCallColor } = await load("index.mjs");

setNerdIconsEnabledForTesting(false);

const actions = useTheme.getActions();

/** Read the palette through the same helpers the UI uses (the objects themselves are not exported). */
function readPalette() {
  return {
    primary: getFolderIconStyle(true, "src").color,
    success: getToolCallColor("output-available"),
    danger: getToolCallColor("output-error"),
    warning: getToolCallColor("approval-requested"),
    muted: getToolCallColor("unknown"),
    badgeFallback: getFileIconStyle("/notes").color,
  };
}

test("the default theme is gemini", () => {
  assert.equal(actions.getTheme(), "gemini");
  const palette = readPalette();
  assert.deepEqual(palette, {
    primary: "#58A6FF",
    success: "#3FB950",
    danger: "#FF6157",
    warning: "#E3B341",
    muted: "#8B949E",
    badgeFallback: "#8B949E",
  });
});

test("switching to claude repaints every consumer, including the ones that used to snapshot", () => {
  actions.setTheme("claude");
  const palette = readPalette();

  assert.deepEqual(palette, {
    primary: "#E0805F",
    success: "#7DA88A",
    danger: "#EA6469",
    warning: "#D4A04C",
    muted: "#A6957F",
    badgeFallback: "#A6957F",
  });

  // The bug this file exists for: the todo tool's `[>]` / `[✓]` rows read these same three roles
  // through a module-level table, so they rendered gemini colors in a claude session.
  assert.notEqual(palette.success, "#3FB950");
  assert.notEqual(palette.muted, "#8B949E");
});

test("the two palettes disagree on every role, so a theme switch is always visible", () => {
  const read = (theme) => {
    actions.setTheme(theme);
    return readPalette();
  };
  const gemini = read("gemini");
  const claude = read("claude");

  for (const role of Object.keys(gemini)) {
    assert.notEqual(claude[role], gemini[role], `${role} is identical in both themes`);
  }
});

test("switching back restores the first palette exactly — no Object.assign residue", () => {
  actions.setTheme("gemini");
  const before = readPalette();

  actions.setTheme("claude");
  actions.setTheme("gemini");

  assert.deepEqual(readPalette(), before);
});
