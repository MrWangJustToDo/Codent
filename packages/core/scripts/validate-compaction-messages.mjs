/**
 * Validates compaction helpers against TanStack ModelMessage shape.
 *
 * Run: pnpm --filter @codent/core run validate:compaction-messages
 */
/* eslint-disable no-undef */
import assert from "node:assert/strict";

import {
  applyToolCompact,
  estimateTokens,
  extractFileOpsFromMessages,
  formatFileOperations,
  serializeConversation,
  ToolCompactCache,
} from "../dist/dev.mjs";

const messages = [
  {
    role: "user",
    content: "Read src/index.ts and create src/new.ts",
  },
  {
    role: "assistant",
    content: "I'll read the file first.",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "src/index.ts" }) },
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-1",
    content: "x".repeat(500),
  },
  {
    role: "assistant",
    content: "Now I'll write the new file.",
    toolCalls: [
      {
        id: "call-2",
        type: "function",
        function: { name: "write_file", arguments: JSON.stringify({ path: "src/new.ts", content: "export {}" }) },
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-2",
    content: "x".repeat(500),
  },
  {
    role: "assistant",
    content: "Done.",
    toolCalls: [
      {
        id: "call-3",
        type: "function",
        function: { name: "grep", arguments: JSON.stringify({ pattern: "export" }) },
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-3",
    content: "x".repeat(500),
  },
];

const ops = extractFileOpsFromMessages(messages);
assert.ok(ops.readFiles.has("src/index.ts"));
assert.ok(ops.modifiedFiles.has("src/new.ts"));
assert.match(formatFileOperations(ops), /src\/index\.ts/);

const serialized = serializeConversation(messages);
assert.match(serialized, /\[Assistant tool calls\]: read_file/);
assert.match(serialized, /\[Tool result from read_file\]/);

const beforeTokens = estimateTokens(messages);
assert.ok(beforeTokens > 100);

const compacted = structuredClone(messages);
const cache = new ToolCompactCache();
await applyToolCompact(compacted, {
  config: {},
  registry: { get: () => undefined },
  cache,
});

// Without a toModelOutput registry, tool results stay as raw content.
const firstTool = compacted.find((m) => m.role === "tool" && m.toolCallId === "call-1");
assert.ok(firstTool);
assert.equal(String(firstTool.content), "x".repeat(500));

const lastTool = compacted.find((m) => m.role === "tool" && m.toolCallId === "call-3");
assert.ok(lastTool);
assert.equal(lastTool.content, "x".repeat(500));

// Wide characters are ~1 token each, not 1/4: without the correction a CJK session kept ~4×
// the `keepRecentTokens` budget and the cut could land past the trigger it was meant to respect.
{
  const ascii = estimateTokens([{ role: "user", content: "a".repeat(400) }]);
  const cjk = estimateTokens([{ role: "user", content: "中".repeat(400) }]);
  assert.ok(cjk >= 400, `400 CJK chars must estimate at least 400 tokens (got ${cjk})`);
  assert.ok(ascii < 150, `400 ASCII chars must stay near chars/4 (got ${ascii})`);
}

console.log("compaction-messages validation passed");
