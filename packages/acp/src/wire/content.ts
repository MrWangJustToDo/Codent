/**
 * Content mapping between ACP `ContentBlock`s and the agent's `ContentPart`s.
 *
 * Inbound  (`session/prompt`): text / image / audio / embedded resource / resource_link.
 * Outbound: agent text as Markdown `ContentBlock::Text`.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ContentPart } from "@tanstack/ai";

/** Negotiated prompt capabilities (subset of the client's declared support). */
export interface PromptCaps {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export interface PromptMapping {
  content: string | ContentPart[];
  /** Set when a block type was refused (unsupported / malformed). */
  error?: string;
}

/**
 * Map an ACP prompt `ContentBlock[]` to `AgentSessionMessageContent`.
 *
 * `image`/`audio` are gated on the negotiated capabilities: a block whose kind
 * was not advertised is a hard error (returned as `error`) rather than silently
 * dropped. `resource` (embedded) and `resource_link` become text context.
 */
export function promptBlocksToContent(blocks: ContentBlock[], caps: PromptCaps): PromptMapping {
  const parts: ContentPart[] = [];
  // Parts are appended in the client's block order. The previous implementation collected text
  // separately and prepended it, so `[text, image, text]` reached the model as `text+text, image` —
  // the model read a paragraph the user had placed after the screenshot before seeing the image.
  let hasNonText = false;

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", content: block.text });
        break;
      case "image":
        if (!caps.image) return { content: "", error: "image prompts are not supported by this agent" };
        hasNonText = true;
        parts.push({
          type: "image",
          source: { type: "data", value: block.data, mimeType: block.mimeType },
        });
        break;
      case "audio":
        if (!caps.audio) return { content: "", error: "audio prompts are not supported by this agent" };
        hasNonText = true;
        parts.push({
          type: "audio",
          source: { type: "data", value: block.data, mimeType: block.mimeType },
        });
        break;
      case "resource": {
        if (!caps.embeddedContext) {
          return { content: "", error: "embedded resource prompts are not supported by this agent" };
        }
        const res = block.resource;
        if ("text" in res && typeof res.text === "string") {
          parts.push({ type: "text", content: `<resource uri="${res.uri}">\n${res.text}\n</resource>` });
        } else if ("blob" in res && typeof res.blob === "string") {
          hasNonText = true;
          parts.push({
            type: "document",
            source: {
              type: "data",
              value: res.blob,
              ...(res.mimeType ? { mimeType: res.mimeType } : { mimeType: "application/octet-stream" }),
            },
          });
        }
        break;
      }
      case "resource_link":
        parts.push({ type: "text", content: `[resource: ${block.name} <${block.uri}>]` });
        break;
      default:
        // Unknown block kind (newer ACP): keep it as inert text rather than dropping.
        parts.push({
          type: "text",
          content: `[unsupported content block: ${(block as { type?: string }).type ?? "unknown"}]`,
        });
        break;
    }
  }

  // A text-only prompt keeps the string form (the session API accepts it, and the model wire is
  // smaller). Multiple text blocks join exactly as before; the order is already the client's.
  if (!hasNonText) {
    const text = parts.map((part) => (part.type === "text" ? part.content : "")).join("\n\n");
    return { content: text };
  }
  // Media with no words around it (paste a screenshot, press enter) reaches the model as a picture
  // and nothing to answer. Every host that has a text box solves this at the input layer — the app
  // writes `[Image #N: file]` into the submitted text — but an ACP client sends the block on its
  // own, and a model given only an image frequently answers with nothing, which the run then reports
  // as an empty reply (the empty assistant shell is stripped), i.e. the client sees a turn that ends
  // with no output at all. One instruction is what turns that into an answer, and it states exactly
  // what the user did, so the model is not misled about a question that was never asked.
  if (!parts.some((part) => part.type === "text" && part.content.trim().length > 0)) {
    parts.push({ type: "text", content: MEDIA_ONLY_INSTRUCTION });
  }
  return { content: parts };
}

/**
 * What a media-only prompt says to the model.
 *
 * Bracket-notation, like the app's own synthesized refs for attachments (`[Image #N: file]`) and for
 * resources (`[resource: …]`): the sentence is persisted with the message, so a client that reloads
 * the session renders it inside the user's turn — and a note in brackets reads as a note rather than
 * as words the user typed.
 *
 * Not a fabricated question: it names the situation (an attachment, no message) and the two things
 * sending it can mean. Kept as one exported constant so the wording lives in one place and a test can
 * assert exactly what the model was told.
 */
export const MEDIA_ONLY_INSTRUCTION =
  "[Attachment sent without a message. Look at it: describe what it shows, and if the intent is " +
  "clear — an error message, a failing test, a broken UI — act on it.]";

/** Outbound agent text as a Markdown content block. */
export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}
