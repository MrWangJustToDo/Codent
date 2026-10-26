/**
 * Validation for the unified `registerContextProvider({ content, disabledContent })`
 * disabled-notice semantics.
 *
 * Verifies that disabling at runtime injects the extension's custom disabledContent
 * into turn-context under the same kind tag; that undefined/absent falls back to a
 * generic notice; that an empty string opts out entirely; and that re-enabling
 * clears the notice.
 *
 * Run: pnpm --filter @codent/core run validate:extension-disable-notice
 */

import assert from "node:assert/strict";

import { ExtensionRunner } from "../dist/dev.mjs";

async function collect(runner, id) {
  await runner.setEnabled(id, false);
  const collected = await runner.collectBeforeAgentStart("x", "id");
  return collected.turnContextSections ?? [];
}

async function disableText(runner, id) {
  const sections = await collect(runner, id);
  // Extension kinds are namespaced: `ext:<id>`.
  const section = sections.find((s) => s.id === `ext:${id}`);
  return section?.content ?? "";
}

// 1. Custom disabledContent via registerContextProvider({ disabledContent }).
{
  const runner = new ExtensionRunner({ getEnvVar: () => undefined });
  await runner.loadExtension({
    id: "custom",
    name: "Custom Ext",
    version: "1.0.0",
    description: "custom notice",
    activate(ctx) {
      ctx.registerContextProvider({
        content: () => "widgets on",
        disabledContent: () => "Custom ext is switched off — its widgets are gone.",
      });
    },
  });
  // Enabled: content injected under its own kind.
  const enabled = await runner.collectBeforeAgentStart("x", "id");
  assert.deepEqual(enabled.turnContextSections, [{ id: "ext:custom", content: "widgets on" }]);
  // Disabled: same tag, disabled notice only.
  const text = await disableText(runner, "custom");
  assert.equal(text, "Custom ext is switched off — its widgets are gone.");
}

// 2. No disabledContent -> generic default (still informative).
{
  const runner = new ExtensionRunner({ getEnvVar: () => undefined });
  await runner.loadExtension({
    id: "plain",
    name: "Plain Ext",
    version: "1.0.0",
    description: "no custom notice",
    activate(ctx) {
      ctx.registerContextProvider({ content: () => "active" });
    },
  });
  const text = await disableText(runner, "plain");
  assert.match(text, /Plain Ext.*is disabled/);
}

// 3. Empty string -> opt out (no notice at all).
{
  const runner = new ExtensionRunner({ getEnvVar: () => undefined });
  await runner.loadExtension({
    id: "muted",
    name: "Muted Ext",
    version: "1.0.0",
    description: "silent on disable",
    activate(ctx) {
      ctx.registerContextProvider({
        content: () => "active",
        disabledContent: () => "   ",
      });
    },
  });
  const text = await disableText(runner, "muted");
  assert.equal(text, "", "empty/whitespace disabledContent should inject nothing");
}

// 4. Re-enabling clears the notice and restores the content under the same tag.
{
  const runner = new ExtensionRunner({ getEnvVar: () => undefined });
  await runner.loadExtension({
    id: "toggle",
    name: "Toggle Ext",
    version: "1.0.0",
    description: "clear on enable",
    activate(ctx) {
      ctx.registerContextProvider({
        content: () => "toggle active",
        disabledContent: () => "toggle is off",
      });
    },
  });
  await runner.setEnabled("toggle", false);
  const off = await runner.collectBeforeAgentStart("x", "id");
  assert.match(off.turnContextSections?.[0]?.content ?? "", /toggle is off/);
  await runner.setEnabled("toggle", true);
  const on = await runner.collectBeforeAgentStart("x", "id");
  assert.deepEqual(on.turnContextSections, [{ id: "ext:toggle", content: "toggle active" }]);
}

console.log("extension-disable-notice validation passed");
