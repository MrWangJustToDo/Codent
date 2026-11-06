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

import { clearCoreEnv, ExtensionRunner, registerCoreEnv, TurnContextController } from "../dist/dev.mjs";

import { fakeModeState } from "./helpers/mode-state.mjs";

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
  const runner = new ExtensionRunner({});
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
  const runner = new ExtensionRunner({});
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
  const runner = new ExtensionRunner({});
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
  const runner = new ExtensionRunner({});
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

// 5. A mid-turn re-enable takes the notice back out of the CURRENT turn's snapshot.
//
// The disable path is wired through `onExtensionDisabled` → `clearExtensionTurnContext(id, notice)`,
// which replaces the live section with the notice. Without the mirror callback the notice stayed
// for the rest of the turn while the tools were live again (the next prepared turn was correct,
// which is why the runner-level assertions above could not see it).
{
  const env = {
    rootPath: "/repo",
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => "/home/user",
    fs: {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: async () => {},
      exists: async () => false,
      readdir: async () => [],
      stat: async () => {
        throw new Error("ENOENT");
      },
    },
    runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
  };
  registerCoreEnv(env);
  try {
    const events = [];
    // The controller is created after the runner (it needs it) but the callbacks only fire on
    // toggles, which happen below.
    let controller;
    const runner = new ExtensionRunner({
      getCoreEnv: () => env,
      onExtensionDisabled: (extensionId, notice) => {
        events.push(["disabled", extensionId]);
        controller.clearExtensionSections(extensionId, notice);
      },
      onExtensionEnabled: (extensionId) => {
        events.push(["enabled", extensionId]);
        controller.clearExtensionSections(extensionId);
      },
    });
    controller = new TurnContextController({
      agentId: "agent",
      getConfig: () => ({ model: "m", modelStyle: "openai" }),
      getCoreEnv: () => env,
      getSessionId: () => "s",
      getModeState: () => fakeModeState(),
      getExtensionRunner: () => runner,
      getParentId: () => undefined,
      onPromptBefore: () => {},
      invalidateRunner: () => {},
    });

    await runner.loadExtension({
      id: "turn",
      name: "Turn Ext",
      activate(ctx) {
        ctx.registerContextProvider({ content: () => "turn live", disabledContent: () => "turn off" });
      },
    });

    const section = async () =>
      (await controller.getDynamicTurnContextSections()).find((s) => s.key === "ext:turn")?.content;

    await controller.collectExtensionPromptHooks("hi");
    assert.equal(await section(), "turn live", "prepared turn carries the live section");

    await runner.setEnabled("turn", false);
    assert.equal(await section(), "turn off", "mid-turn disable replaces the section with the notice");
    assert.deepEqual(events, [["disabled", "turn"]], "disable notifies the host once");

    await runner.setEnabled("turn", true);
    assert.equal(await section(), undefined, "mid-turn re-enable removes the disabled notice from this turn");
    assert.deepEqual(
      events,
      [
        ["disabled", "turn"],
        ["enabled", "turn"],
      ],
      "enable notifies the host once"
    );

    // A no-op enable is not a transition and must not notify again.
    await runner.setEnabled("turn", true);
    assert.equal(events.filter(([kind]) => kind === "enabled").length, 1, "already-enabled emits nothing");

    await controller.collectExtensionPromptHooks("next");
    assert.equal(await section(), "turn live", "the live section returns on the next prepared turn");
  } finally {
    clearCoreEnv();
  }
}

// 6. A teardown failure must not suppress the disable notification.
//
// Teardown revokes the lease first, so a throwing HOST callback (unregistering a tool) leaves the
// extension inert — but it used to skip the notice/notification and the state flip entirely, so the
// panel and the model both kept seeing an active extension.
{
  const notified = [];
  const runner = new ExtensionRunner({
    onUnregisterTool: () => {
      throw new Error("host callback failed");
    },
    onExtensionDisabled: (extensionId) => notified.push(extensionId),
  });
  await runner.loadExtension({
    id: "host-fault",
    name: "Host Fault",
    activate(ctx) {
      ctx.registerTool({
        name: "host-fault-tool",
        description: "x",
        inputSchema: { type: "object" },
        execute: async () => ({}),
      });
    },
  });

  const result = await runner.setEnabled("host-fault", false);
  assert.equal(result.ok, false, "the failure is reported to the caller");
  assert.match(result.message, /with errors/, "the message says the disable was partial");
  assert.deepEqual(notified, ["host-fault"], "the disabled notification still fires");
  assert.equal(runner.getExtensionInfos()[0].state, "inactive", "the panel sees the disabled state");
  const collected = await runner.collectBeforeAgentStart("x", "id");
  assert.match(collected.turnContextSections?.[0]?.content ?? "", /is disabled/, "the model is told");
}

// 8. Re-enable retracts the notice for an extension with NO base section.
//
// `memory` / `jobs` only register named sections (or no provider at all), so a re-enable produces
// no block that could supersede the old `ext:<id>` disabled notice. Without an explicit retraction
// the model kept reading "this extension is disabled" for the rest of the session.
{
  const runner = new ExtensionRunner({});
  await runner.loadExtension({
    id: "named-only",
    name: "Named Only",
    version: "1.0.0",
    description: "only named sections",
    activate(ctx) {
      ctx.registerContextProvider({
        sections: [{ name: "selection", content: () => "selected memories" }],
        disabledContent: () => "Named Only is off",
      });
    },
  });
  await runner.setEnabled("named-only", false);
  const off = await runner.collectBeforeAgentStart("x", "id");
  assert.ok(
    off.turnContextSections?.some((section) => section.id === "ext:named-only"),
    "the disabled notice is announced under the base kind"
  );

  await runner.setEnabled("named-only", true);
  const on = await runner.collectBeforeAgentStart("x", "id");
  const base = on.turnContextSections?.find((section) => section.id === "ext:named-only");
  assert.match(base?.content ?? "", /enabled again/, "re-enable retracts the disabled notice");
  const named = on.turnContextSections?.find((section) => section.id === "ext:named-only:selection");
  assert.equal(named?.content, "selected memories", "the real named section wins over its notice");
}

console.log("extension-disable-notice validation passed");
