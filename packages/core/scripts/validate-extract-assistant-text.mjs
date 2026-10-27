/**
 * Validates subagent summary extraction (`extractAssistantText`): only text after
 * `begin_summary`, the last text-only step, and the thinking fallback.
 *
 * Streaming gating is not tested here: it lives in `AgentUIChannel.appendSummaryDelta`
 * (`summaryPhaseUnlocked`) and is exercised by `validate:agent-ui-channel`.
 *
 * Run: pnpm --filter @codent/core run validate:extract-assistant-text
 */

import assert from "node:assert/strict";

import { BEGIN_SUMMARY_TOOL_NAME, extractAssistantText } from "../dist/dev.mjs";

const summaryText = "## Final Summary\n\nThis is the comprehensive project summary the parent should see.";

const messages = [
  {
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "text", content: "I'll start by exploring the project structure." },
      { type: "tool-call", id: "tc1", name: "read_file", arguments: "{}", state: "complete", output: "{}" },
      { type: "tool-result", toolCallId: "tc1", content: "hi", state: "complete" },
      {
        type: "tool-call",
        id: "tc-bs",
        name: BEGIN_SUMMARY_TOOL_NAME,
        arguments: "{}",
        state: "complete",
        output: "{}",
      },
      { type: "tool-result", toolCallId: "tc-bs", content: "{}", state: "complete" },
      { type: "text", content: summaryText },
    ],
  },
];

const summary = extractAssistantText(messages);
assert.ok(summary.includes("## Final Summary"));
assert.ok(!summary.includes("I'll start by exploring"));

const reasoningThenSummary = [
  {
    id: "assistant-2",
    role: "assistant",
    parts: [
      {
        type: "thinking",
        content: "我们被要求提供一个总结。我们需要提取目标、指令、发现等信息。",
      },
      {
        type: "text",
        content: "## Goal\n\nFix SubagentPanel issues.\n\n## Accomplished\n\n- Fixed ESC handling",
      },
    ],
  },
];

const summaryWithReasoning = extractAssistantText(reasoningThenSummary);
assert.ok(summaryWithReasoning.startsWith("## Goal"));
assert.ok(!summaryWithReasoning.includes("我们被要求"));

console.log("extract-assistant-text validation passed");
