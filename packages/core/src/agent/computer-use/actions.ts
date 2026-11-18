/**
 * The action half of the computer-use extension: one schema, one dispatcher.
 *
 * Every action maps to a `CoreEnvComputer` primitive, so this module knows nothing about screens,
 * OSes or addons — the host does. That is what keeps the capability provider-agnostic: the model
 * decides from a tool call plus the screenshot it can see, and nothing here asks a provider for a
 * native "computer" tool.
 *
 * Coordinates are in the space of the screenshot the model is looking at
 * (`CoreEnvComputer.display`); the host scales them to real screen pixels.
 *
 * Three things exist here that the driver does not need to know about, and each one closes a gap the
 * reference implementations made obvious:
 *
 * - **`modifiers`** — Ctrl+click, Shift+click (range select) and Ctrl+scroll (zoom in apps) were
 *   three separate calls, three approvals and three screenshots. Anthropic spells it `key`/`text` on
 *   the action and OpenAI `keys: string[]` on every pointer action; here it is an array of held keys.
 * - **`actions`** — a batch. OpenAI's `actions[]` exists because one round trip per action costs a
 *   full screenshot each time; a form with ten fields should not cost ten images.
 * - **`steps`** — robotjs moves the pointer instantly, and HTML5 drag-and-drop (plus most canvas
 *   apps) only registers a drag when the pointer actually travels. OpenAI sends a `path` of
 *   waypoints; interpolating between two points is the same thing with less schema.
 */
import { z } from "zod";

import { isAbortError } from "../../runtime-types/abort.js";
import { errorMessage } from "../../utils/errors.js";
import { truncateText } from "../../utils/text-truncation.js";

import type { CoreEnvComputer, CoreEnvMouseButton } from "../../env";

/** What the model can do. Kept flat (an `action` discriminator) so the tool list stays small. */
export const COMPUTER_ACTIONS = [
  "click",
  "double_click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "mouse_down",
  "mouse_up",
  "wait",
] as const;

export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

/** Longest single wait. An un-capped wait is a way to hang a turn. */
export const MAX_WAIT_MS = 10_000;

/** How long an action is given to take effect before the screenshot is taken. */
export const DEFAULT_SETTLE_MS = 800;

/** A batch is a convenience, not a scripting language: past this it should be its own turn. */
export const MAX_BATCH_ACTIONS = 12;

/** Total wait a batch may spend, kept under the tool's own timeout so a cut cannot strand input. */
export const MAX_BATCH_WAIT_MS = 20_000;

/**
 * The only keys a gesture may hold down.
 *
 * `modifiers` used to accept any string, so "hold this key while clicking" was expressible with a
 * NON-modifier: `["Backspace"]` + click cleared a search field, and `["Meta"]` + click became
 * Cmd+click. A held key is a modifier by definition — everything else belongs in `key`.
 */
export const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta"] as const;
export type ComputerModifier = (typeof MODIFIER_KEYS)[number];

/** Longest interpolated drag. Enough for a smooth drag, short enough to stay one visible gesture. */
const MAX_DRAG_STEPS = 60;

/** Per-step pause in an interpolated drag, so the drop target sees a sequence of moves. */
const DRAG_STEP_MS = 12;

/**
 * One action. Shared by the top-level call and each element of a batch.
 *
 * `action` is optional at the top level only (a batch call carries `actions` instead); inside a
 * batch it is required, which the two schemas below express without a recursive shape.
 */
const actionShape = {
  action: z.enum(COMPUTER_ACTIONS).describe("The action to perform."),
  x: z.number().optional().describe("Pointer X, in the screenshot's pixels. Required to point at something."),
  y: z.number().optional().describe("Pointer Y, in the screenshot's pixels. Required to point at something."),
  to_x: z.number().optional().describe("Drag target X, in the screenshot's pixels."),
  to_y: z.number().optional().describe("Drag target Y, in the screenshot's pixels."),
  button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)."),
  text: z.string().optional().describe("Text to type."),
  keys: z
    .array(z.string())
    .min(1)
    .optional()
    .describe('Keys to press together, using KeyboardEvent.key names — e.g. ["Control", "c"], ["Enter"].'),
  delta_x: z
    .number()
    .optional()
    .describe(
      "Horizontal scroll in screenshot pixels; positive scrolls right. Linux/Windows convert it to " +
        "wheel notches (100 px ≈ one notch), so it is a gesture size, not a physical distance."
    ),
  delta_y: z
    .number()
    .optional()
    .describe(
      "Vertical scroll in screenshot pixels; positive scrolls down. Linux/Windows convert it to " +
        "wheel notches (100 px ≈ one notch). A scroll needs a non-zero delta."
    ),
  ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe("Milliseconds to wait (wait only)."),
  modifiers: z
    .array(z.enum(MODIFIER_KEYS))
    .min(1)
    .max(4)
    .optional()
    .describe(
      'Modifier keys for THIS action: ["Control"] to Ctrl+click, ["Shift"] to extend a selection, ' +
        '["Control"] with scroll to zoom. Only Control / Shift / Alt / Meta — for any other key use ' +
        "`key`. On `key` they are attached to the keystroke; in a batch put them on the entry that " +
        "needs them (entries do not inherit the call's). On macOS Control+click IS the secondary click."
    ),
  steps: z
    .number()
    .int()
    .min(1)
    .max(MAX_DRAG_STEPS)
    .optional()
    .describe(
      "How many intermediate moves a drag makes (default 1 = a jump). Raise it when a drag does not " +
        "register — native drag-and-drop and canvas apps need the pointer to travel."
    ),
};

export const computerActionEntrySchema = z.object(actionShape);

export const computerActionSchema = z.object({
  ...actionShape,
  action: z.enum(COMPUTER_ACTIONS).optional().describe("The action to perform. Omit when using `actions`."),
  actions: z
    .array(computerActionEntrySchema)
    .min(1)
    .max(MAX_BATCH_ACTIONS)
    .optional()
    .describe(
      "Perform several actions in one call, in order. Cheaper than one call per action: it is one " +
        "approval and ONE screenshot at the end, so use it for sequences you are already sure about. " +
        "An entry may omit `text`, `keys` and `button`: the call's value is used for it. Coordinates " +
        "and `modifiers` are NOT shared — each entry names its own target, and an entry that needs a " +
        "modifier carries it."
    ),
});

export type ComputerActionEntry = z.infer<typeof computerActionEntrySchema>;
export type ComputerActionInput = z.infer<typeof computerActionSchema>;

/** Abort-aware delay — Esc has to cut a `wait` short instead of blocking the turn. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requirePoint(input: ComputerActionInput | ComputerActionEntry, action: ComputerAction) {
  if (typeof input.x !== "number" || typeof input.y !== "number") {
    throw new Error(`"${action}" needs x and y, in the pixels of the screenshot you are looking at.`);
  }
  // Zod accepts Infinity; the driver would hand it to the OS. One bad coordinate is a misfire.
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) {
    throw new Error(`"${action}" needs finite x and y.`);
  }
  return { x: input.x, y: input.y };
}

function requireDragTarget(input: ComputerActionInput | ComputerActionEntry) {
  if (typeof input.to_x !== "number" || typeof input.to_y !== "number") {
    throw new Error('"drag" needs to_x and to_y: the point the dragged thing is dropped at.');
  }
  return { x: input.to_x, y: input.to_y };
}

/**
 * Drag from one point to another, optionally through intermediate moves.
 *
 * The intermediate points exist for hosts whose pointer teleports: a single jump is not a gesture,
 * and a drop target that tracks movement never sees one.
 */
async function drag(
  computer: CoreEnvComputer,
  from: { x: number; y: number },
  to: { x: number; y: number },
  button: CoreEnvMouseButton,
  steps: number,
  signal?: AbortSignal
) {
  await computer.move(from.x, from.y, { signal });
  await computer.mouseDown(button, { signal });
  try {
    for (let step = 1; step <= steps; step++) {
      const ratio = step / steps;
      await computer.move(Math.round(from.x + (to.x - from.x) * ratio), Math.round(from.y + (to.y - from.y) * ratio), {
        signal,
      });
      if (steps > 1 && step < steps) await delay(DRAG_STEP_MS, signal);
    }
  } finally {
    // Release even when the move aborted, or the user's button stays held down — but a failed
    // release must not replace the error that caused it (an abort would be reported as a mouse
    // problem, sending the reader after the wrong thing).
    try {
      await computer.mouseUp(button);
    } catch {
      // Nothing useful to do here; the caller's failure is the one worth reporting.
    }
  }
}

/** What a call is currently holding down, so a failure cannot leave the user's input stuck. */
interface HeldInput {
  keys: string[];
  buttons: CoreEnvMouseButton[];
}

/**
 * Release whatever is still held, best effort.
 *
 * Swallowing the errors is deliberate: this runs on the FAILURE path, and a release that throws must
 * not replace the failure that caused it (an abort would be reported as "could not release", which
 * sends the reader after the wrong thing). Every key still gets its own attempt.
 */
async function releaseHeld(computer: CoreEnvComputer, held: HeldInput): Promise<void> {
  for (const button of [...held.buttons].reverse()) {
    try {
      await computer.mouseUp(button);
    } catch {
      // Nothing useful to do: the alternative is masking the original error.
    }
  }
  for (const key of [...held.keys].reverse()) {
    try {
      await computer.keyUp(key);
    } catch {
      // Same as above.
    }
  }
  held.buttons.length = 0;
  held.keys.length = 0;
}

/** One action, with no modifier handling — the caller wraps that. */
async function dispatchAction(
  computer: CoreEnvComputer,
  input: ComputerActionInput | ComputerActionEntry,
  held: HeldInput,
  signal?: AbortSignal
): Promise<string> {
  const action = input.action;
  if (!action) throw new Error('"computer" needs `action` (one action) or `actions` (a batch).');

  const button = (input.button ?? "left") as CoreEnvMouseButton;

  switch (action) {
    case "click":
    case "double_click": {
      const point = requirePoint(input, action);
      const count = action === "double_click" ? 2 : 1;
      await computer.click(point.x, point.y, { button, count, signal });
      return `${action === "double_click" ? "double-click" : "click"} ${point.x},${point.y} ${button}`;
    }

    case "move": {
      const point = requirePoint(input, "move");
      await computer.move(point.x, point.y, { signal });
      return `move ${point.x},${point.y}`;
    }

    case "drag": {
      const from = requirePoint(input, "drag");
      const to = requireDragTarget(input);
      await drag(computer, from, to, button, input.steps ?? 1, signal);
      return `drag ${from.x},${from.y} → ${to.x},${to.y}`;
    }

    case "scroll": {
      const point = requirePoint(input, "scroll");
      const deltaX = input.delta_x ?? 0;
      const deltaY = input.delta_y ?? 0;
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        throw new Error('"scroll" needs finite delta_x and delta_y.');
      }
      // A scroll with no delta is a no-op that still costs an approval and a screenshot, and its
      // summary ("scroll 0,0") reads as success — so the model retries the same nothing.
      if (deltaX === 0 && deltaY === 0) {
        throw new Error('"scroll" needs a non-zero delta_x or delta_y (positive scrolls right/down).');
      }
      await computer.scroll(point.x, point.y, deltaX, deltaY, { signal });
      return `scroll ${deltaX},${deltaY} at ${point.x},${point.y}`;
    }

    case "type": {
      if (typeof input.text !== "string" || input.text.length === 0) {
        throw new Error('"type" needs text.');
      }
      await computer.type(input.text, { signal });
      return `type "${truncateText(input.text, 40)}"`;
    }

    case "key": {
      if (!input.keys || input.keys.length === 0) {
        throw new Error('"key" needs keys, e.g. ["Control", "c"].');
      }
      await computer.press(input.keys, { signal });
      return `press ${input.keys.join("+")}`;
    }

    case "mouse_down": {
      // A press lands wherever the pointer is (Anthropic's `left_mouse_down` has no coordinate).
      // Accepting a point means "move there first", which is what a hand-built drag wants — and the
      // summary says which one happened, so a log can tell a press-in-place from a press-at-point.
      const at = typeof input.x === "number" && typeof input.y === "number" ? { x: input.x, y: input.y } : null;
      if (at) await computer.move(at.x, at.y, { signal });
      await computer.mouseDown(button, { signal });
      held.buttons.push(button);
      return at ? `mouse down ${button} at ${at.x},${at.y}` : `mouse down ${button}`;
    }

    case "mouse_up": {
      await computer.mouseUp(button);
      held.buttons = held.buttons.filter((pressed) => pressed !== button);
      return `mouse up ${button}`;
    }

    case "wait": {
      const ms = input.ms ?? 1000;
      await delay(ms, signal);
      return `wait ${ms}ms`;
    }
  }
}

/** Run one action with its modifiers held down for the whole gesture. */
async function runWithModifiers(
  computer: CoreEnvComputer,
  input: ComputerActionInput | ComputerActionEntry,
  held: HeldInput,
  signal?: AbortSignal
): Promise<string> {
  const modifiers = input.modifiers ?? [];
  if (modifiers.length === 0) return dispatchAction(computer, input, held, signal);

  // `type` injects the text as a whole (on macOS through the pasteboard), so a held key does not
  // modify the characters — it modifies the GESTURE: Cmd+V becomes Cmd+Shift+V, a different command
  // in most apps. Refuse it instead of silently changing what was asked for.
  if (input.action === "type") {
    throw new Error(
      '"type" cannot take modifiers: the text is injected as a whole, and a held key turns the ' +
        'paste into a different shortcut. Use "key" for a modified keystroke.'
    );
  }

  // A chord's modifiers are the EVENT's flags, not a held state (see `CoreEnvComputer.keyDown`):
  // merge them into the key list so the backend sends `Cmd+a` as one event instead of a literal "a".
  if (input.action === "key") {
    const keys = input.keys ?? [];
    return dispatchAction(computer, { ...input, keys: [...modifiers, ...keys] }, held, signal);
  }

  if (input.action === "wait") {
    throw new Error('"wait" cannot take modifiers.');
  }

  // Pressed one at a time and tracked AS they land: a `keyDown` that throws (abort is the common
  // case) must release what already went down, and the loop cannot be trusted to have finished.
  for (const key of modifiers) {
    await computer.keyDown(key, { signal });
    held.keys.push(key);
  }
  try {
    const summary = await dispatchAction(computer, input, held, signal);
    return `${modifiers.join("+")}+${summary}`;
  } finally {
    // Released in reverse, and even on abort: a stuck Control key breaks everything after it.
    const pressed = held.keys.splice(held.keys.length - modifiers.length, modifiers.length);
    for (const key of [...pressed].reverse()) {
      try {
        await computer.keyUp(key);
      } catch {
        // A release must not change this call's verdict — see `releaseHeld`.
      }
    }
  }
}

/**
 * Run the requested actions and return a one-line summary of what was done.
 *
 * The summary is what the user sees in the transcript (`present.text`), so it names the action and
 * its decisive argument instead of repeating the whole screenshot description. A batch joins its
 * parts with `→`, which is also how the user reads the sequence.
 */
export async function performComputerAction(
  computer: CoreEnvComputer,
  input: ComputerActionInput,
  signal?: AbortSignal
): Promise<string> {
  const held: HeldInput = { keys: [], buttons: [] };
  try {
    return await runActions(computer, input, held, signal);
  } catch (error) {
    // A failed sequence must not leave a modifier held, or a button pressed: the next call (possibly
    // in another turn, after the user answered a prompt) would start from a corrupt input state.
    await releaseHeld(computer, held);
    throw error;
  }
}

async function runActions(
  computer: CoreEnvComputer,
  input: ComputerActionInput,
  held: HeldInput,
  signal?: AbortSignal
): Promise<string> {
  const batch = input.actions;
  if (batch && batch.length > 0) {
    // A batch entry does NOT inherit the call's `modifiers`. It used to, and a single `type` entry
    // then failed the whole batch (10 of 13 errors in a measured session: the model wrote
    // `modifiers` on the call, every entry inherited it, and `type` refuses it). Refusing the shape
    // outright says where the modifiers belong instead of silently applying them to some entries.
    if (input.modifiers !== undefined) {
      throw new Error(
        "Put `modifiers` on the action that needs them: a batch entry does not inherit the call's " +
          "modifiers (one `type` entry would otherwise fail the whole batch)."
      );
    }

    // The tool has one static timeout, so a batch of maximum-length waits would be cut off from the
    // middle (leaving whatever it pressed). Refuse it up front with a message the model can act on.
    const waits = batch.reduce((total, entry) => total + (entry.action === "wait" ? (entry.ms ?? 1000) : 0), 0);
    if (waits > MAX_BATCH_WAIT_MS) {
      throw new Error(
        `This batch waits ${waits}ms, more than the ${MAX_BATCH_WAIT_MS}ms a single call is allowed. ` +
          `Split it into several calls.`
      );
    }

    const summaries: string[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const entry = withInheritedDefaults(batch[index]!, input);
      try {
        summaries.push(await runWithModifiers(computer, entry, held, signal));
      } catch (error) {
        // An abort is the caller's verdict, not a step failure: keep the original error so the run
        // classifier still sees the signal (wrapping it would only add text to a cancel).
        // An abort is the caller's verdict, not a step failure: keep the original error so the run
        // classifier still sees it (wrapping would add text to a cancel). `isAbortError` covers an
        // abort that arrived on ANOTHER signal — the caller's own is not aborted in that case.
        if (signal?.aborted || isAbortError(error)) throw error;
        // Name the step. A batch is one call, so "the call failed" left the model guessing WHICH of
        // its four actions broke — and it usually retried the whole sequence.
        const action = entry.action ?? "action";
        const done = summaries.length > 0 ? ` after: ${summaries.join(" → ")}` : "";
        throw new Error(`Action #${index + 1} of ${batch.length} (${action}) failed${done}: ${errorMessage(error)}`);
      }
    }
    return summaries.join(" → ");
  }
  return runWithModifiers(computer, input, held, signal);
}

/**
 * A batch entry inherits the payload fields it omitted.
 *
 * `modifiers` is deliberately NOT among them: it is a property of one gesture, not of the sequence,
 * and inheriting it made a call-level `modifiers` poison every entry (including a `type`, which
 * refuses them). Coordinates are never inherited either — each entry points at its own place.
 */
function withInheritedDefaults(entry: ComputerActionEntry, outer: ComputerActionInput): ComputerActionEntry {
  const merged: ComputerActionEntry = { ...entry };
  if (merged.button === undefined && outer.button !== undefined) merged.button = outer.button;
  if (merged.text === undefined && outer.text !== undefined) merged.text = outer.text;
  if (merged.keys === undefined && outer.keys !== undefined) merged.keys = outer.keys;
  return merged;
}
