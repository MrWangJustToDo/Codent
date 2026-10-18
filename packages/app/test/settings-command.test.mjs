/**
 * `/settings` — the renamed `/appearance` command, its one-row-per-setting menu,
 * the `config` entry that opens the model-config editor, and the alias that keeps
 * `/appearance` working.
 *
 * Run: node packages/app/test/settings-command.test.mjs
 */
import assert from "node:assert/strict";

import { getAllCommands, getCommand } from "../dist/index.mjs";

const settings = getCommand("settings");
assert.ok(settings, "/settings must be registered");

// ---------------------------------------------------------------------------
// 1. Alias: the old name still resolves to the same command
// ---------------------------------------------------------------------------
assert.ok(settings.aliases?.includes("appearance"), "aliases the old name");
assert.equal(getCommand("appearance"), settings, "/appearance resolves to /settings");
assert.equal(getCommand("nope"), undefined, "unknown commands stay unknown");
assert.equal(
  getAllCommands().filter((c) => c.name === "settings").length,
  1,
  "listed once, under its canonical name only"
);

// ---------------------------------------------------------------------------
// 2. Menu: one toggle per setting + the config entry, no duplicate value rows
// ---------------------------------------------------------------------------
const options = settings.getOptions();
const rows = options.filter((o) => !o.separator).map((o) => o.label);
assert.deepEqual(rows, ["theme", "display", "diff", "thinking", "config"], "one row per setting");
assert.equal(options.filter((o) => o.separator).length, 1, "settings grouped above the config entry");

// ---------------------------------------------------------------------------
// 3. Toggles still work, and explicit values are still accepted
// ---------------------------------------------------------------------------
assert.equal(settings.execute("").ok, false, "empty args explain usage");
assert.equal(settings.execute("bogus").ok, false, "unknown args rejected");

const theme = settings.execute("theme");
assert.equal(theme.ok, true);
assert.equal(settings.execute(`theme ${theme.message.replace("Theme: ", "")}`).ok, true, "explicit theme accepted");

const display = settings.execute("display");
assert.match(display.message, /^Display mode: (compact|full)$/);
const restored = settings.execute(display.message.includes("compact") ? "display full" : "display compact");
assert.equal(restored.ok, true);

const diff = settings.execute("diff");
assert.match(diff.message, /^Diff renderer: (lite|full)$/);
assert.equal(settings.execute("diff lite").ok, true);
assert.equal(settings.execute("diff full").ok, true);
assert.equal(settings.execute("diff bogus").ok, false);

// The thinking line moved here from `/effort display` — the model commands no longer carry a UI toggle.
const thinking = settings.execute("thinking");
assert.match(thinking.message, /^Thinking line: (on|off)$/, thinking.error ?? thinking.message);
assert.equal(settings.execute("thinking on").ok, true);
assert.equal(settings.execute("thinking off").ok, true);
assert.equal(settings.execute("THINKING ON").ok, true, "args are case-insensitive");
assert.equal(settings.execute("thinking bogus").ok, false);
assert.match(settings.execute("thinking on").message, /^Thinking line: on$/);

// ---------------------------------------------------------------------------
// 4. `config` opens the editor (store-side effect only — no write happens here)
// ---------------------------------------------------------------------------
const opened = settings.execute("config");
assert.equal(opened.ok, true, "config opens the editor");
assert.equal(settings.execute("CONFIG").ok, true, "args are case-insensitive");

console.log("settings-command: ok");
