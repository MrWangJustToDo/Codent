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
  "triple_click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
  "hold_key",
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

/** The Anthropic computer tool's own limit on `repeat`; pressing more than this is a script. */
export const MAX_KEY_REPEAT = 100;

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
  x: z
    .number()
    .optional()
    .describe("Pointer X, in screen pixels (the image may be downscaled — see the tool description)."),
  y: z
    .number()
    .optional()
    .describe("Pointer Y, in screen pixels (the image may be downscaled — see the tool description)."),
  to_x: z.number().optional().describe("Drag target X, in screen pixels."),
  to_y: z.number().optional().describe("Drag target Y, in screen pixels."),
  button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)."),
  text: z.string().optional().describe("Text to type."),
  keys: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      'Keys to press together, using KeyboardEvent.key names — e.g. ["Control", "c"], ["Enter"]. ' +
        "For `hold_key`, the keys to hold down for `ms`."
    ),
  delta_x: z
    .number()
    .optional()
    .describe(
      "Horizontal scroll in screen pixels; positive scrolls right. Linux/Windows convert it to " +
        "wheel notches (100 px ≈ one notch), so it is a gesture size, not a physical distance."
    ),
  delta_y: z
    .number()
    .optional()
    .describe(
      "Vertical scroll in screen pixels; positive scrolls down. Linux/Windows convert it to " +
        "wheel notches (100 px ≈ one notch). A scroll needs a non-zero delta."
    ),
  ms: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_MS)
    .optional()
    .describe("Milliseconds to wait (`wait`) or hold the keys (`hold_key`)."),
  repeat: z
    .number()
    .int()
    .min(1)
    .max(MAX_KEY_REPEAT)
    .optional()
    .describe("For `key`: press the chord this many times (1-100) in one call."),
  modifiers: z
    .array(z.enum(MODIFIER_KEYS))
    .min(1)
    .max(4)
    .optional()
    .describe(
      'Modifier keys for THIS action: ["Control"] to Ctrl+click, ["Shift"] to extend a selection, ' +
        '["Control"] with scroll to zoom. Only Control / Shift / Alt / Meta — for any other key use ' +
        "`key`. On `key` they are attached to the keystroke. A batch entry's own value wins; a " +
        "call-level value applies to every entry that can hold one. On macOS Control+click IS the " +
        "secondary click."
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
        "Set only the fields the action uses — the rest are ignored (a strict provider may require " +
        "them to be present anyway). A call-level `text` / `keys` / `button` applies to EVERY entry " +
        "that reads it, so set them per entry when two entries need different values. A call-level " +
        "`modifiers` applies to every entry that can hold one (`type`/`wait` ignore it — the result " +
        "says so); an entry's own value wins. Coordinates are never shared: each entry names its own " +
        "target."
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
    throw new Error(
      `"${action}" needs x and y, in the screen space the tool description names — not in the pixels ` +
        `of a downscaled image.`
    );
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
  if (!Number.isFinite(input.to_x) || !Number.isFinite(input.to_y)) {
    throw new Error('"drag" needs finite to_x and to_y.');
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
    case "double_click":
    case "triple_click": {
      const point = requirePoint(input, action);
      const count = action === "triple_click" ? 3 : action === "double_click" ? 2 : 1;
      await computer.click(point.x, point.y, { button, count, signal });
      const label = action === "triple_click" ? "triple-click" : action === "double_click" ? "double-click" : "click";
      return `${label} ${point.x},${point.y} ${button}`;
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
      const repeat = input.repeat ?? 1;
      for (let index = 0; index < repeat; index += 1) await computer.press(input.keys, { signal });
      return repeat > 1 ? `press ${input.keys.join("+")} ×${repeat}` : `press ${input.keys.join("+")}`;
    }

    case "hold_key": {
      if (!input.keys || input.keys.length === 0) {
        throw new Error('"hold_key" needs keys, e.g. ["Shift"].');
      }
      const ms = input.ms ?? 1000;
      const pressed: string[] = [];
      try {
        for (const key of input.keys) {
          await computer.keyDown(key, { signal });
          pressed.push(key);
          held.keys.push(key);
        }
        await delay(ms, signal);
        return `hold ${input.keys.join("+")} ${ms}ms`;
      } finally {
        // Released in reverse even on abort, and dropped from `held` so the outer release does not
        // send a second keyUp. A failed release does not change this call's verdict.
        for (const key of [...pressed].reverse()) {
          const index = held.keys.lastIndexOf(key);
          if (index >= 0) held.keys.splice(index, 1);
          try {
            await computer.keyUp(key);
          } catch {
            // Same rule as `releaseHeld`: a release must not mask the action's own outcome.
          }
        }
      }
    }

    case "mouse_down": {
      // A press lands wherever the pointer is (Anthropic's `left_mouse_down` has no coordinate).
      // It used to accept an optional point ("move there first"), but OpenAI's strict tool mode puts
      // EVERY property in `required` and widens optionals to `anyOf: [T, null]`, so the model can
      // only fill `x: 0, y: 0` — and every press jumped to the screen origin before clicking. A
      // hand-built drag now moves first, then presses; `drag` does the interpolated version.
      await computer.mouseDown(button, { signal });
      held.buttons.push(button);
      return `mouse down ${button}`;
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
  // Before ANY guard: an already-cancelled call must keep its abort verdict. The validation guards
  // below are synchronous and would otherwise turn a cancel into a "would fail" error, which the run
  // classifier records as a failure (`signal.aborted` is what makes a tool row neutral).
  signal?.throwIfAborted();
  const batch = input.actions;
  if (batch && batch.length > 0) {
    // A call-level `modifiers` belongs to the gesture the model is describing, so it applies to every
    // entry that can hold one. It used to be inherited by EVERY entry, which failed the batch as soon
    // as one `type` entry refused it (10 of 13 errors in a measured session); refusing the shape
    // outright then turned the natural `{modifiers, actions}` call into a hard error the model
    // repeated. `type`/`wait` cannot hold modifiers, so they run plain and the summary says so.
    const callModifiers = input.modifiers ?? [];

    // The tool has one static timeout, so a batch of maximum-length waits would be cut off from the
    // middle (leaving whatever it pressed). Refuse it up front with a message the model can act on.
    const waits = batch.reduce(
      (total, entry) => total + (entry.action === "wait" || entry.action === "hold_key" ? (entry.ms ?? 1000) : 0),
      0
    );
    if (waits > MAX_BATCH_WAIT_MS) {
      throw new Error(
        `This batch waits ${waits}ms, more than the ${MAX_BATCH_WAIT_MS}ms a single call is allowed. ` +
          `Split it into several calls.`
      );
    }

    // Keys are checked BEFORE the first step runs. A backend validates a key name at the point of
    // the call, which inside a batch is after earlier steps have already moved the pointer and typed
    // — a measured batch typed, waited, and only then failed on `Return`, so the model retried the
    // whole sequence. Only the host knows its backend's key table, hence the optional `validatePress`
    // (a host without it keeps the step-local failure). `keys` also carries the entry's modifiers,
    // which are part of the same chord.
    for (let index = 0; index < batch.length; index += 1) {
      const entry = withInheritedDefaults(batch[index]!, input);
      if (entry.action !== "key" && entry.action !== "hold_key") continue;
      const keys = [...(entry.modifiers ?? []), ...(entry.keys ?? [])];
      if (keys.length === 0) {
        throw new Error(
          `Action #${index + 1} of ${batch.length} (${entry.action}) needs \`keys\`, e.g. ["Control", "c"].`
        );
      }
      if (!computer.validatePress) continue;
      try {
        // Awaited: the contract allows an async implementation, and a rejection that core did not
        // wait for would be an unhandled rejection while the preflight silently "passed".
        await computer.validatePress(keys);
      } catch (error) {
        throw new Error(`Action #${index + 1} of ${batch.length} (${entry.action}) would fail: ${errorMessage(error)}`);
      }
    }

    const summaries: string[] = [];
    for (let index = 0; index < batch.length; index += 1) {
      const entry = withInheritedDefaults(batch[index]!, input);
      try {
        summaries.push(await runWithModifiers(computer, entry, held, signal));
      } catch (error) {
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
    const ignored = batch.filter(
      (entry) => entry.modifiers === undefined && (entry.action === "type" || entry.action === "wait")
    ).length;
    return (
      summaries.join(" → ") +
      (callModifiers.length > 0 && ignored > 0
        ? ` (${callModifiers.join("+")} ignored on ${ignored} ${
            ignored === 1 ? "entry" : "entries"
          } that cannot hold modifiers)`
        : "")
    );
  }
  return runWithModifiers(computer, input, held, signal);
}

/**
 * A batch entry inherits the payload fields it omitted.
 *
 * `text` / `keys` / `button` are inherited, and an inherited value applies to EVERY entry that reads
 * it (two `type` entries with one call-level `text` type it twice). A call-level `modifiers` applies
 * to every entry that can HOLD one: `type` and `wait` cannot, so they run plain and the call's
 * summary names what was ignored, instead of failing the batch (a measured session lost 10 of 13
 * calls to a call-level modifier meeting a `type` entry). An entry's own `modifiers` wins, so a batch
 * can mix a Ctrl+click with a plain one. Coordinates are never inherited — each entry points at its
 * own place, and pointing a second entry at the first one's target is never what was meant.
 */
function withInheritedDefaults(entry: ComputerActionEntry, outer: ComputerActionInput): ComputerActionEntry {
  const merged: ComputerActionEntry = { ...entry };
  if (merged.button === undefined && outer.button !== undefined) merged.button = outer.button;
  if (merged.text === undefined && outer.text !== undefined) merged.text = outer.text;
  if (merged.keys === undefined && outer.keys !== undefined) merged.keys = outer.keys;
  if (
    merged.modifiers === undefined &&
    outer.modifiers !== undefined &&
    merged.action !== "type" &&
    merged.action !== "wait"
  ) {
    merged.modifiers = outer.modifiers;
  }
  return merged;
}
