/**
 * Validates MCP multimodal content preference (structuredContent vs content[] images).
 *
 * Run: pnpm --filter @codent/core run validate:mcp-prefer-multimodal
 */

import assert from "node:assert/strict";

import { mcpContentHasMultimodal, mcpContentToTanstack, resolveMcpToolExecuteResult } from "../dist/dev.mjs";

assert.equal(mcpContentHasMultimodal([{ type: "text", text: "hi" }]), false);
assert.equal(
  mcpContentHasMultimodal([
    { type: "image", data: "abc", mimeType: "image/jpeg" },
    { type: "text", text: "cap" },
  ]),
  true
);

const textOnly = mcpContentToTanstack([{ type: "text", text: "hello" }]);
assert.equal(textOnly, "hello");

const withImage = mcpContentToTanstack([
  { type: "image", data: "base64data", mimeType: "image/jpeg" },
  { type: "text", text: "Screenshot captured: 1024x640, 77KB" },
]);
assert.ok(Array.isArray(withImage));
assert.equal(withImage[0].type, "image");
assert.equal(withImage[0].source.value, "base64data");
assert.equal(withImage[1].type, "text");

// Prefer content[] when multimodal is present, even if structuredContent exists.
const multimodalResult = resolveMcpToolExecuteResult("screenshot", {
  structuredContent: { width: 1024, height: 640, sizeKB: 77 },
  content: [
    { type: "image", data: "img", mimeType: "image/jpeg" },
    { type: "text", text: "Screenshot captured: 1024x640, 77KB" },
  ],
});
assert.ok(Array.isArray(multimodalResult));
assert.equal(multimodalResult[0].type, "image");

// Text-only tools still prefer structuredContent.
const structuredResult = resolveMcpToolExecuteResult("meta_tool", {
  structuredContent: { ok: true, count: 2 },
  content: [{ type: "text", text: "ok" }],
});
assert.deepEqual(structuredResult, { ok: true, count: 2 });

// No structuredContent → content path.
const contentOnly = resolveMcpToolExecuteResult("plain", {
  content: [{ type: "text", text: "done" }],
});
assert.equal(contentOnly, "done");

let threw = false;
try {
  resolveMcpToolExecuteResult("bad", {
    isError: true,
    content: [{ type: "text", text: "boom" }],
  });
} catch (error) {
  threw = true;
  assert.ok(error instanceof Error);
  assert.match(error.message, /boom/);
}
assert.equal(threw, true);

// ============================================================================
// Non-image blocks: audio, video, and `resource` blobs
// ============================================================================
//
// These used to fall through to `JSON.stringify(block)` — the base64 arrived as model-visible text
// AND stayed inline in the session log, where nothing in the persistence walk could reach it
// (only ContentPart[] media is dehydrated).

const AUDIO_B64 = "YXVkaW9ieXRlc2F1ZGlvYnl0ZXM=";
const VIDEO_B64 = "dmlkZW9ieXRlc3ZpZGVvYnl0ZXM=";
const PDF_B64 = "cGRmYnl0ZXNwZGZieXRlcw==";
const ZIP_B64 = "emlwYnl0ZXN6aXBieXRlcw==";

const withAudio = mcpContentToTanstack([{ type: "audio", data: AUDIO_B64, mimeType: "audio/wav" }]);
assert.ok(Array.isArray(withAudio));
assert.equal(withAudio[0].type, "audio");
assert.deepEqual(withAudio[0].source, { type: "data", value: AUDIO_B64, mimeType: "audio/wav" });

const withVideo = mcpContentToTanstack([{ type: "video", data: VIDEO_B64, mimeType: "video/mp4" }]);
assert.ok(Array.isArray(withVideo));
assert.equal(withVideo[0].type, "video");
assert.equal(withVideo[0].source.value, VIDEO_B64);

// A `resource` blob a model can take becomes a media part of the matching type, paired with a line
// naming the file (a host with no viewer for that modality must still render something).
const pdfResource = mcpContentToTanstack([
  { type: "resource", resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: PDF_B64 } },
]);
assert.ok(Array.isArray(pdfResource));
assert.equal(pdfResource.length, 2);
assert.equal(pdfResource[0].type, "text");
assert.match(pdfResource[0].content, /file:\/\/\/report\.pdf/);
assert.equal(pdfResource[1].type, "document");
assert.deepEqual(pdfResource[1].source, { type: "data", value: PDF_B64, mimeType: "application/pdf" });

const imageResource = mcpContentToTanstack([
  { type: "resource", resource: { uri: "file:///shot.png", mimeType: "image/png", blob: AUDIO_B64 } },
]);
assert.ok(Array.isArray(imageResource));
assert.equal(imageResource[1].type, "image");

const audioResource = mcpContentToTanstack([
  { type: "resource", resource: { uri: "file:///clip.wav", mimeType: "audio/wav", blob: AUDIO_B64 } },
]);
assert.ok(Array.isArray(audioResource));
assert.equal(audioResource[1].type, "audio");

// A blob no modality accepts is described, not inlined: the payload must not reach the transcript.
const zipResource = mcpContentToTanstack([
  { type: "resource", resource: { uri: "file:///bundle.zip", mimeType: "application/zip", blob: ZIP_B64 } },
]);
assert.ok(Array.isArray(zipResource));
assert.equal(zipResource[0].type, "text");
assert.equal(JSON.stringify(zipResource).includes(ZIP_B64), false, "an unsendable blob must not be inlined as text");
assert.match(zipResource[0].content, /file:\/\/\/bundle\.zip/);
assert.match(zipResource[0].content, /application\/zip/);

// SVG is not an image part (providers do not render it) and not a document either.
const svgResource = mcpContentToTanstack([
  { type: "resource", resource: { uri: "file:///logo.svg", mimeType: "image/svg+xml", blob: ZIP_B64 } },
]);
assert.ok(Array.isArray(svgResource));
assert.equal(svgResource[0].type, "text");
assert.equal(JSON.stringify(svgResource).includes(ZIP_B64), false);
assert.match(svgResource[0].content, /image\/svg\+xml/);

// A text resource keeps the readable JSON form; a ui:// resource is still omitted.
const textResource = mcpContentToTanstack([
  { type: "resource", resource: { uri: "file:///a.txt", mimeType: "text/plain", text: "hello" } },
]);
assert.ok(Array.isArray(textResource));
assert.equal(textResource[0].type, "text");
assert.deepEqual(JSON.parse(textResource[0].content), { uri: "file:///a.txt", mimeType: "text/plain", text: "hello" });

assert.equal(
  mcpContentToTanstack([{ type: "resource", resource: { uri: "ui://app/index.html", text: "<html/>" } }]),
  "",
  "an MCP-UI resource is not model content"
);

// A block whose length alone would make it single-text still loses to content[] when it is a blob:
// `resource` counts as multimodal, so structuredContent must not displace the file.
const blobOverStructured = resolveMcpToolExecuteResult("files", {
  structuredContent: { ok: true },
  content: [{ type: "resource", resource: { uri: "file:///r.pdf", mimeType: "application/pdf", blob: PDF_B64 } }],
});
assert.ok(Array.isArray(blobOverStructured));
assert.equal(blobOverStructured[1].type, "document");

// ============================================================================
// Malformed and unknown blocks: described, never dropped and never inlined
// ============================================================================

// A block with no `mimeType` is malformed (the spec requires it). It used to be dropped silently for
// audio/video — the model lost the payload with no trace of why.
const audioNoMime = mcpContentToTanstack([{ type: "audio", data: AUDIO_B64 }]);
assert.ok(Array.isArray(audioNoMime));
assert.equal(audioNoMime.length, 1, "a mimeType-less audio block is described, not dropped");
assert.equal(audioNoMime[0].type, "text");
assert.equal(JSON.stringify(audioNoMime).includes(AUDIO_B64), false);
assert.match(audioNoMime[0].content, /Audio not inlined/);

// An `image` block carrying SVG: providers do not render it as an image, and no provider takes it as
// a document — same rule as a `resource` blob, so the two paths cannot disagree.
const svgImageBlock = mcpContentToTanstack([{ type: "image", data: ZIP_B64, mimeType: "image/svg+xml" }]);
assert.ok(Array.isArray(svgImageBlock));
assert.equal(svgImageBlock[0].type, "text");
assert.equal(JSON.stringify(svgImageBlock).includes(ZIP_B64), false);
assert.match(svgImageBlock[0].content, /image\/svg\+xml/);

// An `image` block whose MIME contradicts its own type (a PDF in an image block): describe rather
// than send a part the endpoint rejects.
const mismatchedBlock = mcpContentToTanstack([{ type: "image", data: PDF_B64, mimeType: "application/pdf" }]);
assert.equal(mismatchedBlock[0].type, "text");
assert.equal(JSON.stringify(mismatchedBlock).includes(PDF_B64), false);

// A block type this runtime does not know keeps its JSON form when it is metadata-only…
const unknownMeta = mcpContentToTanstack([{ type: "resource_link", uri: "file:///a.txt" }]);
assert.ok(Array.isArray(unknownMeta));
assert.match(unknownMeta[0].content, /resource_link/);
// …but a base64 payload is described, because JSON text would put the bytes in the transcript and in
// the session log, where no media walk can reach them.
const unknownWithData = mcpContentToTanstack([{ type: "embed", data: ZIP_B64, mimeType: "application/zip" }]);
assert.ok(Array.isArray(unknownWithData));
assert.equal(JSON.stringify(unknownWithData).includes(ZIP_B64), false);
assert.match(unknownWithData[0].content, /Embed not inlined/);
assert.match(unknownWithData[0].content, /application\/zip/);

// A resource carrying both `text` and `blob` (malformed per spec) keeps the readable half.
const bothForms = mcpContentToTanstack([
  { type: "resource", resource: { uri: "file:///r.pdf", mimeType: "application/pdf", text: "caption", blob: PDF_B64 } },
]);
assert.ok(Array.isArray(bothForms));
assert.equal(bothForms[0].type, "text");
assert.match(bothForms[0].content, /file:\/\/\/r\.pdf/);
assert.equal(bothForms[1].content, "caption", "the text half survives next to the media part");
assert.equal(bothForms[2].type, "document");

// …and the text half survives next to an UNSENDABLE blob too: an unsupported payload costs the
// bytes, not the readable explanation of what the file is.
const bothFormsUnsendable = mcpContentToTanstack([
  {
    type: "resource",
    resource: { uri: "file:///b.zip", mimeType: "application/zip", text: "release bundle", blob: ZIP_B64 },
  },
]);
assert.ok(Array.isArray(bothFormsUnsendable));
assert.equal(bothFormsUnsendable.length, 2);
assert.equal(bothFormsUnsendable[0].type, "text");
assert.match(bothFormsUnsendable[0].content, /file:\/\/\/b\.zip/);
assert.equal(bothFormsUnsendable[1].content, "release bundle", "the text half survives an unsendable blob");
assert.equal(JSON.stringify(bothFormsUnsendable).includes(ZIP_B64), false, "the unsendable bytes stay out");

// An error result must not smuggle the base64 into the thrown message — that message is the tool's
// persisted error string, so it is exactly where the bytes must not end up.
let binaryErrorThrown = false;
try {
  resolveMcpToolExecuteResult("broken", {
    isError: true,
    content: [
      { type: "text", text: "failed to capture" },
      { type: "image", data: ZIP_B64, mimeType: "image/png" },
    ],
  });
} catch (error) {
  binaryErrorThrown = true;
  assert.match(error.message, /failed to capture/);
  assert.equal(error.message.includes(ZIP_B64), false, "an error message carries no media payload");
  assert.match(error.message, /\[image not inlined\]/);
}
assert.equal(binaryErrorThrown, true);

console.log("mcp-prefer-multimodal validation passed");
