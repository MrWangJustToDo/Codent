/**
 * Validation for `execute_typescript` model shaping.
 *
 * `external_*` bindings call a tool's RAW execute, so media (e.g. `read_file` on an image) reaches
 * the sandbox as `{ type: "image", base64, … }` and a script that returns it reaches the wire as
 * `{ success, result: { …base64… } }`. Without a projection the base64 stays plain text: the model
 * cannot see the image and re-sends it every turn. This asserts the media is lifted back into
 * `ContentPart[]`, and that everything else keeps its JSON shape.
 *
 * Run: pnpm --filter @codent/core run validate:code-mode-model-output
 */

import assert from "node:assert/strict";

import { projectCodeModeModelOutput } from "../dist/dev.mjs";

const image = {
  type: "image",
  path: ".agents/media/a.png",
  mimeType: "image/png",
  base64: "aW1hZ2U=",
  size: 2048,
};

// 1. Image envelope -> [text, image], base64 only inside the part.
{
  const out = projectCodeModeModelOutput({ success: true, result: image, logs: [] });
  assert.ok(Array.isArray(out), "an image result is projected to ContentPart[]");
  assert.equal(out[0].type, "text");
  assert.match(out[0].content, /Image read: .agents\/media\/a\.png/);
  assert.equal(out[1].type, "image");
  assert.equal(out[1].source.value, image.base64);
  assert.ok(!JSON.stringify(out[0]).includes(image.base64), "the text part must not carry base64");
}

// 2. PDF envelope -> [text(+extracted text), document].
{
  const out = projectCodeModeModelOutput({
    success: true,
    result: { type: "pdf", path: "a.pdf", base64: "cGRm", size: 1000, extractedText: "Chapter 1", pageCount: 2 },
  });
  assert.ok(Array.isArray(out));
  assert.match(out[0].content, /Chapter 1/);
  assert.equal(out[1].type, "document");
  assert.equal(out[1].source.mimeType, "application/pdf");
}

// 3. A script returning several read_file results lifts each media entry.
{
  const out = projectCodeModeModelOutput({
    success: true,
    result: [image, { type: "text", path: "a.ts", content: "1: x" }],
  });
  assert.ok(Array.isArray(out));
  assert.equal(out.filter((part) => part.type === "image").length, 1);
  assert.match(JSON.stringify(out[0]), /a\.ts/);
}

// 4. Non-media results keep the persisted JSON text (no accidental reshaping).
{
  const out = projectCodeModeModelOutput({ success: true, result: { ok: 1 }, logs: ["hello"] });
  assert.equal(typeof out, "string");
  assert.match(out, /"ok":1/);
  assert.match(out, /hello/);
}

// 5. A failed run is never lifted, even if an error payload looks media-shaped.
{
  const out = projectCodeModeModelOutput({ success: false, result: image, error: { message: "boom" } });
  assert.equal(typeof out, "string");
  assert.match(out, /boom/);
}

// 6. Idempotent: re-projecting its own output is a no-op, in both shapes.
{
  const parts = [{ type: "text", content: "already shaped" }];
  assert.deepEqual(projectCodeModeModelOutput(parts), parts, "ContentPart[] output is returned untouched");
  const asString = JSON.stringify(parts);
  assert.equal(projectCodeModeModelOutput(asString), asString, "string output is returned untouched");
}

// 7. The per-call cap is stated, not silent: every file is described, only the first 16 are attached.
{
  const many = Array.from({ length: 17 }, (_, i) => ({ ...image, path: `.agents/media/${i}.png` }));
  const out = projectCodeModeModelOutput({ success: true, result: many });
  assert.ok(Array.isArray(out));
  assert.equal(out.filter((part) => part.type === "image").length, 16, "at most 16 media parts per call");
  assert.match(out[0].content, /16\.png/, "the omitted file is still described in the text part");
  assert.match(out[0].content, /\[1 media attachment omitted/, "the model is told one was not attached");
}

console.log("code-mode-model-output validation passed");
