/* eslint-disable max-lines -- one conformance suite for the computer-use contract (two-tool split, screenshot projection/zoom, action schema + dispatch, batch inheritance/preflight, screenshot budget). The sections share the fake driver and extension harness; splitting them would duplicate that fixture and make the cases order-dependent. */
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
function activate(computer, config, envOverrides = {}) {
  const tools = new Map();
  let transformer;
  /**
   * The `maxWidth` requested from the host's image codec, in call order.
   *
   * Recorded even though the fake returns `null` (no codec): the REQUESTED width is what decides
   * the image's density, and it is the one thing the extension controls.
   */
  const resizes = [];
  const ctx = {
    coreEnv: {
      rootPath: "/tmp",
      base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
      async resizeImage(_bytes, options = {}) {
        resizes.push(options.maxWidth);
        return null; // no codec: exercise the PNG fallback path
      },
      ...envOverrides,
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
  return { api, tools, transformer: () => transformer, resizes };
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

  // The description must not claim the attachment is unscaled: a provider may downscale it (a
  // measured session saw 1280x800 arrive as 1024x640), and every result states the conversion rule.
  // "Exactly the size of the screenshots you see" made the tool contradict its own result, and the
  // model alternated between the two coordinate spaces.
  for (const tool of [read, write]) {
    assert.equal(/exactly the size of the screenshots/.test(tool.description), false, "no unscaled-image claim");
    assert.ok(tool.description.includes("multiply what you measure by declared / seen"), "the scaling rule is stated");
    // The DIRECTION is the rule: a 1024-wide image of a 1280-wide screen needs ×1.25 (declared /
    // seen). The inverse (seen / declared, 0.8) landed the model 20% short — that is the bug this
    // wording replaced, so a future "clarification" must not restore it.
    assert.equal(tool.description.includes("seen / declared"), false, "the ratio is not inverted");
  }
  // There is no open_app action, so the description must not point at one — and it must name a
  // launcher the platform actually has (Meta alone opens nothing on macOS).
  assert.equal(write.description.includes("do that here"), false, "no pointer at a capability the tool lacks");
  assert.ok(write.description.includes("launcher"), "the model is given a way to open an app");
  assert.ok(write.description.includes("Cmd+Space on macOS"), "…that exists on macOS");

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
  const { tools, resizes } = activate(computer, { settleMs: 0 });
  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);

  const output = await read.execute({}, OPTS);
  assert.deepEqual(calls, [["screenshot"]]);
  assert.equal(output.base64, Buffer.from(PNG_BYTES).toString("base64"));
  assert.equal(output.mimeType, "image/png", "no resizeImage ⇒ the raw PNG is sent as-is");
  assert.equal(output.summary, "screen 1280x800 · pointer 10,20");
  assert.deepEqual(output.display, DISPLAY);
  assert.equal(read.present.text(output), output.summary);
  assert.equal(resizes.at(-1), DISPLAY.width, "a full screenshot is capped at the display width");

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
  // The codec cap is `MAX_ZOOM_WIDTH` (1568), NOT the region's width: the host's resize never
  // enlarges, so capping a zoom at `region.width` (a DISPLAY-space number) re-encoded the driver's
  // native-resolution crop back to display density — the model got a plain crop, labelled
  // "MAGNIFIED", and the whole zoom feature did nothing on a host that owns an image codec.
  assert.equal(resizes.at(-1), 1568, "a zoom keeps the host's native resolution; only the MAX_ZOOM_WIDTH cap applies");

  // Unmeasurable bytes (this fake returns an 8-byte header) must NOT be assumed to be 1:1: the host
  // may have magnified, so the conservative "do not use this image's pixels" rule is the only honest
  // one. A measurable 1:1 crop and the JPEG codec path are asserted below.
  const zoomParts = read.toModelOutput({ output: zoomed });
  assert.equal(zoomed.image, undefined, "unmeasurable bytes carry no size claim");
  assert.equal(zoomed.scale, undefined);
  assert.ok(
    zoomParts[0].content.includes("Do NOT use this image's own pixels"),
    "…and the text falls back to the conservative rule"
  );
  // …and it must NOT name a declared size it does not know: falling back to `display` here would
  // tell the model the crop is 1280x800 and have it multiply by the wrong ratio.
  assert.equal(
    zoomParts[0].content.includes("multiply what you measure by declared / seen"),
    false,
    "an unmeasured crop claims no delivered size"
  );
  assert.ok(zoomParts[0].content.includes("(0,0)-(320,200)"), "…still naming the region in screen space");
  assert.ok(read.toModelOutput({ output: output })[0].content.includes("screen pixels in (0,0)-(1280,800)"));
  // A provider may downscale the attachment (a measured session saw 1280x800 arrive as 1024x640);
  // the rule is on every result, so the model does not have to discover it by trial and error.
  const fullText = read.toModelOutput({ output: output })[0].content;
  assert.ok(
    fullText.includes("multiply what you measure by declared / seen"),
    "the result states the conversion (declared / seen, not its inverse)"
  );
  assert.ok(fullText.includes("is not 1280x800"), "…naming the size it actually delivered");
  assert.equal(fullText.includes(" band ("), false, "a full screenshot is the screen, not a band of it");
}

// The exact zoom a measured session asked for while aiming at the Dock: 640-710 of an 800-high
// screen is the bottom-center BAND, and it ends at 89% — 11% above the bottom edge. That sentence is
// what the old result lacked; the model read the rect as a label and gave up on zoom.
{
  const { computer } = fakeComputer({ zoom: async () => pngBytes(1568, 157) });
  const { tools } = activate(computer, { settleMs: 0 });
  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);
  const shot = await read.execute({ zoom: { x: 300, y: 640, width: 700, height: 70 } }, OPTS);
  const text = read.toModelOutput({ output: shot })[0].content;
  assert.match(text, /the bottom-center band \(x 23%-78%, y 80%-89% of the screen\)/);
}

// A region covering the frame is the screen, not a band that happens to span 0%-100% on both axes.
{
  const { computer } = fakeComputer({ zoom: async () => pngBytes(DISPLAY.width, DISPLAY.height) });
  const { tools } = activate(computer, { settleMs: 0 });
  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);
  const whole = await read.execute({ zoom: { x: 0, y: 0, width: DISPLAY.width, height: DISPLAY.height } }, OPTS);
  assert.match(
    read.toModelOutput({ output: whole })[0].content,
    /the whole screen \(x 0%-100%, y 0%-100%\)/,
    "a full-frame zoom is named as the whole screen"
  );
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

  // mouse_down presses WHERE THE POINTER IS. It used to accept a point ("move there first"), but a
  // strict tool schema (OpenAI) forces every property into `required` — the model could only send
  // x:0,y:0 and every press jumped to the screen origin. A hand-built drag moves first.
  calls.length = 0;
  await write.execute({ action: "mouse_down", x: 4, y: 5 }, OPTS);
  assert.deepEqual(
    calls.filter(([name]) => name !== "screenshot"),
    [["mouseDown", "left"]],
    "the coordinates are ignored: pressing never moves the pointer"
  );

  // Validation is the model's error message, so it has to name the missing argument.
  await assert.rejects(() => write.execute({ action: "click" }, OPTS), /needs x and y/);

  // A scroll with no delta is a no-op that still costs an approval and a screenshot, and its
  // summary reads as success — refuse it instead of returning "scroll 0,0 at x,y".
  await assert.rejects(() => write.execute({ action: "scroll", x: 1, y: 1 }, OPTS), /non-zero delta_x or delta_y/);
  await assert.rejects(
    () => write.execute({ action: "scroll", x: 1, y: 1, delta_x: 0, delta_y: 0 }, OPTS),
    /non-zero delta_x or delta_y/
  );
  assert.equal(write.inputSchema.safeParse({ action: "scroll", x: 1, y: 1, delta_y: 200 }).success, true);
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

  // A call-level `modifiers` on a BATCH applies to every entry that can hold one. It used to be
  // inherited by every entry (one `type` then failed the batch — 10 of 13 errors in a measured
  // session), and refusing the shape turned the natural `{modifiers, actions}` call into an error the
  // model repeated.
  calls.length = 0;
  const shifted = await write.execute(
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
    ["Shift", "Shift"],
    "every click holds the call-level modifier"
  );
  assert.match(shifted.summary, /Shift\+click 1,1 left → Shift\+click 2,2 left/);

  // `type`/`wait` cannot hold a modifier: they run plain and the summary says what was ignored — the
  // batch as a whole still runs.
  calls.length = 0;
  const mixed = await write.execute(
    {
      modifiers: ["Control"],
      actions: [
        { action: "type", text: "hi" },
        { action: "click", x: 3, y: 4 },
        { action: "wait", ms: 1 },
      ],
    },
    OPTS
  );
  assert.deepEqual(
    calls.filter(([name]) => name !== "screenshot"),
    [
      ["type", "hi"],
      ["keyDown", "Control"],
      ["click", 3, 4, "left", 1],
      ["keyUp", "Control"],
    ]
  );
  assert.match(mixed.summary, /Control ignored on 2 entries that cannot hold modifiers/);

  // An entry's own modifiers win over the call-level ones.
  calls.length = 0;
  await write.execute({ modifiers: ["Shift"], actions: [{ action: "click", x: 1, y: 1, modifiers: ["Alt"] }] }, OPTS);
  assert.deepEqual(
    calls.filter(([name]) => name === "keyDown").map(([, key]) => key),
    ["Alt"],
    "the entry's own modifiers win"
  );

  // An entry that carries its own modifiers still works (the pointer gesture holds them).
  calls.length = 0;
  await write.execute(
    {
      actions: [
        { action: "click", x: 1, y: 1, modifiers: ["Shift"] },
        { action: "click", x: 2, y: 2, modifiers: ["Shift"] },
      ],
    },
    OPTS
  );
  assert.deepEqual(
    calls.filter(([name]) => name === "keyDown").map(([, key]) => key),
    ["Shift", "Shift"]
  );

  // A `key` chord sends its modifiers WITH the key (the driver turns them into the event's flags) —
  // holding them as separate events typed a literal "a" on macOS.
  calls.length = 0;
  await write.execute({ action: "key", keys: ["a"], modifiers: ["Control"] }, OPTS);
  assert.deepEqual(
    calls.filter(([name]) => name !== "screenshot"),
    [["press", ["Control", "a"]]]
  );

  // The schema refuses an empty batch, and accepts a one-entry one.
  assert.equal(write.inputSchema.safeParse({ actions: [] }).success, false);
  assert.equal(write.inputSchema.safeParse({ actions: [{ action: "click", x: 1, y: 1 }] }).success, true);
}

// A batch is validated BEFORE its first step. A backend validates a key name at the point of the
// call, so a measured batch typed, waited, and only then failed on `Return` — and the model retried
// the whole sequence. Only the host knows its key table, so the check is its optional
// `validatePress`; `keys` also carries the entry's modifiers, which are part of the same chord.
{
  const { computer, calls } = fakeComputer({
    validatePress: (keys) => {
      if (keys.includes("Bogus")) throw new Error('"Bogus" is not a key name this host can press.');
    },
  });
  const { tools } = activate(computer, { settleMs: 0 });
  const write = tools.get(COMPUTER_ACTION_TOOL);

  await assert.rejects(
    () =>
      write.execute(
        {
          actions: [
            { action: "type", text: "search" },
            { action: "wait", ms: 1 },
            { action: "key", keys: ["Bogus"] },
          ],
        },
        OPTS
      ),
    /Action #3 of 3 \(key\) would fail: "Bogus" is not a key name/
  );
  assert.deepEqual(
    calls.filter(([name]) => name !== "screenshot"),
    [],
    "nothing runs before the whole batch is validated"
  );

  // An entry with no `keys` is caught by the same pass (dispatch would only see it at its step).
  await assert.rejects(
    () => write.execute({ actions: [{ action: "type", text: "x" }, { action: "key" }] }, OPTS),
    /Action #2 of 2 \(key\) needs `keys`/
  );

  // The host sees the chord `press` would receive, modifiers included.
  const seen = [];
  const { computer: spy } = fakeComputer({ validatePress: (keys) => seen.push(keys) });
  await activate(spy, { settleMs: 0 })
    .tools.get(COMPUTER_ACTION_TOOL)
    .execute({ actions: [{ action: "key", keys: ["a"], modifiers: ["Control"] }] }, OPTS);
  assert.deepEqual(seen, [["Control", "a"]]);

  // An already-cancelled call keeps its abort verdict: `runActions` checks the signal before the
  // guards, so a bad key cannot turn a cancel into a validation failure (the classifier reads
  // `signal.aborted` for the neutral row).
  const cancelled = AbortSignal.abort(new Error("cancelled by the user"));
  await assert.rejects(
    () =>
      write.execute(
        {
          actions: [
            { action: "type", text: "search" },
            { action: "key", keys: ["Bogus"] },
          ],
        },
        { ...OPTS, abortSignal: cancelled }
      ),
    /cancelled by the user/
  );

  // A host without the capability keeps the old, step-local failure — documented, not incidental.
  const { computer: unvalidated, calls: unvalidatedCalls } = fakeComputer({
    press: async (keys) => {
      if (keys.includes("Bogus")) throw new Error("bad key");
      unvalidatedCalls.push(["press", keys]);
    },
  });
  const unvalidatedWrite = activate(unvalidated, { settleMs: 0 }).tools.get(COMPUTER_ACTION_TOOL);
  await assert.rejects(
    () =>
      unvalidatedWrite.execute(
        {
          actions: [
            { action: "type", text: "x" },
            { action: "key", keys: ["Bogus"] },
          ],
        },
        OPTS
      ),
    /Action #2 of 2 \(key\) failed after: type "x": bad key/
  );
  assert.ok(
    unvalidatedCalls.some(([name]) => name === "type"),
    "without `validatePress` the earlier step still ran, and the failure names the step that carries it"
  );
}

// ============================================================================
// Action schema: held keys, batch inheritance, step-indexed failures
// ============================================================================
//
// Every case here is a measured failure from a real session: a `click` with
// `modifiers: ["Backspace"]` (which cleared the field), a batch whose `text` sat on the CALL and
// produced `"type" needs text`, and a four-action batch whose error named no step.
{
  const { computer, calls } = fakeComputer();
  const { tools } = activate(computer, { settleMs: 0 });
  const write = tools.get(COMPUTER_ACTION_TOOL);

  // A held key must be a MODIFIER. Anything else belongs in `key` — as a held key it silently
  // rewrites the action (Backspace+click cleared a search box).
  for (const modifier of ["Control", "Shift", "Alt", "Meta"]) {
    assert.equal(
      write.inputSchema.safeParse({ action: "click", x: 1, y: 1, modifiers: [modifier] }).success,
      true,
      `${modifier} is a held modifier`
    );
  }
  assert.equal(
    write.inputSchema.safeParse({ action: "click", x: 1, y: 1, modifiers: ["Backspace"] }).success,
    false,
    "a non-modifier cannot be held for a gesture"
  );

  // The payload fields travel from the call into the entries that omit them — `text` on the CALL
  // used to produce `"type" needs text` while the text was right there.
  calls.length = 0;
  const inherited = await write.execute(
    {
      text: "hi",
      keys: ["Enter"],
      button: "right",
      actions: [{ action: "type" }, { action: "click", x: 3, y: 4 }, { action: "key" }],
    },
    OPTS
  );
  assert.deepEqual(
    calls.filter(([name]) => name !== "screenshot"),
    [
      ["type", "hi"],
      ["click", 3, 4, "right", 1],
      ["press", ["Enter"]],
    ],
    "text / keys / button are inherited; coordinates are not"
  );
  assert.match(inherited.summary, /type "hi" → click 3,4 right → press Enter/);

  // Coordinates are NEVER inherited: an entry that names no point is refused, not silently sent to
  // the call's point (which would click somewhere the model did not ask for).
  await assert.rejects(
    () => write.execute({ x: 9, y: 9, actions: [{ action: "click" }] }, OPTS),
    /needs x and y/,
    "an entry without a point is refused, not pointed at the call's coordinates"
  );

  // A held modifier on `type` changes the GESTURE (Cmd+V → Cmd+Shift+V), not the text.
  await assert.rejects(
    () => write.execute({ action: "type", text: "x", modifiers: ["Shift"] }, OPTS),
    /cannot take modifiers/
  );

  // An abort that arrives from ANOTHER signal keeps its identity: the step context must not wrap it
  // into `Action #2 …`, or a cancel is reported as a tool failure.
  {
    const aborted = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const { computer: aborting } = fakeComputer({
      mouseDown: async () => {
        throw aborted;
      },
    });
    const abortingTools = activate(aborting, { settleMs: 0 }).tools;
    await assert.rejects(
      () =>
        abortingTools
          .get(COMPUTER_ACTION_TOOL)
          .execute({ actions: [{ action: "click", x: 1, y: 1 }, { action: "mouse_down" }] }, OPTS),
      (error) => error === aborted,
      "an abort is rethrown as-is"
    );
  }

  // A failure names the step, so the model does not re-run the whole sequence.
  {
    const { computer: failing } = fakeComputer({
      mouseDown: async () => {
        throw new Error("no button");
      },
    });
    const failingTools = activate(failing, { settleMs: 0 }).tools;
    await assert.rejects(
      () =>
        failingTools
          .get(COMPUTER_ACTION_TOOL)
          .execute({ actions: [{ action: "click", x: 1, y: 1 }, { action: "mouse_down" }] }, OPTS),
      /Action #2 of 2 \(mouse_down\) failed after: click 1,1 left: no button/
    );
  }

  // A press never claims a position it did not use.
  const pressed = (await write.execute({ action: "mouse_down", x: 5, y: 6 }, OPTS)).summary;
  assert.ok(pressed.startsWith("mouse down left"), pressed);
  assert.equal(pressed.includes("at 5,6"), false, "the ignored coordinates are not reported as used");
  assert.match((await write.execute({ action: "mouse_up" }, OPTS)).summary, /mouse up left/);
}

// ============================================================================
// Zoom reports the factor it magnified by
// ============================================================================
//
// A crop is captured at the panel's physical resolution, so on a 2.25x display a 400x200 region
// comes back 900x450. The model used to be told "this is magnified" and nothing else, assumed 2.0,
// and every click it derived from a zoom landed ~12% short.
function jpegBytes(width, height) {
  // 32 bytes: the dimension probe refuses anything shorter than 24 before it even looks at the
  // signature, so a minimal 20-byte SOF header would have been rejected as "unmeasurable".
  const bytes = Buffer.alloc(32);
  bytes[0] = 0xff;
  bytes[1] = 0xd8; // SOI
  bytes[2] = 0xff;
  bytes[3] = 0xc0; // SOF0
  bytes.writeUInt16BE(17, 4);
  bytes[6] = 8; // precision
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return new Uint8Array(bytes);
}

function pngBytes(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
}

{
  const { computer } = fakeComputer({ zoom: async () => pngBytes(900, 450) });
  const { tools } = activate(computer, { settleMs: 0 });
  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);

  const zoomed = await read.execute({ zoom: { x: 100, y: 50, width: 400, height: 200 } }, OPTS);
  assert.deepEqual(zoomed.image, { width: 900, height: 450 }, "the attached image's own size");
  assert.equal(zoomed.scale, 2.25, "…and the factor that maps it back");

  const text = read.toModelOutput({ output: zoomed })[0].content;
  assert.match(text, /900x450 = 2\.25x the screen region \(100,50\)-\(500,250\)/, "the real factor is stated");
  // Exact per-axis arithmetic, not the rounded factor: `w * 0.005` display px of error at 2.25x.
  assert.match(
    text,
    /screen_x = 100 \+ image_x \* 400 \/ 900, screen_y = 50 \+ image_y \* 200 \/ 450/,
    "…with exact arithmetic to apply it"
  );
  assert.match(text, /Coordinates you SEND are always screen pixels/, "and the invariant");

  // The region is placed in the WHOLE screen, not just described by its rect: a measured session
  // zoomed 640-710 on an 800-high screen, saw wallpaper, and concluded zoom was broken — the rect was
  // in the text, but nothing said it was the bottom band ending 11% short of the Dock at 94%+.
  assert.match(
    text,
    /the top-left band \(x 8%-39%, y 6%-31% of the screen\)/,
    "the region's place in the screen is stated"
  );

  // A full screenshot is not magnified: no region, no scale, and the image is the display frame.
  const shot = await read.execute({}, OPTS);
  assert.equal(shot.region, undefined);
  assert.equal(shot.scale, undefined);
  assert.match(read.toModelOutput({ output: shot })[0].content, /screen pixels in \(0,0\)-\(1280,800\)/);
}

// A crop that is exactly the region (a 1x panel) says "1:1", and gives the OFFSET mapping — a model
// that sends the local pixel without adding the region origin lands `x`,`y` away from the target.
{
  const { computer } = fakeComputer({ zoom: async () => pngBytes(320, 200) });
  const { tools } = activate(computer, { settleMs: 0 });
  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);
  const zoomed = await read.execute({ zoom: { x: 100, y: 50, width: 320, height: 200 } }, OPTS);
  assert.equal(zoomed.scale, 1);
  const text = read.toModelOutput({ output: zoomed })[0].content;
  assert.match(text, /at 1:1/, "1:1 is stated as such, not as a magnification");
  assert.match(text, /screen_x = 100 \+ image_x, screen_y = 50 \+ image_y/, "…with the region offset");
}

// The production codec path: with a host that compresses, the attached image is a JPEG, so the size
// must come from a JPEG header (the PNG branch would return null and drop the factor).
{
  const jpeg = jpegBytes(900, 450);
  const { computer } = fakeComputer({ zoom: async () => pngBytes(1800, 900) });
  const { tools } = activate(computer, { settleMs: 0 }, { resizeImage: async () => jpeg });
  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);
  const zoomed = await read.execute({ zoom: { x: 0, y: 0, width: 400, height: 200 } }, OPTS);
  assert.equal(zoomed.mimeType, "image/jpeg");
  assert.deepEqual(zoomed.image, { width: 900, height: 450 }, "measured from the JPEG the host produced");
  assert.equal(zoomed.scale, 2.25);
}

// An OFF-SCREEN region is clamped BEFORE the capture, so the region the text names is the region the
// image shows and `scale` divides by the width actually captured. Before this, `zoom(1200,700,500,500)`
// on a 1280-wide display captured 80x100 while claiming (1200,700)-(1700,1200) at 0.36x.
{
  const { computer, calls } = fakeComputer();
  // Keep recording the region the driver is asked for — that is the assertion: it must be clamped.
  computer.zoom = async (region) => {
    calls.push(["zoom", region]);
    return pngBytes(180, 225);
  };
  const { tools } = activate(computer, { settleMs: 0 });
  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);
  const zoomed = await read.execute({ zoom: { x: 1200, y: 700, width: 500, height: 500 } }, OPTS);
  assert.deepEqual(calls.at(-1), ["zoom", { x: 1200, y: 700, width: 80, height: 100 }], "clamped before capture");
  assert.deepEqual(zoomed.region, { x: 1200, y: 700, width: 80, height: 100 }, "the text names the captured region");
  assert.equal(zoomed.scale, 2.25, "…and the factor divides by the width actually captured");
  assert.match(read.toModelOutput({ output: zoomed })[0].content, /\(1200,700\)-\(1280,800\)/);

  // Nothing usable left (the region starts outside the screen) is an error, not a 1x1 screenshot.
  await assert.rejects(
    () => read.execute({ zoom: { x: 2000, y: 0, width: 400, height: 200 } }, OPTS),
    /outside the 1280x800 screen/
  );
  await assert.rejects(
    () => read.execute({ zoom: { x: 0, y: 0, width: 2, height: 200 } }, OPTS),
    /outside the 1280x800 screen/
  );
}

// A near-1:1 crop (401 px for a 400 px region) is NOT called 1:1, and the formula keeps the ratio:
// the old 1% window rendered it as `x + image_x`, up to 4 display px off at the right edge.
{
  const { computer } = fakeComputer({ zoom: async () => pngBytes(401, 200) });
  const { tools } = activate(computer, { settleMs: 0 });
  const read = tools.get(COMPUTER_SCREENSHOT_TOOL);
  const zoomed = await read.execute({ zoom: { x: 0, y: 0, width: 400, height: 200 } }, OPTS);
  assert.equal(zoomed.scale, 1);
  const text = read.toModelOutput({ output: zoomed })[0].content;
  assert.equal(text.includes("at 1:1"), false, "exact dimensions are what make it 1:1");
  assert.match(text, /screen_x = 0 \+ image_x \* 400 \/ 401/, "the ratio survives the near-1:1 case");
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

  // The elided form is MEMOIZED per message: the same input must yield the same elided bytes on
  // every call. This is the cache property, not an optimization detail — a re-serialized payload
  // that differs by one byte silently invalidates the prefix from that message on.
  {
    const first = capScreenshotHistory(messages, 2, true);
    const second = capScreenshotHistory(messages, 2, true);
    assert.equal(second[1], first[1], "an already-elided message is returned by reference, never re-encoded");
    assert.equal(second[2], first[2], "…for string content too (the stringified tool result)");
    assert.equal(second[1].content, first[1].content);
    assert.equal(second[2].content, first[2].content);
  }

  // A message that is already blinded is returned AS-IS — never re-serialized (the bytes are the
  // cache key), for both content shapes.
  {
    assert.equal(capScreenshotHistory([capped[1]], 1, true)[0], capped[1], "object content: no rewrite");
    assert.equal(capScreenshotHistory([capped[2]], 1, true)[0], capped[2], "string content: no re-encode");
  }

  // `screenshotHistory: false` is the cache-first opt-out: no elision at all, so the wire stays
  // append-only. A vision-less model still gets every image dropped (it cannot read them).
  {
    assert.equal(capScreenshotHistory(messages, false, true), messages, "false disables the cap");
    const blind = capScreenshotHistory(messages, false, false);
    assert.equal(
      blind.filter((message) => message.role === "tool" && hasImage(message)).length,
      0,
      "false does not keep images for a model that cannot see them"
    );
    assert.equal(
      capScreenshotHistory(messages, 0, true).filter((message) => message.role === "tool" && hasImage(message)).length,
      0,
      "an explicit 0 keeps none (it must not degrade to slice(0) = keep all)"
    );

    const wiredOff = activate(fakeComputer().computer, { screenshotHistory: false, settleMs: 0 }).transformer();
    assert.equal(
      wiredOff({ messages, modelHasVision: true }).filter((message) => message.role === "tool" && hasImage(message))
        .length,
      4,
      "the extension accepts the opt-out"
    );
  }

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
