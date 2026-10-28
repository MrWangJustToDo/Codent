/**
 * Validates tool-compact middleware helpers (toModelOutput path only).
 *
 * Run: pnpm --filter @codent/core run validate:tool-compact
 */
/* eslint-disable no-undef */
import assert from "node:assert/strict";

import {
  applyToolCompact,
  createReadFileTool,
  createRunCommandTool,
  createToolCompactMiddleware,
  createWriteFileTool,
  getToolMetadata,
  ToolCompactCache,
  toolCompactCacheKey,
} from "../dist/dev.mjs";

const cache = new ToolCompactCache();

const tools = {
  read_file: createReadFileTool(),
  run_command: createRunCommandTool(),
  write_file: createWriteFileTool(),
};
const registry = {
  get: (name) => getToolMetadata(tools[name])?.toModelOutput,
};

const messages = [
  {
    role: "assistant",
    content: "read",
    toolCalls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
      },
      {
        id: "call-3",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: "c.ts" }) },
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-1",
    content: JSON.stringify({
      type: "text",
      path: "a.ts",
      content: "alpha",
      totalLines: 1,
      startLine: 1,
      endLine: 1,
      truncated: false,
    }),
  },
  {
    role: "tool",
    toolCallId: "call-3",
    content: JSON.stringify({
      type: "text",
      path: "c.ts",
      content: "gamma",
      totalLines: 1,
      startLine: 1,
      endLine: 1,
      truncated: false,
    }),
  },
];

const cloned = structuredClone(messages);
const inputBefore = JSON.stringify(cloned);

// `applyToolCompact` is pure: it returns replacements and never edits its input.
const compacted = await applyToolCompact(cloned, {
  config: {},
  registry,
  cache,
});
assert.notEqual(compacted, cloned, "a transformed wire must be a new array");
assert.equal(
  JSON.stringify(cloned),
  inputBefore,
  "the input array must be byte-identical after the call — it may be the cached projection"
);

const oldest = compacted.find((m) => m.role === "tool" && m.toolCallId === "call-1");
assert.ok(oldest);
assert.match(String(oldest.content), /alpha/);

const newest = compacted.find((m) => m.role === "tool" && m.toolCallId === "call-3");
assert.ok(newest);
assert.match(String(newest.content), /gamma/);
assert.equal(
  cache.has(toolCompactCacheKey("call-3", 2, messages[2].content)),
  true,
  "the cache key carries position + content, not the bare provider id"
);

const replay = structuredClone(messages);
const replayed = await applyToolCompact(replay, {
  config: {},
  registry,
  cache,
});

const replayNewest = replayed.find((m) => m.role === "tool" && m.toolCallId === "call-3");
assert.ok(replayNewest);
assert.equal(replayNewest.content, newest.content);

// ---------------------------------------------------------------------------
// Provider tool ids are scoped to a REQUEST, so the SAME id later in a session
// must project the new result — not the one cached under that id earlier.
// ---------------------------------------------------------------------------
{
  const reuseCache = new ToolCompactCache();
  const wire = (id, content) => [
    {
      role: "assistant",
      content: null,
      toolCalls: [
        { id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) } },
      ],
    },
    {
      role: "tool",
      toolCallId: id,
      content: JSON.stringify({
        type: "text",
        path: "a.ts",
        content,
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        truncated: false,
      }),
    },
  ];
  const toolText = (out) => String(out.find((m) => m.role === "tool").content);

  const firstCall = await applyToolCompact(wire("call_0", "first-result"), {
    config: {},
    registry,
    cache: reuseCache,
  });
  assert.match(toolText(firstCall), /first-result/);

  const secondCall = await applyToolCompact(wire("call_0", "second-result"), {
    config: {},
    registry,
    cache: reuseCache,
  });
  assert.match(toolText(secondCall), /second-result/, "a reused provider id projects its own result");
  assert.doesNotMatch(toolText(secondCall), /first-result/, "instead of serving the earlier request's content");

  // A transformed (e.g. redacted) result is already model-facing: the cache must not revert it.
  const transformed = wire("call_0", "unused");
  transformed[1].content = "[redacted by transformer]";
  const transformedOut = await applyToolCompact(transformed, {
    config: {},
    registry,
    cache: reuseCache,
  });
  assert.equal(
    toolText(transformedOut),
    "[redacted by transformer]",
    "an edited result misses the cache instead of being overwritten with the stale projection"
  );
}

// ---------------------------------------------------------------------------
// The projection cache is bounded: eviction costs a re-projection, never an error.
// ---------------------------------------------------------------------------
{
  const bounded = new ToolCompactCache(2);
  bounded.set("a", { source: "a", projected: "1" });
  bounded.set("b", { source: "b", projected: "2" });
  bounded.set("c", { source: "c", projected: "3" });
  assert.equal(bounded.has("a"), false, "the oldest projection is evicted at the cap");
  assert.equal(bounded.has("c"), true, "the newest stays");
}

const pendingApproval = [
  {
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: "call-cmd",
        type: "function",
        function: { name: "run_command", arguments: JSON.stringify({ command: "pnpm lint" }) },
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-cmd",
    content: JSON.stringify({
      approved: true,
      pendingExecution: true,
      message: "User approved this action",
    }),
  },
];

const pendingClone = structuredClone(pendingApproval);
const pendingOut = await applyToolCompact(pendingClone, {
  config: {},
  registry,
  cache: new ToolCompactCache(),
});

const pendingTool = pendingOut.find((m) => m.role === "tool" && m.toolCallId === "call-cmd");
assert.ok(pendingTool);
assert.match(String(pendingTool.content), /pendingExecution/);

const errorMessages = [
  {
    role: "assistant",
    content: null,
    toolCalls: [
      {
        id: "call-err",
        type: "function",
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: "packages/app/src/WorkspacePanel.tsx", content: "x" }),
        },
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call-err",
    content: JSON.stringify({
      error:
        "File already exists: packages/app/src/WorkspacePanel.tsx. Use edit_file for surgical edits, or pass overwrite: true.",
    }),
  },
];

const errorClone = structuredClone(errorMessages);
const errorOut = await applyToolCompact(errorClone, {
  config: {},
  registry,
  cache: new ToolCompactCache(),
});

const errorTool = errorOut.find((m) => m.role === "tool" && m.toolCallId === "call-err");
assert.ok(errorTool);
const errorText =
  typeof errorTool.content === "string"
    ? errorTool.content
    : Array.isArray(errorTool.content)
      ? errorTool.content.map((part) => part.content ?? "").join("")
      : String(errorTool.content);
assert.match(errorText, /Error: File already exists/);
assert.doesNotMatch(errorText, /Overwrote file: undefined/);

// ---------------------------------------------------------------------------
// A CHILD run projects too (the middleware is not root-only)
// ---------------------------------------------------------------------------
//
// The middleware used to return the wire untouched when `parentId` was set. `toModelOutput` is the
// only projection point (the `config` option is unused), so an explore subagent's `read_file` of an
// image put the base64 JSON into its context instead of an image part — and `run_command`'s
// cancellation text / `grep`'s dedupe were lost the same way.
{
  const imageOutput = { type: "image", path: "shot.png", base64: "AAAA", size: 4, mimeType: "image/png" };
  const imageWire = () => [
    {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call-img",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "shot.png" }) },
        },
      ],
    },
    { role: "tool", toolCallId: "call-img", content: JSON.stringify(imageOutput) },
  ];

  const middlewareFor = (parentId) =>
    createToolCompactMiddleware({
      getCompactionConfig: () => null,
      getToolCompactCache: () => new ToolCompactCache(),
      getManagedAgent: () => ({
        parentId,
        getToolModelOutput: (name) => getToolMetadata(tools[name])?.toModelOutput,
      }),
    });

  for (const [label, parentId] of [
    ["root", undefined],
    ["child", "parent-1"],
  ]) {
    const wire = imageWire();
    const before = JSON.stringify(wire);
    const middleware = middlewareFor(parentId);
    assert.equal(typeof middleware.onConfig, "function", `${label}: tool-compact runs onConfig`);

    const out = await middleware.onConfig({}, { messages: wire });
    const projected = out.messages.find((m) => m.role === "tool" && m.toolCallId === "call-img");
    assert.ok(projected, `${label}: the tool result survives`);
    assert.ok(Array.isArray(projected.content), `${label}: projected to content parts, not raw JSON text`);
    assert.ok(
      projected.content.some((part) => part.type === "image"),
      `${label}: media is an image part the provider can use`
    );
    assert.match(
      String(projected.content[0]?.content),
      /Image read: shot\.png/,
      `${label}: the text line describes it`
    );
    assert.equal(JSON.stringify(wire), before, `${label}: the input wire is not mutated`);
  }
}

// ---------------------------------------------------------------------------
// The fingerprint is only a candidate filter: an exact-source mismatch must
// re-project rather than serve the stale content (same id, index, length and
// sampled windows — a real same-length file edit).
// ---------------------------------------------------------------------------
{
  const collisionCache = new ToolCompactCache();
  const a = "A".repeat(120);
  const content1 = `${a}M${a}`;
  const content2 = `${"A".repeat(60)}B${"A".repeat(59)}M${a}`;
  const raw = (content) =>
    JSON.stringify({
      type: "text",
      path: "a.ts",
      content,
      totalLines: 1,
      startLine: 1,
      endLine: 1,
      truncated: false,
    });
  const raw1 = raw(content1);
  const raw2 = raw(content2);
  assert.equal(raw1.length, raw2.length, "the fixtures are the same length");
  assert.equal(
    toolCompactCacheKey("call_0", 1, raw1),
    toolCompactCacheKey("call_0", 1, raw2),
    "and collide on the cheap fingerprint — which is exactly why the entry compares its source"
  );

  const wire = (content) => [
    {
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call_0",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) },
        },
      ],
    },
    { role: "tool", toolCallId: "call_0", content: raw(content) },
  ];

  await applyToolCompact(wire(content1), { config: {}, registry, cache: collisionCache });
  const edited = await applyToolCompact(wire(content2), { config: {}, registry, cache: collisionCache });
  assert.match(
    String(edited.find((m) => m.role === "tool").content),
    /B/,
    "a near-miss re-projects the new result instead of returning the cached one"
  );
}

console.log("tool-compact validation passed");
