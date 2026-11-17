/**
 * Validates that multimodal tool results are offloaded to the media store in BOTH shapes they reach
 * the message channel in.
 *
 * `ToolResultPart.content` is `string | Array<ContentPart>`:
 * - **array (current)** — TanStack >= 1.0.1 `StreamProcessor` re-parses the stringified
 *   `TOOL_CALL_RESULT` and keeps the parts array, which is also what the `tool-call` carries in
 *   `output` (an MCP screenshot is exactly this: text + image parts on both).
 * - **JSON text (legacy)** — sessions persisted while the processor still kept the stringified form.
 *
 * The regression this guards: only the text form was walked, so every MCP screenshot stayed inline
 * in the session log TWICE (tool-call.output + tool-result.content) — measured on a real session,
 * 68 inline JPEG copies / 12.7 MB of base64 against 27 distinct images.
 *
 * Run: pnpm --filter @codent/core run validate:tool-result-media-shapes
 */

/* eslint-disable no-undef -- the mock CoreEnv below uses Node globals (TextEncoder/TextDecoder) */

import assert from "node:assert/strict";
import path from "node:path";

import {
  clearCoreEnv,
  dehydrateUIMessages,
  getEnv,
  hydrateUIMessages,
  registerCoreEnv,
  resolveMcpToolExecuteResult,
} from "../dist/dev.mjs";

// ============================================================================
// Fixtures
// ============================================================================

/** A 1x1 red pixel PNG — long enough for `isBase64Source`'s raw-base64 probe. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const TOOL_CALL_ID = "chatcmpl-tool-mcp-screenshot";

/** The `content[]` an MCP screenshot tool returns, as TanStack content parts. */
function screenshotParts() {
  return [
    { type: "text", content: "✓ screenshot — 2840×1344 JPEG" },
    { type: "image", source: { type: "data", value: TINY_PNG_BASE64, mimeType: "image/jpeg" } },
  ];
}

/** One assistant message shaped like a real `mcp__browsermcp__browser` turn. */
function mcpMessage({ content, output }) {
  return {
    id: "msg-mcp",
    role: "assistant",
    createdAt: new Date(),
    parts: [
      {
        type: "tool-call",
        id: TOOL_CALL_ID,
        name: "mcp__browsermcp__browser",
        arguments: JSON.stringify({ commands: "screenshot" }),
        input: { commands: "screenshot" },
        state: "complete",
        output,
      },
      { type: "tool-result", toolCallId: TOOL_CALL_ID, content, state: "complete" },
    ],
  };
}

// ============================================================================
// Mock CoreEnv (in-memory file system)
// ============================================================================

const inMemoryFs = new Map();

function setupMockEnv() {
  clearCoreEnv();
  inMemoryFs.clear();

  registerCoreEnv({
    rootPath: "/mock",
    getPlatform: () => Promise.resolve("linux"),
    getArch: () => Promise.resolve("arm64"),
    getEnv: () => Promise.resolve({}),
    homedir: () => Promise.resolve("/mock"),
    path: {
      join: (...parts) => parts.join("/"),
      dirname: (p) => path.dirname(p),
      basename: (p, ext) => path.basename(p, ext),
      extname: (p) => path.extname(p),
      resolve: (...parts) => path.posix.resolve(...parts),
      normalize: (p) => path.posix.normalize(p),
      isAbsolute: (p) => path.posix.isAbsolute(p),
      getSep: () => "/",
      parse: (p) => path.posix.parse(p),
    },
    fs: {
      async readFile(p, encoding) {
        const content = inMemoryFs.get(p);
        if (content === undefined) throw new Error(`ENOENT: ${p}`);
        if (encoding === "buffer") {
          if (content instanceof Uint8Array) return content;
          return new TextEncoder().encode(String(content));
        }
        if (content instanceof Uint8Array) return new TextDecoder().decode(content);
        return content;
      },
      async writeFile(p, content) {
        inMemoryFs.set(p, content);
      },
      async mkdir(p) {
        inMemoryFs.set(p, "__dir__");
      },
      async exists(p) {
        return inMemoryFs.has(p);
      },
      async stat(p) {
        const entry = inMemoryFs.get(p);
        if (entry === undefined) throw new Error(`ENOENT: ${p}`);
        const size = entry === "__dir__" ? 0 : (entry.length ?? entry.byteLength ?? 0);
        return { isDirectory: entry === "__dir__", isFile: entry !== "__dir__", size, mtime: new Date() };
      },
      async readdir() {
        return [];
      },
      async remove(p) {
        inMemoryFs.delete(p);
      },
    },
    runCommand: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    exec: () => Promise.resolve({ stdout: "", stderr: "", code: 0 }),
    fetch: () => Promise.resolve(new Response()),
  });
}

const mediaFiles = () => [...inMemoryFs.keys()].filter((key) => key.startsWith(".agents/media/"));
const occurrences = (value, needle) => JSON.stringify(value).split(needle).length - 1;

/** Dehydrate → JSON round-trip (what the session file does) → hydrate. */
async function roundTrip(messages) {
  const dehydrated = await dehydrateUIMessages(messages, { env: getEnv() });
  const stored = JSON.parse(JSON.stringify(dehydrated));
  const hydrated = await hydrateUIMessages(stored, { env: getEnv() });
  return { dehydrated, stored, hydrated };
}

// ============================================================================
// 1. The real MCP shape: array content + array output
// ============================================================================

async function testMcpShape() {
  setupMockEnv();
  const message = mcpMessage({ content: screenshotParts(), output: screenshotParts() });
  const { dehydrated, hydrated } = await roundTrip([message]);
  const [call, result] = dehydrated[0].parts;

  assert.equal(mediaFiles().length, 1, "both copies are the same bytes: one content-addressed file");
  assert.equal(
    occurrences(dehydrated, TINY_PNG_BASE64),
    0,
    "an MCP screenshot must not stay inline on either the call's output or the result's content"
  );
  assert.ok(Array.isArray(result.content), "the result keeps its ContentPart[] shape");
  assert.ok(result.content[1].source.value.startsWith("media://"), "result content part is a ref");
  assert.ok(Array.isArray(call.output), "the call keeps its ContentPart[] shape");
  assert.ok(call.output[1].source.value.startsWith("media://"), "call output part is a ref");
  assert.equal(
    call.output[1].source.value,
    result.content[1].source.value,
    "both copies point at the same stored asset"
  );

  assert.deepEqual(hydrated, [message], "dehydrate + hydrate must be lossless on this shape");
  console.log("  ✓ array tool-result.content + array tool-call.output dehydrates (no inline copy)");
}

// ============================================================================
// 2. Array content with a record output (mixed / partially migrated session)
// ============================================================================

async function testArrayContentOnly() {
  setupMockEnv();
  // Same declared MIME on both copies — the media store keys on hash + extension, so a fixture that
  // named the bytes `image/png` here and `image/jpeg` in the parts would (correctly) store two files.
  const output = { type: "image", path: "shot.png", base64: TINY_PNG_BASE64, mimeType: "image/jpeg", size: 70 };
  const message = mcpMessage({ content: screenshotParts(), output });
  const { dehydrated, hydrated } = await roundTrip([message]);
  const [call, result] = dehydrated[0].parts;

  assert.equal(mediaFiles().length, 1, "one asset for one image");
  assert.equal(occurrences(dehydrated, TINY_PNG_BASE64), 0, "the array content must be offloaded too");
  assert.ok(Array.isArray(result.content));
  assert.ok(result.content[1].source.value.startsWith("media://"));
  assert.ok(call.output.base64.startsWith("media://"), "the read_file-shaped output is still handled");

  assert.deepEqual(hydrated, [message], "round-trip must restore both the array and the record");
  console.log("  ✓ array tool-result.content + record tool-call.output dehydrates");
}

// ============================================================================
// 3. Legacy stringified tool-result.content keeps working (and stays a string)
// ============================================================================

async function testLegacyStringContent() {
  setupMockEnv();
  const content = JSON.stringify(screenshotParts());
  const message = mcpMessage({ content, output: screenshotParts() });
  const { dehydrated, hydrated } = await roundTrip([message]);
  const result = dehydrated[0].parts[1];

  assert.equal(occurrences(dehydrated, TINY_PNG_BASE64), 0, "both shapes must be offloaded");
  assert.equal(typeof result.content, "string", "a stringified result must stay a string");
  assert.ok(result.content.includes("media://"), "the nested part becomes a ref");

  assert.deepEqual(hydrated, [message], "round-trip must restore the original JSON text");
  console.log("  ✓ legacy stringified tool-result.content still dehydrates and stays a string");
}

// ============================================================================
// 3b. Every binary media type is offloaded, not just images
// ============================================================================

/** A short base64 payload per binary media type (content is irrelevant — only the shape is). */
const NON_IMAGE_MEDIA = [
  { type: "audio", mimeType: "audio/mpeg", ext: "mp3" },
  { type: "video", mimeType: "video/mp4", ext: "mp4" },
  { type: "document", mimeType: "application/pdf", ext: "pdf" },
  // Not in MIME_TO_EXT: a `.bin` file, which must still round-trip because the ref carries its ext.
  { type: "video", mimeType: "video/quicktime", ext: "bin" },
];

async function testNonImageMediaTypes() {
  for (const { type, mimeType, ext } of NON_IMAGE_MEDIA) {
    setupMockEnv();
    const parts = [
      { type: "text", content: `tool returned a ${type}` },
      { type, source: { type: "data", value: TINY_PNG_BASE64, mimeType } },
    ];
    const message = mcpMessage({ content: parts, output: parts });
    const { dehydrated, hydrated } = await roundTrip([message]);
    const ref = dehydrated[0].parts[1].content[1].source.value;

    assert.equal(occurrences(dehydrated, TINY_PNG_BASE64), 0, `${type} must not stay inline`);
    assert.ok(ref.startsWith(`media://`), `${type} part becomes a ref`);
    assert.ok(ref.endsWith(`.${ext}`), `${type}/${mimeType} stores as .${ext} (got ${ref})`);
    assert.ok(
      mediaFiles().some((file) => file.endsWith(`.${ext}`)),
      `${type}/${mimeType} writes a .${ext} file under the media dir`
    );
    assert.deepEqual(hydrated, [message], `${type}/${mimeType} must round-trip losslessly`);
  }
  console.log("  ✓ audio / video / document / unmapped-MIME media offload and round-trip");
}

// ============================================================================
// 3b-bis. A part with no `source.mimeType` and an unmapped MIME must still hydrate
// ============================================================================
// The media store's filename carries the MIME as an extension, so save and load have to derive the
// SAME one. A `url` source may omit `source.mimeType`, and the type is then only in the data URL — a
// type that maps to `.bin` (image/avif, video/quicktime) is unrecoverable from the ref's own
// extension, so hydrate must read the `mediaRef` dehydrate wrote. Deriving it from the part type's
// default instead (image/png) looks for a file that was never written: reported as `not-found`, and
// the wire turns the image into a "media unavailable" placeholder.
async function testUnmappedMimeWithoutSourceMimeType() {
  setupMockEnv();
  const parts = [
    { type: "text", content: "tool returned an avif" },
    { type: "image", source: { type: "url", value: `data:image/avif;base64,${TINY_PNG_BASE64}` } },
  ];
  const message = mcpMessage({ content: parts, output: parts });
  const dehydrated = await dehydrateUIMessages([message], { env: getEnv() });
  const ref = dehydrated[0].parts[1].content[1].source.value;

  assert.ok(ref.endsWith(".bin"), `an unmapped MIME stores as .bin (got ${ref})`);

  const misses = [];
  const hydrated = await hydrateUIMessages(JSON.parse(JSON.stringify(dehydrated)), {
    env: getEnv(),
    onMissing: (miss) => misses.push(miss),
  });

  assert.deepEqual(misses, [], "the stored ref must resolve — no not-found on load");
  assert.deepEqual(hydrated, [message], "the data URL round-trips unchanged");
  console.log("  ✓ a mimeType-less part with an unmapped MIME hydrates back");
}

// ============================================================================
// 3c. An MCP `resource` blob survives the whole trip: block → part → media store
// ============================================================================

async function testMcpResourceBlobEndToEnd() {
  setupMockEnv();
  // What the MCP ingress produces for a binary resource, then what the session log does with it.
  const toolResult = resolveMcpToolExecuteResult("files", {
    content: [
      { type: "resource", resource: { uri: "file:///r.pdf", mimeType: "application/pdf", blob: TINY_PNG_BASE64 } },
    ],
  });
  assert.ok(Array.isArray(toolResult), "a resource blob becomes content parts, not JSON text");
  assert.equal(toolResult[1].type, "document");

  const message = mcpMessage({ content: toolResult, output: toolResult });
  const { dehydrated, hydrated } = await roundTrip([message]);

  assert.equal(occurrences(dehydrated, TINY_PNG_BASE64), 0, "the blob must not reach the session log");
  assert.ok(
    mediaFiles().some((file) => file.endsWith(".pdf")),
    "it is stored as a .pdf asset, so the log keeps only a media:// ref"
  );
  assert.deepEqual(hydrated, [message], "block → part → store → message must round-trip");
  console.log("  ✓ MCP resource blob → document part → media store round-trips");
}

// ============================================================================
// 4. Content without media is left alone (values untouched, no media writes)
// ============================================================================
// Content equality, not array identity: `dehydrateUIMessages` clones the messages (it must, so the
// live UI history keeps its data URLs), so an untouched message is a byte-identical copy.

async function testNoMediaContent() {
  setupMockEnv();
  const textOnly = [{ type: "text", content: "✓ eval 1+1" }];
  const message = mcpMessage({ content: textOnly, output: textOnly });

  const dehydrated = await dehydrateUIMessages([message], { env: getEnv() });

  assert.equal(mediaFiles().length, 0, "nothing binary, nothing stored");
  assert.deepEqual(dehydrated[0].parts[1].content, textOnly, "text-only array is untouched");
  assert.deepEqual(dehydrated[0].parts[0].output, textOnly, "text-only output is untouched");
  console.log("  ✓ text-only content parts are untouched");
}

// ============================================================================
// 5. A missing media file is reported per shape (tool-result vs tool-call)
// ============================================================================

async function testHydrationMissPaths() {
  setupMockEnv();
  const message = mcpMessage({ content: screenshotParts(), output: screenshotParts() });
  const dehydrated = await dehydrateUIMessages([message], { env: getEnv() });
  const stored = JSON.parse(JSON.stringify(dehydrated));

  for (const file of mediaFiles()) inMemoryFs.delete(file);

  const misses = [];
  const hydrated = await hydrateUIMessages(stored, { env: getEnv(), onMissing: (miss) => misses.push(miss) });
  const paths = misses.map((miss) => miss.path);

  assert.ok(paths.includes("tool-result"), `array content miss must report tool-result (got ${paths.join(",")})`);
  assert.ok(paths.includes("tool-call"), `array output miss must report tool-call (got ${paths.join(",")})`);
  assert.ok(
    misses.every((miss) => miss.reason === "not-found"),
    "a deleted media file is 'not-found', not 'invalid-ref'"
  );
  assert.equal(
    occurrences(hydrated, "media://"),
    2,
    "an unhydratable ref stays in place (copy-on-write), so a restored media dir brings it back"
  );
  console.log("  ✓ hydration misses on the array shapes are reported per path");
}

// ============================================================================
// 5b. A record output whose ref survived but whose `mediaRef` did not is reported
// ============================================================================
// The hash alone does not name the file's extension, so the value cannot be resolved — but it must
// still be REPORTED: the miss counter is what makes the wire substitute "media unavailable" instead
// of sending an unfetchable `media://` to the provider.
async function testOrphanedRecordRef() {
  setupMockEnv();
  const orphan = {
    type: "image",
    base64: "media://0123456789abcdef0123456789abcdef.png",
    mimeType: "image/png",
  };
  const message = mcpMessage({ content: "text result", output: { ...orphan } });

  const misses = [];
  const hydrated = await hydrateUIMessages(JSON.parse(JSON.stringify([message])), {
    env: getEnv(),
    onMissing: (miss) => misses.push(miss),
  });

  assert.equal(misses.length, 1, `a ref with no mediaRef must be reported (got ${misses.length} misses)`);
  assert.equal(misses[0].path, "tool-call");
  assert.equal(misses[0].reason, "not-found");
  assert.equal(
    hydrated[0].parts[0].output.base64,
    orphan.base64,
    "the unresolvable ref stays in place — the substitution happens on the wire, not in the log"
  );
  console.log("  ✓ a record ref without its mediaRef is reported, not silently sent");
}

// ============================================================================
// 6. Idempotence: an already-dehydrated transcript is not rewritten
// ============================================================================

async function testIdempotent() {
  setupMockEnv();
  const message = mcpMessage({ content: screenshotParts(), output: screenshotParts() });
  const once = await dehydrateUIMessages([message], { env: getEnv() });
  const twice = await dehydrateUIMessages(JSON.parse(JSON.stringify(once)), { env: getEnv() });

  assert.equal(mediaFiles().length, 1, "no second asset for the same bytes");
  assert.deepEqual(twice, JSON.parse(JSON.stringify(once)), "rehydrating a dehydrated session is a no-op");
  console.log("  ✓ dehydrate is idempotent on a media:// transcript");
}

// ============================================================================
// Run
// ============================================================================

const tests = [
  testMcpShape,
  testArrayContentOnly,
  testLegacyStringContent,
  testNonImageMediaTypes,
  testUnmappedMimeWithoutSourceMimeType,
  testMcpResourceBlobEndToEnd,
  testNoMediaContent,
  testHydrationMissPaths,
  testOrphanedRecordRef,
  testIdempotent,
];

for (const test of tests) await test();

clearCoreEnv();
inMemoryFs.clear();
console.log("tool-result-media-shapes validation passed");
