/**
 * Built-in computer-use extension — a provider-agnostic view of, and hand on, the real screen.
 *
 * Nothing here asks a provider for a native "computer" tool. The capability is `tool call + vision`,
 * which every capable model already has, and the screen itself comes from the host through
 * `CoreEnv.computer`. Two consequences worth stating, because they are the design:
 *
 * - **Presence is the feature test.** `createNodeComputer()` returns `null` when the optional native
 *   addon is missing, there is no display server, or the OS refused the connection; bootstrap then
 *   never loads this extension, so a host that cannot see a screen advertises no screen tools.
 * - **Two tools, not one, because approval is per tool.** `needsApproval` is a static boolean in both
 *   the SDK and core's registry (a per-call predicate does not exist), so a single mixed tool could
 *   only be all-free or all-prompted. Splitting read (`computer_screenshot`) from write (`computer`)
 *   is what makes "looking is free, acting asks" expressible — and it also gives plan mode the right
 *   boundary for free, since the write tool declares `category: "edits"` and is withheld there.
 *
 * Screenshot history is capped (default 3, newest kept) by a message transformer: every action
 * returns a fresh screenshot, so without a cap a 20-step task would carry 20 full-screen images and
 * blow both the context window and the prompt cache. The transformer is wire-only, so the session
 * keeps its full transcript and only the model's view is trimmed.
 */
import { z } from "zod";

import { BUILTIN_EXTENSION_ORDER } from "../dispatch-order.js";
import { parseStringifiedMultimodalContent } from "../media/repair-stringified-multimodal.js";
import { isProjectedModelContent } from "../tools/runtime/projected-model-content.js";

import {
  DEFAULT_SETTLE_MS,
  computerActionSchema,
  delay,
  performComputerAction,
  type ComputerActionInput,
} from "./actions.js";
import { SCREENSHOT_MARKER, captureScreen, screenModelParts, type ScreenToolOutput } from "./screenshot.js";

import type { CoreEnvComputer, CoreEnvImageRegion } from "../../env";
import type { ExtensionAPI } from "../extension/types.js";
import type { ContentPart, ModelMessage } from "@tanstack/ai";

/** How many screenshots stay as images before older ones are replaced with a text stub. */
const DEFAULT_SCREENSHOT_HISTORY = 3;

/** Tool name of the read half (no approval). */
export const COMPUTER_SCREENSHOT_TOOL = "computer_screenshot";
/** Tool name of the write half (approval required). */
export const COMPUTER_ACTION_TOOL = "computer";

/** Text that replaces a screenshot image the model no longer needs to see again. */
const ELIDED_SCREENSHOT = `${SCREENSHOT_MARKER} (earlier screenshot removed to save context)`;

export interface ComputerUseExtensionConfig {
  /**
   * How many screenshots stay visible to the model. Older ones keep their text line and lose the
   * image. Default 3: enough to reason about "before, after, now", few enough that a long session
   * does not carry a wall of full-screen images.
   */
  screenshotHistory?: number;
  /** Delay after an action before the screenshot is taken, so the UI has settled. Default 400 ms. */
  settleMs?: number;
}

/**
 * Create the built-in computer-use extension for a host that can drive its screen.
 *
 * @example
 * // bootstrap: only when the host reports the capability
 * if (config.computerUse !== false && env.computer) {
 *   await extensionRunner.loadExtension(createComputerUseExtension(env.computer));
 * }
 */
export function createComputerUseExtension(
  computer: CoreEnvComputer,
  config: ComputerUseExtensionConfig = {}
): ExtensionAPI {
  // `Number.isFinite` first: `Math.max(1, Math.trunc(NaN))` is still `NaN`, and `slice(-NaN)` is
  // `slice(0)` — the cap would silently keep every screenshot instead of failing loudly.
  const history = Number.isFinite(config.screenshotHistory)
    ? Math.max(1, Math.trunc(config.screenshotHistory as number))
    : DEFAULT_SCREENSHOT_HISTORY;
  const settleMs = Number.isFinite(config.settleMs) ? Math.max(0, config.settleMs as number) : DEFAULT_SETTLE_MS;
  const { width, height } = computer.display;
  const space = `The screen is ${width}x${height} pixels, which is exactly the size of the screenshots you see.`;

  return {
    id: "codent-computer-use",
    name: "Computer use",
    version: "1.0.0",
    description: "See and control the user's real screen: screenshots, mouse, keyboard.",
    order: BUILTIN_EXTENSION_ORDER,

    activate(ctx) {
      ctx.registerTool({
        name: COMPUTER_SCREENSHOT_TOOL,
        description:
          `Take a screenshot of the user's screen and look at it. ${space} ` +
          `Use "zoom" to read small text at full resolution — the result is magnified, and ` +
          `coordinates stay in the ${width}x${height} screen space. ` +
          `This does not change anything on the screen.`,
        inputSchema: z.object({
          zoom: z
            .object({
              x: z.number().describe("Left edge, in screenshot pixels."),
              y: z.number().describe("Top edge, in screenshot pixels."),
              width: z.number().describe("Region width, in screenshot pixels."),
              height: z.number().describe("Region height, in screenshot pixels."),
            })
            .optional()
            .describe("Capture only this region, at full resolution."),
        }),
        timeoutMs: 20_000,
        present: {
          category: "reads",
          keepRow: true,
          text: (output) => (output as ScreenToolOutput | undefined)?.summary ?? "screenshot",
        },
        toModelOutput: ({ output }) =>
          isProjectedModelContent(output) ? output : screenModelParts(output as ScreenToolOutput),
        execute: async (input, options) => {
          const captured = await captureScreen(
            ctx.coreEnv,
            computer,
            (input as { zoom?: CoreEnvImageRegion }).zoom,
            options.abortSignal
          );
          if (!captured) throw new Error("The screen could not be captured on this host.");
          return toToolOutput(captured, computer, captured.summary);
        },
      });

      ctx.registerTool({
        name: COMPUTER_ACTION_TOOL,
        description:
          `Control the user's real mouse and keyboard: ${computer.environment}. ${space} ` +
          `Every coordinate is a pixel in the screenshot you last saw; (0,0) is its top-left. ` +
          `Each call returns a fresh screenshot of the result. ` +
          `Look before you act (${COMPUTER_SCREENSHOT_TOOL}), and prefer keyboard shortcuts over ` +
          `clicking coordinates when you can. ` +
          `Use \`modifiers\` for a held key (Ctrl+click, Shift+click, Ctrl+scroll) and \`actions\` to ` +
          `batch a sure sequence into ONE call — a batch is one approval and one screenshot. ` +
          `If a drag does not register, retry it with \`steps\` so the pointer travels. ` +
          `The user approves each call.`,
        inputSchema: computerActionSchema,
        // Static by design: the SDK's engine stamps the approval, so a per-action predicate cannot
        // exist. This is why looking and acting are two tools.
        needsApproval: true,
        // Above the batch budget (`MAX_BATCH_WAIT_MS` 20 s) plus the actions themselves: a timeout
        // here does not just fail the call, it can strand a held modifier or button mid-sequence.
        timeoutMs: 60_000,
        present: {
          category: "edits",
          text: (output) => (output as ScreenToolOutput | undefined)?.summary ?? "screen action",
        },
        toModelOutput: ({ output }) =>
          isProjectedModelContent(output) ? output : screenModelParts(output as ScreenToolOutput),
        execute: async (input, options) => {
          const summary = await performComputerAction(computer, input as ComputerActionInput, options.abortSignal);
          // A UI that has not repainted yet makes the screenshot lie about the result.
          await delay(settleMs, options.abortSignal);
          const captured = await captureScreen(ctx.coreEnv, computer, undefined, options.abortSignal);
          const joined = captured ? `${summary} — ${captured.summary}` : summary;
          return captured
            ? toToolOutput(captured, computer, joined)
            : { summary: joined, display: computer.display, environment: computer.environment };
        },
      });

      ctx.registerMessageTransformer((c) => capScreenshotHistory(c.messages, history, c.modelHasVision));
    },
  };
}

/** Shape one capture as tool output (what `present.text` reads and `toModelOutput` projects). */
function toToolOutput(
  captured: { summary: string; base64: string; mimeType: string; region?: CoreEnvImageRegion },
  computer: CoreEnvComputer,
  summary: string
): ScreenToolOutput {
  return {
    summary,
    display: computer.display,
    environment: computer.environment,
    base64: captured.base64,
    mimeType: captured.mimeType,
    ...(captured.region ? { region: captured.region } : {}),
  };
}

// ============================================================================
// Screenshot budget
// ============================================================================

/**
 * Keep the newest `history` screenshots and blind the older ones.
 *
 * Identification is by the text marker our own projection writes, not by tool-call id: the wire is
 * rebuilt from the persisted transcript on resume, where an id set held in memory is empty and every
 * old screenshot would be re-sent at full size.
 */
export function capScreenshotHistory(
  messages: ModelMessage[],
  history: number,
  modelHasVision: boolean
): ModelMessage[] {
  const ours: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const content = readParts(messages[i]);
    if (content && isScreenshotContent(content)) ours.push(i);
  }
  if (ours.length === 0) return messages;

  const keep = new Set(ours.slice(-history));
  let changed = false;
  const next = messages.map((message, index) => {
    if (!ours.includes(index)) return message;
    if (modelHasVision && keep.has(index)) return message;
    changed = true;
    return stripMessageImages(message);
  });
  return changed ? next : messages;
}

/** The parts of a tool message, whether they arrived as an array or as TanStack's JSON string. */
function readParts(message: ModelMessage): ContentPart[] | null {
  if (message.role !== "tool") return null;
  const { content } = message;
  if (Array.isArray(content)) return content as ContentPart[];
  if (typeof content === "string") {
    const parsed = parseStringifiedMultimodalContent(content);
    return parsed ? (parsed as unknown as ContentPart[]) : null;
  }
  return null;
}

function isScreenshotContent(parts: ContentPart[]): boolean {
  return parts.some(
    (part) =>
      part?.type === "text" &&
      typeof (part as { content?: unknown }).content === "string" &&
      ((part as { content: string }).content.startsWith(SCREENSHOT_MARKER) ||
        (part as { content: string }).content === ELIDED_SCREENSHOT)
  );
}

/**
 * Drop the images from a screenshot result, keeping its text line.
 *
 * The content KEEPS ITS FORM: string `tool` content stays a string (that is the only shape Chat
 * Completions accepts, and an array here would hand the adapter something it must re-stringify),
 * while an array stays an array.
 */
function stripMessageImages(message: ModelMessage): ModelMessage {
  const kept = (readParts(message) ?? []).filter((part) => part?.type !== "image");
  const hasElision = kept.some(
    (part) => part?.type === "text" && (part as { content?: unknown }).content === ELIDED_SCREENSHOT
  );
  const parts: ContentPart[] = hasElision ? kept : [...kept, { type: "text", content: ELIDED_SCREENSHOT }];
  const content = typeof message.content === "string" ? JSON.stringify(parts) : parts;
  return { ...message, content } as ModelMessage;
}
