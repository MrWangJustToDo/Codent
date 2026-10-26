/**
 * Validation for extension per-extension turn-context injection
 * (`registerContextProvider` + `collectBeforeAgentStart`).
 *
 * Run: pnpm --filter @codent/core run validate:extension-prompt-hooks
 */

import assert from "node:assert/strict";

import { ExtensionRunner } from "../dist/dev.mjs";

const runner = new ExtensionRunner({ getEnvVar: () => undefined });

await runner.loadExtension({
  id: "ext-a",
  name: "A",
  version: "1.0.0",
  description: "first",
  activate(ctx) {
    ctx.registerContextProvider({ content: () => "provider-A" });
  },
});

await runner.loadExtension({
  id: "ext-b",
  name: "B",
  version: "1.0.0",
  description: "second",
  activate(ctx) {
    ctx.registerContextProvider({ content: () => undefined });
  },
});

const collected = await runner.collectBeforeAgentStart("hello world", "agent-1");
// Only non-empty content surfaces; each extension is its own section keyed by id.
assert.deepEqual(collected.turnContextSections, [{ id: "ext:ext-a", content: "provider-A" }]);

// Disabling ext-a keeps its tag but swaps in the disabled notice.
await runner.setEnabled("ext-a", false);
const afterDisable = await runner.collectBeforeAgentStart("x", "id");
assert.deepEqual(afterDisable.turnContextSections, [
  { id: "ext:ext-a", content: 'Extension "A" is disabled — its tools and commands are unavailable.' },
]);

const emptyRunner = new ExtensionRunner({ getEnvVar: () => undefined });
const empty = await emptyRunner.collectBeforeAgentStart("x", "id");
assert.deepEqual(empty.turnContextSections, []);

console.log("extension-prompt-hooks validation passed");
