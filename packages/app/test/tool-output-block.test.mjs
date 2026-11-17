/**
 * Whether a tool call paints a result block.
 *
 * The reported symptom: an MCP tool call rendered its row, then an **empty** padded box — the
 * `▄▄▄` / `▀▀▀` band of `HalfLinePaddedBox` with nothing between the bars. Cause: MCP tools declare
 * `detailed: true` (so the block is not dropped) but deliberately no `text` renderer (their output
 * comes from a remote server, so there is no curated line to claim), and the renderer treated
 * `detailed` as "paint a block regardless of whether there is a body".
 *
 * A blank body is not a result, whatever the descriptor says.
 *
 * Run: node packages/app/test/tool-output-block.test.mjs
 */
import { computeToolDisplay } from "@codent/core";
import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

const { shouldRenderResultBlock } = await import(new URL("../dist/utils/tool-display.mjs", import.meta.url).href);

/** The MCP shape: descriptor keeps the block, no `text` renderer, nothing rendered. */
const MCP_DESCRIPTOR = { detailed: true, hasTextRenderer: false };

test("a detailed tool with no renderer paints nothing (the empty-band bug)", () => {
  assert.equal(shouldRenderResultBlock({ ...MCP_DESCRIPTOR, output: "" }), false);
});

test("whitespace is not a body", () => {
  assert.equal(shouldRenderResultBlock({ ...MCP_DESCRIPTOR, output: "   " }), false);
  assert.equal(shouldRenderResultBlock({ ...MCP_DESCRIPTOR, output: "\n\n" }), false);
});

test("a detailed tool still paints its block once it has a body", () => {
  assert.equal(shouldRenderResultBlock({ ...MCP_DESCRIPTOR, output: "Tab created" }), true);
});

test("an extension tool's curated line is its own reason to paint", () => {
  assert.equal(shouldRenderResultBlock({ detailed: false, hasTextRenderer: true, output: "3 matches" }), true);
});

test("no block, no renderer, no paint", () => {
  assert.equal(shouldRenderResultBlock({ detailed: false, hasTextRenderer: false, output: "3 matches" }), false);
  assert.equal(shouldRenderResultBlock({ detailed: false, hasTextRenderer: false, output: "" }), false);
});

test("core attaches no body for an MCP result, which is why the block must not paint", () => {
  // The input side of the same bug, asserted against the real formatter: an MCP descriptor keeps
  // the block but claims no `text` renderer, so `computeToolDisplay` returns no payload at all —
  // whatever the server sent (here the text content[] a browser server returns).
  const mcpPresentation = () => ({ category: "other", keepRow: true, detailed: true });
  const serverResult = [{ type: "text", content: "Tab created" }];

  assert.equal(
    computeToolDisplay("mcp__browsermcp__browser", serverResult, { commands: ["tab", "new"] }, mcpPresentation),
    undefined
  );
});
