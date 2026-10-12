import { tool, z } from "@cyanheads/mcp-ts-core";
import screenshot from "screenshot-desktop";
import sharp from "sharp";

import type { ContentBlock } from "@cyanheads/mcp-ts-core";

const MAX_WIDTH = 1024;
const JPEG_QUALITY = 80;

/** Holds the last captured image for format() without duplicating in structuredContent. */
let lastCapturedImage = "";

async function resolveScreenId(requested?: number): Promise<number | undefined> {
  const displays = await screenshot.listDisplays();
  if (displays.length === 0) {
    return undefined;
  }

  const primaryId = displays.find((display) => display.primary)?.id ?? displays[0].id;

  if (requested === undefined) {
    return primaryId;
  }

  if (displays.some((display) => display.id === requested)) {
    return requested;
  }

  // Agents often pass 1-based screen numbers (e.g. screen=1 for the first display).
  const oneBasedMatch = displays[requested - 1];
  if (oneBasedMatch) {
    return oneBasedMatch.id;
  }

  return primaryId;
}

export const screenshotTool = tool("screenshot", {
  description: "Capture a screenshot of the current screen. The image is resized and compressed to reduce token usage.",
  input: z.object({
    screen: z
      .number()
      .int()
      .optional()
      .describe(
        "Display to capture. Accepts the display ID from listDisplays() or a 1-based index (1 = first display). Omit to capture the primary display."
      ),
  }),
  output: z.object({
    width: z.number().describe("Image width in pixels (0 when capture failed)"),
    height: z.number().describe("Image height in pixels (0 when capture failed)"),
    sizeKB: z.number().describe("Compressed image size in KB (0 when capture failed)"),
    errorText: z.string().optional().describe("Error message when screenshot capture failed (errorText, not error)"),
  }),
  annotations: {
    title: "Screenshot",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  async handler(input) {
    lastCapturedImage = "";

    try {
      const screenId = await resolveScreenId(input.screen);
      const options: { format: "png"; screen?: number } = { format: "png" };
      if (screenId !== undefined) {
        options.screen = screenId;
      }

      const rawBuffer: Buffer = await screenshot(options);

      const compressed = await sharp(rawBuffer)
        .resize({ width: MAX_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();

      const metadata = await sharp(compressed).metadata();
      lastCapturedImage = compressed.toString("base64");

      return {
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
        sizeKB: Math.round(compressed.length / 1024),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        width: 0,
        height: 0,
        sizeKB: 0,
        errorText: message,
      };
    }
  },
  format: (result): ContentBlock[] => {
    if (result.errorText) {
      return [{ type: "text" as const, text: `Screenshot failed: ${result.errorText}` }];
    }

    return [
      {
        type: "image" as const,
        data: lastCapturedImage,
        mimeType: "image/jpeg",
      },
      {
        type: "text" as const,
        text: `Screenshot captured: ${result.width}x${result.height}, ${result.sizeKB}KB`,
      },
    ];
  },
});
