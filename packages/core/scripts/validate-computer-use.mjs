/**
 * Computer use: the extension is provider-agnostic (tool call + vision) and its boundary is
 * `CoreEnv.computer`, so the whole contract is testable with a fake driver — no display, no native
 * addon, which is exactly why this runs in CI where `@codent/node` can only degrade.
 *
 * What is asserted, and why each one is worth a guard:
 * - **Read and write are two tools.** `needsApproval` is a static boolean in the SDK and in core's
 *   approval registry, so a single mixed tool could only be all-free or all-prompted. If someone
 *   merges them back, "looking is free, acting asks" silently becomes "everything asks" (or worse,
 *   "everything is free") — the one property of this extension a user cannot see until it is too
 *   late.
 * - **The action tool is `edits`.** That is what makes plan mode withhold it; a display-only change
 *   to the category is a capability boundary (`validate:plan-tool-boundary` says so too).
 * - **`toModelOutput` is idempotent.** A re-projection handed its own content part array must pass
 *   it through; reading fields off it would put `undefined` on the wire.
 * - **Screenshot history is capped** on both content encodings (array and TanStack's JSON string),
 *   and stripped entirely for a model without vision.
 *
 * Run: pnpm --filter @codent/core run validate:computer-use
 */

import assert from "node:assert/strict";

import {
  COMPUTER_ACTIONS,
  COMPUTER_ACTION_TOOL,
  COMPUTER_SCREENSHOT_TOOL,
  SCREENSHOT_MARKER,
  capScreenshotHistory,
  createComputerUseExtension,
} from "../dist/dev.mjs";

// ============================================================================
// Fakes
// ============================================================================

/** A screen the size of a laptop, in the model's coordinate space. */
const DISPLAY = { width: 1280, height: 800 };
/** Opaque bytes: the extension never decodes them, it only encodes and hands them on. */
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function fakeComputer(overrides = {}) {
  const calls = [];
  const computer = {
    display: DISPLAY,
    environment: "linux",
    capabilities: { zoom: true, cursorPosition: true },
    screenshot: async () => {
      calls.push(["screenshot"]);
      return PNG_BYTES;
    },
    zoom: async (region) => {
      calls.push(["zoom", region]);
      return PNG_BYTES;
    },
    cursorPosition: async () => ({ x: 10, y: 20 }),
    click: async (x, y, options) => calls.push(["click", x, y, options?.button, options?.count]),
    move: async (x, y) => calls.push(["move", x, y]),
    mouseDown: async (button) => calls.push(["mouseDown", button]),
    mouseUp: async (button) => calls.push(["mouseUp", button]),
    scroll: async (x, y, deltaX, deltaY) => calls.push(["scroll", x, y, deltaX, deltaY]),
    keyDown: async (key) => calls.push(["keyDown", key]),
    keyUp: async (key) => calls.push(["keyUp", key]),
    press: async (keys) => calls.push(["press", keys]),
    type: async (text) => calls.push(["type", text]),
    ...overrides,
  };
  return { computer, calls };
}

/** The narrow slice of `ExtensionContext` the extension touches. */
function activate(computer, config) {
  const tools = new Map();
  let transformer;
  const ctx = {
    coreEnv: {
      rootPath: "/tmp",
      base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
      async resizeImage() {
        return null; // no codec: exercise the PNG fallback path
      },
    },
    registerTool: (definition) => {
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
    registerMessageTransformer: (fn) => {
      transformer = fn;
      return () => {};
    },
  };
  const api = createComputerUseExtension(computer, config);
  api.activate(ctx);
  return { api, tools, transformer: () => transformer };
}

const OPTS = { toolCallId: "call_1", abortSignal: undefined };

// ============================================================================
// Registration: identity, read/write split, plan-mode boundary
// ============================================================================

{
  const { computer } = fakeComputer();
  const { api, tools } = activate(computer, { settleMs: 0 });

  assert.equal(api.id, "codent-computer-use");
  assert.equal(api.order, -100, "a built-in declares BUILTIN_EXTENSION_ORDER");
  assert.deepEqual([...tools.keys()].sort(), [COMPUTER_ACTION_TOOL, COMPUTER_SCREENSHOT_TOOL].sort());

  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);
  const write = tools.get(COMPUTER_ACTION_TOOL);

  assert.equal(read.needsApproval, undefined, "looking at the screen must not require approval");
  assert.equal(write.needsApproval, true, "acting on the screen must require approval");
  assert.equal(read.present.category, "reads");
  assert.equal(write.present.category, "edits", "`edits` is what withholds the write tool in plan mode");
  assert.equal(read.present.keepRow, true, "a screenshot row carries its whole result");
  assert.ok(read.description.includes(`${DISPLAY.width}x${DISPLAY.height}`), "the model is told the space");
  assert.ok(write.description.includes(`${DISPLAY.width}x${DISPLAY.height}`));

  // The action schema is the model-facing contract; a dropped action is a capability loss.
  for (const action of COMPUTER_ACTIONS) {
    assert.equal(write.inputSchema.safeParse({ action }).success, true, `the schema accepts "${action}"`);
  }
  assert.equal(write.inputSchema.safeParse({ action: "teleport" }).success, false);
}

// ============================================================================
// Screenshot tool: output shape, model projection, idempotency
// ============================================================================

{
  const { computer, calls } = fakeComputer();
  const { tools } = activate(computer, { settleMs: 0 });
  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);

  const output = await read.execute({}, OPTS);
  assert.deepEqual(calls, [["screenshot"]]);
  assert.equal(output.base64, Buffer.from(PNG_BYTES).toString("base64"));
  assert.equal(output.mimeType, "image/png", "no resizeImage ⇒ the raw PNG is sent as-is");
  assert.equal(output.summary, "screen 1280x800 · pointer 10,20");
  assert.deepEqual(output.display, DISPLAY);
  assert.equal(read.present.text(output), output.summary);

  const parts = read.toModelOutput({ output });
  assert.ok(Array.isArray(parts), "the projection is content parts");
  assert.ok(parts[0].content.startsWith(SCREENSHOT_MARKER), "the text part is marker-prefixed");
  assert.ok(parts[0].content.includes("1280x800"), "every result restates the coordinate space");
  assert.equal(parts[1].type, "image");
  assert.equal(parts[1].source.value, output.base64);

  // A re-projection is handed its own output (compaction, remote hosts, restart) — pass it through.
  assert.equal(read.toModelOutput({ output: parts }), parts);

  // A failed capture is a failed call, not an empty screen.
  const { computer: blind } = fakeComputer({ screenshot: async () => null });
  const blindTools = activate(blind, { settleMs: 0 }).tools;
  await assert.rejects(() => blindTools.get(COMPUTER_SCREENSHOT_TOOL).execute({}, OPTS), /could not be captured/);

  // Zoom goes through the host's region capture and reports the region, not the screen.
  const zoomed = await read.execute({ zoom: { x: 0, y: 0, width: 320, height: 200 } }, OPTS);
  assert.deepEqual(calls.at(-1), ["zoom", { x: 0, y: 0, width: 320, height: 200 }]);
  assert.equal(zoomed.summary, "screen region 320x200 · pointer 10,20");
  assert.deepEqual(zoomed.region, { x: 0, y: 0, width: 320, height: 200 }, "the region travels with the result");

  // A zoom image is NOT a coordinate frame: pixels come back at full resolution, so a model that
  // reused the image's own pixels would click somewhere else entirely. The text has to say so.
  const zoomParts = read.toModelOutput({ output: zoomed });
  assert.ok(zoomParts[0].content.includes("MAGNIFIED"), "a zoom result is labelled as magnified");
  assert.ok(zoomParts[0].content.includes("(0,0)-(320,200)"), "…and names the region in screen space");
  assert.ok(zoomParts[0].content.includes("keep sending screen coordinates"), "…and restates the rule");
  assert.ok(read.toModelOutput({ output: output })[0].content.includes("pixels in THIS image"));
}

// ============================================================================
// Action tool: dispatch, validation, abort
// ============================================================================

{
  const { computer, calls } = fakeComputer();
  const { tools } = activate(computer, { settleMs: 0 });
  const write = tools.get(COMPUTER_ACTION_TOOL);

  const clicked = await write.execute({ action: "click", x: 10, y: 20 }, OPTS);
  assert.deepEqual(calls[0], ["click", 10, 20, "left", 1]);
  assert.equal(clicked.summary, "click 10,20 left — screen 1280x800 · pointer 10,20");
  assert.ok(clicked.base64, "every action returns a fresh screenshot");

  await write.execute({ action: "double_click", x: 5, y: 6, button: "right" }, OPTS);
  assert.deepEqual(calls.at(-2), ["click", 5, 6, "right", 2]);

  // Modifiers turn three calls (down / action / up) into one — and they are released after it.
  calls.length = 0;
  const modified = await write.execute({ action: "click", x: 7, y: 8, modifiers: ["Control", "Shift"] }, OPTS);
  assert.deepEqual(calls.slice(0, 4), [
    ["keyDown", "Control"],
    ["keyDown", "Shift"],
    ["click", 7, 8, "left", 1],
    ["keyUp", "Shift"],
  ]);
  assert.equal(calls.filter(([name]) => name !== "screenshot").at(-1)[0], "keyUp", "the gesture ends with the release");
  // BOTH keys, not just the last one: a predicate that only looks at the final `keyUp` passes while
  // Control stays held — and a stuck Control silently rewrites every keystroke after it.
  assert.deepEqual(
    calls.filter(([name]) => name === "keyUp").map(([, key]) => key),
    ["Shift", "Control"],
    "every held modifier is released, in reverse order"
  );
  assert.ok(modified.summary.startsWith("Control+Shift+click 7,8"), modified.summary);

  // A failing gesture must not leave a modifier held down.
  {
    const { computer: failing, calls: failingCalls } = fakeComputer({
      move: async () => {
        throw new Error("move failed");
      },
    });
    const failingTools = activate(failing, { settleMs: 0 }).tools;
    await assert.rejects(
      () => failingTools.get(COMPUTER_ACTION_TOOL).execute({ action: "move", x: 1, y: 1, modifiers: ["Alt"] }, OPTS),
      /move failed/
    );
    assert.deepEqual(failingCalls, [
      ["keyDown", "Alt"],
      ["keyUp", "Alt"],
    ]);
  }

  calls.length = 0;
  await write.execute({ action: "drag", x: 1, y: 2, to_x: 30, to_y: 40 }, OPTS);
  assert.deepEqual(calls.slice(0, 4), [
    ["move", 1, 2],
    ["mouseDown", "left"],
    ["move", 30, 40],
    ["mouseUp", "left"],
  ]);

  // `steps` interpolates, so a drop target actually sees movement (native DnD ignores a jump).
  calls.length = 0;
  await write.execute({ action: "drag", x: 0, y: 0, to_x: 30, to_y: 0, steps: 3 }, OPTS);
  assert.deepEqual(
    calls.filter(([name]) => name === "move").map(([, x, y]) => [x, y]),
    [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
    ]
  );
  assert.deepEqual(
    calls.filter(([name]) => name !== "screenshot").at(-1),
    ["mouseUp", "left"],
    "the button is released after the path"
  );

  calls.length = 0;
  await write.execute({ action: "type", text: "hello" }, OPTS);
  assert.deepEqual(calls[0], ["type", "hello"]);

  calls.length = 0;
  await write.execute({ action: "key", keys: ["Control", "c"] }, OPTS);
  assert.deepEqual(calls[0], ["press", ["Control", "c"]]);

  calls.length = 0;
  await write.execute({ action: "scroll", x: 100, y: 100, delta_y: 200 }, OPTS);
  assert.deepEqual(calls[0], ["scroll", 100, 100, 0, 200]);

  // mouse_down takes an optional point: "move there, then press" (a hand-built drag).
  calls.length = 0;
  await write.execute({ action: "mouse_down", x: 4, y: 5 }, OPTS);
  assert.deepEqual(calls.slice(0, 2), [
    ["move", 4, 5],
    ["mouseDown", "left"],
  ]);

  // Validation is the model's error message, so it has to name the missing argument.
  await assert.rejects(() => write.execute({ action: "click" }, OPTS), /needs x and y/);
  await assert.rejects(() => write.execute({ action: "drag", x: 1, y: 2 }, OPTS), /needs to_x and to_y/);
  await assert.rejects(() => write.execute({ action: "type", text: "" }, OPTS), /needs text/);
  await assert.rejects(() => write.execute({ action: "key" }, OPTS), /needs keys/);
  await assert.rejects(() => write.execute({}, OPTS), /needs `action`/);

  // A cancelled run must not sit out a wait.
  const aborted = AbortSignal.abort(new Error("cancelled by the user"));
  await assert.rejects(
    () => write.execute({ action: "wait", ms: 5_000 }, { ...OPTS, abortSignal: aborted }),
    /cancelled/
  );
}

// ============================================================================
// Batched actions
// ============================================================================

{
  const { computer, calls } = fakeComputer();
  const { tools } = activate(computer, { settleMs: 0 });
  const write = tools.get(COMPUTER_ACTION_TOOL);

  const output = await write.execute(
    {
      actions: [
        { action: "type", text: "search" },
        { action: "key", keys: ["Enter"] },
        { action: "wait", ms: 1 },
      ],
    },
    OPTS
  );

  assert.deepEqual(
    calls.filter(([name]) => name !== "screenshot"),
    [
      ["type", "search"],
      ["press", ["Enter"]],
    ],
    "the batch runs in order"
  );
  assert.equal(
    calls.filter(([name]) => name === "screenshot").length,
    1,
    "a batch costs ONE screenshot — that is the whole point"
  );
  assert.equal(output.summary, 'type "search" → press Enter → wait 1ms — screen 1280x800 · pointer 10,20');

  // A shared modifier applies to every entry that does not override it.
  calls.length = 0;
  await write.execute(
    {
      modifiers: ["Shift"],
      actions: [
        { action: "click", x: 1, y: 1 },
        { action: "click", x: 2, y: 2 },
      ],
    },
    OPTS
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "keyDown").map(([, key]) => key),
    ["Shift", "Shift"]
  );

  // The schema refuses an empty batch, and accepts a one-entry one.
  assert.equal(write.inputSchema.safeParse({ actions: [] }).success, false);
  assert.equal(write.inputSchema.safeParse({ actions: [{ action: "click", x: 1, y: 1 }] }).success, true);
}

// ============================================================================
// Screenshot budget
// ============================================================================

/** One of our tool messages: marker text plus an image. */
function screenshotMessage(index, asString = false) {
  const parts = [
    { type: "text", content: `${SCREENSHOT_MARKER} screen 1280x800 #${index}` },
    { type: "image", source: { type: "data", value: `payload-${index}`, mimeType: "image/png" } },
  ];
  return {
    role: "tool",
    toolCallId: `call_${index}`,
    content: asString ? JSON.stringify(parts) : parts,
  };
}

function hasImage(message) {
  const parts = typeof message.content === "string" ? JSON.parse(message.content) : message.content;
  return parts.some((part) => part.type === "image");
}

{
  const messages = [
    { role: "user", content: "open the settings window" },
    screenshotMessage(1),
    screenshotMessage(2, true), // stringified, as Chat Completions receives it
    { role: "tool", toolCallId: "read", content: [{ type: "text", content: "not ours" }] },
    screenshotMessage(3),
    screenshotMessage(4),
  ];

  const capped = capScreenshotHistory(messages, 2, true);
  assert.equal(capped[0], messages[0], "non-tool messages are untouched");
  assert.equal(hasImage(capped[1]), false, "screenshot 1 is older than the budget ⇒ blinded");
  assert.equal(hasImage(capped[2]), false, "screenshot 2 is older than the budget ⇒ blinded");
  assert.equal(hasImage(capped[3]), false, "a tool message that is not ours is never rewritten");
  assert.equal(hasImage(capped[4]), true, "screenshot 3 is within the budget");
  assert.equal(hasImage(capped[5]), true, "screenshot 4 is within the budget");
  assert.equal(capped[3], messages[3], "…and it keeps its identity");

  // The elided row keeps its text (the transcript must still make sense) and says what happened.
  const elided = typeof capped[1].content === "string" ? JSON.parse(capped[1].content) : capped[1].content;
  assert.ok(elided[0].content.includes("#1"), "the original text line survives");
  assert.ok(
    elided.some((part) => part.content === `${SCREENSHOT_MARKER} (earlier screenshot removed to save context)`)
  );

  // Encoding is preserved: string content stays a string (Chat Completions accepts nothing else).
  assert.equal(typeof capped[2].content, "string");
  assert.equal(typeof capped[1].content, "object");

  // Nothing to do ⇒ the very same array (no cache invalidation for a run with no screenshots).
  const fewEnough = [screenshotMessage(1), screenshotMessage(2)];
  assert.equal(capScreenshotHistory(fewEnough, 3, true), fewEnough);

  // The cap only matters if the extension WIRES it: calling the pure function proves the budget
  // arithmetic, not that the budget is applied. Without this, dropping `registerMessageTransformer`
  // (or swapping its arguments) leaves every other assertion here green.
  {
    const wired = activate(fakeComputer().computer, { screenshotHistory: 2, settleMs: 0 });
    const transformer = wired.transformer();
    assert.equal(typeof transformer, "function", "the extension registers a message transformer");
    const projected = transformer({ messages, modelHasVision: true });
    const survivors = projected.filter((message) => message.role === "tool" && hasImage(message));
    assert.equal(survivors.length, 2, "the registered transformer applies the configured budget");

    const blind = activate(fakeComputer().computer, { screenshotHistory: 2, settleMs: 0 }).transformer()({
      messages,
      modelHasVision: false,
    });
    assert.equal(
      blind.filter((message) => message.role === "tool" && hasImage(message)).length,
      0,
      "a model without vision sees no screenshots at all"
    );
  }

  const noVision = capScreenshotHistory(fewEnough, 3, false);
  assert.equal(
    noVision.every((message) => !hasImage(message)),
    true,
    "no vision ⇒ every image is dropped"
  );
}

console.log("validate:computer-use ok");
