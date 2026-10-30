/**
 * Validates the default system prompt behavior rules and length cap.
 *
 * Guards the prompt-quality upgrade: the default prompt must carry concrete,
 * actionable behavior rules (conciseness + language matching, conventions,
 * verification, commit discipline, code references, context efficiency,
 * proactiveness) and must not balloon past a sane length cap.
 *
 * Run: pnpm --filter @codent/core run validate:default-prompt
 */

import assert from "node:assert/strict";

import { buildDefaultSystemPrompt, registerCoreEnv } from "../dist/dev.mjs";

registerCoreEnv({
  rootPath: "/test/workspace",
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
});

{
  const prompt = await buildDefaultSystemPrompt("test-platform");

  // Core sections must be present.
  assert.match(prompt, /Environment Context/);
  assert.match(prompt, /Available Tools/);
  assert.match(prompt, /How to choose/);
  assert.match(prompt, /Guidelines/);

  // Behavior rules from the prompt-quality upgrade.
  assert.match(prompt, /Match the user's language/);
  assert.match(prompt, /file_path:line_number/);
  assert.match(prompt, /Verify before claiming done/);
  assert.match(prompt, /never commit changes unless the user explicitly asks/);
  assert.match(prompt, /Follow conventions/);
  assert.match(prompt, /Context efficiency/);
  assert.match(prompt, /Proactiveness/);
  // Parallel tool calls: the runtime executes a turn's tools concurrently, so the prompt has to
  // say so — a main agent that issues one call per turn pays a round trip for each.
  assert.match(prompt, /Parallel tool calls/);
  assert.match(prompt, /issue them together in one turn/);
}

{
  // Length cap guard — keeps the default prompt from ballooning over time.
  const prompt = await buildDefaultSystemPrompt("test-platform");
  assert.ok(prompt.length <= 6000, `default system prompt too long: ${prompt.length} chars (cap 6000)`);
}

console.log("default-prompt validation passed");
