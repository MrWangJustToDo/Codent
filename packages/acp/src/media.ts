/**
 * A tool result's bytes, on their way to the client.
 *
 * ACP's `ContentBlock` is `text | image | audio | resource_link | embedded_resource`, and for a long time
 * this host sent only `text`. The bytes were never missing — they were in the result — but they arrive
 * through one of TWO doors whose shapes disagree, and a reader that knows only one door shows the other
 * as nothing at all:
 *
 * - `part.output` is the tool's OWN return value. `read_file` returns an object
 *   (`{ type: "image", base64, mimeType }`); `webfetch` returns an array (`[{ type: "text" }, { type:
 *   "image", source }]`).
 * - `part.content` is the model-facing projection of it: a `ContentPart[]` while the run is live, and a
 *   JSON **string** of that array once the session is persisted — core's `hydrateToolResultContent`
 *   returns `JSON.stringify(parts)`, so a replayed result is NEVER an array.
 *
 * This module owns the reading, so the two shapes (and the dedupe between them) have one definition
 * rather than one per writer.
 */

import { extractBase64Content } from "@codent/core";

import { tryParseJson } from "./tools.js";

import type { ContentBlock } from "@agentclientprotocol/sdk";

/**
 * An image part as ACP's `image` content block, or undefined when this part is not one.
 *
 * Two shapes reach us: a tool result carries the bytes (`{ base64, mimeType }`), while a message part
 * carries `source.value` — a data URL once the session has hydrated it, and only a `media://` ref before
 * that (which this layer cannot read; a reader that has neither gets nothing rather than a broken image).
 * Stripping the data-URL prefix is core's `extractBase64Content`, because parsing a data URL is a helper
 * we keep in one place.
 */
function imageBlockOf(part: unknown): ContentBlock | undefined {
  const rec = part as {
    type?: string;
    base64?: string;
    mimeType?: string;
    source?: { value?: string; mimeType?: string };
  };
  if (rec?.type !== "image") return undefined;
  const raw =
    typeof rec.base64 === "string" ? rec.base64 : typeof rec.source?.value === "string" ? rec.source.value : undefined;
  if (!raw || raw.startsWith("media://")) return undefined;
  return {
    type: "image",
    data: extractBase64Content(raw),
    mimeType: rec.mimeType ?? rec.source?.mimeType ?? "image/png",
  };
}

/**
 * Every image in a model-facing part list, in order.
 *
 * A no-op for anything that is not a list, because the caller hands it whatever the wire happened to
 * carry (`output` may be an object, a string, an array, or absent).
 */
export function imagesOfParts(parts: unknown): ContentBlock[] {
  if (!Array.isArray(parts)) return [];
  return parts.map((part) => imageBlockOf(part)).filter((block): block is ContentBlock => Boolean(block));
}

/**
 * Every image a tool call produced, in the order it produced them.
 *
 * Both doors are walked, and `output` is read first: it is the tool's own value, it exists from the first
 * snapshot that carries a result, and on a live run the two doors hold the SAME image — deduping by
 * payload is what keeps one screenshot from arriving twice.
 */
export function imagesOfResult(output: unknown, content: unknown): ContentBlock[] {
  const found: ContentBlock[] = [];
  const seen = new Set<string>();
  const collect = (block: ContentBlock | undefined): void => {
    if (!block || block.type !== "image" || seen.has(block.data)) return;
    seen.add(block.data);
    found.push(block);
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const block = imageBlockOf(value);
    if (block) {
      collect(block);
      return;
    }
    // An envelope that wraps the parts (`{ content: [...] }`) is not itself a part.
    const wrapped = (value as { content?: unknown } | null)?.content;
    if (wrapped !== undefined && wrapped !== value) visit(wrapped);
  };
  visit(output);
  visit(typeof content === "string" ? tryParseJson(content) : content);
  return found;
}
