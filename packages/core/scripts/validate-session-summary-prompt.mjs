/**
 * Validates the session title / PR-style summary system prompts.
 *
 * Guards the prompt-quality upgrade: both prompts must instruct the model to
 * respond in the same language as the conversation (so Chinese conversations
 * don't get English titles/summaries), and the PR summary prompt must keep its
 * section structure.
 *
 * Run: pnpm --filter @codent/core run validate:session-summary-prompt
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PR_SUMMARY_SYSTEM_PROMPT, TITLE_SYSTEM_PROMPT } from "../dist/dev.mjs";

{
  const languageRule = /same language as the conversation/;
  assert.match(TITLE_SYSTEM_PROMPT, languageRule);
  assert.match(PR_SUMMARY_SYSTEM_PROMPT, languageRule);

  // Title prompt shape.
  assert.match(TITLE_SYSTEM_PROMPT, /3-8 words/);
  assert.match(TITLE_SYSTEM_PROMPT, /Return ONLY the title/);

  // PR summary prompt keeps its section structure.
  assert.match(PR_SUMMARY_SYSTEM_PROMPT, /## Overview/);
  assert.match(PR_SUMMARY_SYSTEM_PROMPT, /## Changes/);
  assert.match(PR_SUMMARY_SYSTEM_PROMPT, /## Key files/);
  assert.match(PR_SUMMARY_SYSTEM_PROMPT, /## Commits/);
}

// The automatic title path (the one that actually runs after the first message) must consume the
// same prompt. It used to inline a second copy without the language rule, and this script only
// ever asserted the copy that path did not use.
{
  const sourceFiles = [
    "../src/managers/services/session-service.ts",
    "../src/agent-session/session-lifecycle-commands.ts",
  ];
  for (const relative of sourceFiles) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /TITLE_SYSTEM_PROMPT/, `${relative} uses the shared title prompt`);
    assert.doesNotMatch(source, /Generate a concise title/, `${relative} has no second title prompt`);
  }
}

console.log("session-summary-prompt validation passed");
