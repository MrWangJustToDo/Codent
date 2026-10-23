import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { getServerEnv } from "../server-runtime.js";

import type { ResolvedCoreEnv } from "@codent/core";

/**
 * Ceiling on the encoded request body.
 *
 * The client downscales anything over 2 MB before asking, so a legitimate preview is a few KB to a
 * few hundred KB. This bound exists for callers that are not our client: the route decodes and hands
 * bytes to `sharp`, and an unbounded body is unbounded memory in the server.
 */
const MAX_ENCODED_BYTES = 24_000_000;

const imageTextSchema = z.object({
  /** Base64 of the image bytes. */
  data: z.string().max(MAX_ENCODED_BYTES),
  /**
   * Cell budget. Deliberately NOT bounded here: the host clamps it (`@codent/node` floors it to
   * `[1, 200]`), and a 400 rejecting what a local host renders would make the same picture preview
   * on one plane and "Cannot preview" on the other. `z.number()` still refuses NaN/Infinity.
   */
  maxCols: z.number(),
  maxRows: z.number(),
  color: z.boolean().optional(),
  /**
   * Source-pixel window for zoom/pan. Passed through untrimmed: the host owns clamping, and it
   * reports back the window it actually rendered, so the client never guesses what happened.
   */
  region: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number().positive(),
      height: z.number().positive(),
    })
    .optional(),
});

/**
 * Image → terminal text, for the workspace preview pane.
 *
 * A separate route (rather than a `fs` verb) because it is not a filesystem operation: the client
 * already holds the bytes, and the server's only job is decoding them with whatever codec this host
 * has. Both "this host has no decoder" and "the bytes are not an image" answer `result: null` — the
 * caller renders its placeholder either way, and a 5xx here would read as a broken panel.
 *
 * The env is resolved per request through `getEnv`, defaulting to the server runtime's — the same
 * shape `providerRoutes` uses. It is a parameter so a validator can pin the "host has no decoder"
 * branch, which a Node-hosted server can never reach (its env always defines the member and degrades
 * to `null` internally instead).
 */
export function createImageRoutes(getEnv: () => ResolvedCoreEnv = getServerEnv) {
  return new Hono().post("/text", zValidator("json", imageTextSchema), async (c) => {
    const { data, maxCols, maxRows, color, region } = c.req.valid("json");
    const env = getEnv();
    if (!env.imageToText) return c.json({ result: null });
    try {
      const result = await env.imageToText(env.base64Decode(data), {
        // Clamped here as well as in the host so the JSON response can never be sized by a caller
        // that asks for 100k columns; a real host clamps to the same numbers.
        maxCols: clampCellCount(maxCols, MAX_PREVIEW_COLS),
        maxRows: clampCellCount(maxRows, MAX_PREVIEW_COLS),
        ...(color === undefined ? {} : { color }),
        ...(region === undefined ? {} : { region }),
      });
      return c.json({ result });
    } catch {
      return c.json({ result: null });
    }
  });
}

export const imageRoutes = createImageRoutes();

/** Cell budget ceiling, matching what the host decodes (`@codent/node` clamps at 200). */
const MAX_PREVIEW_COLS = 200;

/** Positive integer cell count, floored to 1 and capped — the same rule the host applies. */
function clampCellCount(value: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(max, Math.max(1, Math.floor(value)));
}
