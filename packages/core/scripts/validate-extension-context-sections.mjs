/**
 * Validates named per-extension context sections.
 *
 * One section per extension is what forced memory's index and its per-turn selection into one block:
 * any selection change re-injected the whole index. These assertions pin the split — independent
 * kinds, duplicate handling, per-section failure containment, and the disabled notice under the same
 * kinds — because a regression here is invisible in the transcript (the model just gets more tokens).
 *
 * Run: pnpm --filter @codent/core run validate:extension-context-sections
 */
import assert from "node:assert/strict";

import { ExtensionRunner, createAgentEventBus } from "../dist/dev.mjs";

const runtime = {
  sessionId: () => "ses",
  isIdle: () => true,
  mode: () => "normal",
  model: () => "m",
  signal: () => undefined,
  messages: () => [],
  contextUsage: () => undefined,
  systemPrompt: () => "",
  complete: async () => ({ text: "" }),
};

const bus = createAgentEventBus();
const failures = [];
bus.on("agent:extension-error", (event) => failures.push(event.payload));

const runner = new ExtensionRunner({ getEnvVar: () => undefined, eventBus: bus, getRuntime: () => runtime });

await runner.loadExtension({
  id: "sec",
  name: "Sections",
  version: "1.0.0",
  description: "sections probe",
  async activate(ctx) {
    ctx.registerContextProvider({
      content: () => "<memory_index>stable</memory_index>",
      disabledContent: () => "sections disabled",
      sections: [
        { name: "index", content: () => "INDEX-V1" },
        { name: "selection", content: () => "SELECTION-TURN-1", disabledContent: () => "SELECTION-OFF" },
        // Duplicate: the last registration wins (one kind cannot have two producers).
        { name: "selection", content: () => "SELECTION-TURN-2", disabledContent: () => "SELECTION-OFF" },
        {
          name: "boom",
          content: () => {
            throw new Error("section exploded");
          },
        },
      ],
    });
  },
});

const first = await runner.collectBeforeAgentStart("hello", "ses");
const ids = first.turnContextSections.map((section) => section.id);
const byId = (bundle, id) => bundle.turnContextSections.find((section) => section.id === id);

// ── 1. base section + named sections, each under its own kind ───────────────
assert.ok(ids.includes("sec"), "the extension's single-section content keeps its extension-id kind");
assert.ok(ids.includes("sec:index"), "a named section gets its own kind");
assert.ok(ids.includes("sec:selection"), "and so does a second one");
assert.equal(byId(first, "sec:selection").content, "SELECTION-TURN-2", "a duplicate name keeps the last producer");
assert.equal(ids.filter((id) => id === "sec:selection").length, 1, "one block per kind, never two");

// ── 2. a throwing producer is contained to its own section ─────────────────
assert.equal(byId(first, "sec:boom"), undefined, "the failing section is skipped");
assert.ok(byId(first, "sec:index"), "its siblings are still injected");
assert.ok(
  failures.some((event) => String(event.error ?? "").includes('section "boom": section exploded')),
  "the failure is reported with the extension id and the section name"
);

// ── 3. the sections are stable across turns (admission is per kind) ────────
const second = await runner.collectBeforeAgentStart("again", "ses");
assert.deepEqual(
  second.turnContextSections.map((section) => section.id),
  first.turnContextSections.map((section) => section.id),
  "the same kinds are produced every turn, so admission can hash them independently"
);

// ── 4. disabling replaces each kind with its own notice ────────────────────
const disabled = await runner.setEnabled("sec", false);
assert.equal(disabled.ok, true);
const afterDisable = await runner.collectBeforeAgentStart("third", "ses");
assert.equal(byId(afterDisable, "sec").content, "sections disabled", "the base section announces the disable");
assert.equal(byId(afterDisable, "sec:selection").content, "SELECTION-OFF", "and so does the named section");
assert.equal(byId(afterDisable, "sec:index"), undefined, "a section without a disabled notice is simply absent");

// ── 5. re-enabling restores the live content under the same kinds ─────────
await runner.setEnabled("sec", true);
const afterEnable = await runner.collectBeforeAgentStart("fourth", "ses");
assert.equal(byId(afterEnable, "sec:index").content, "INDEX-V1");
assert.equal(byId(afterEnable, "sec:selection").content, "SELECTION-TURN-2");

console.log("extension context sections validation passed");
