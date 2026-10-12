/**
 * Validates media dehydrate/hydrate round-trip and session persistence.
 *
 * Run: pnpm --filter @codent/core run validate:media-store
 */

/* eslint-disable no-undef */

import assert from "node:assert/strict";
import path from "node:path";

import {
  MediaStore,
  getEnv,
  dehydrateUIMessages,
  hydrateUIMessages,
  mimeToExtension,
  parseMediaRefPath,
  buildMediaRefPath,
  repairStringifiedMultimodalUIMessages,
  clearCoreEnv,
  registerCoreEnv,
} from "../dist/dev.mjs";

// ============================================================================
// Helpers
// ============================================================================

function makeImagePart(sourceType, value) {
  return {
    type: "image",
    source: { type: sourceType === "url" ? "url" : "data", value },
    metadata: {},
  };
}

function makeMessage(parts) {
  return { id: "test-msg-1", role: "user", parts, content: "", createdAt: new Date() };
}

// A tiny valid base64 string (a 1x1 red pixel PNG)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

// ============================================================================
// Mock CoreEnv (in-memory file system)
// ============================================================================

/** Minimal in-memory file system for testing. */
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
        if (content instanceof Uint8Array) {
          return new TextDecoder().decode(content);
        }
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
        return {
          isDirectory: entry === "__dir__",
          isFile: entry !== "__dir__",
          size,
          mtime: new Date(),
        };
      },
      async readdir(p) {
        const entries = [];
        for (const key of inMemoryFs.keys()) {
          if (key.startsWith(p + "/") || key.startsWith(p + path.sep)) {
            const name = key.slice(p.length + 1);
            if (!name.includes("/") && !name.includes(path.sep)) {
              entries.push({ name, isDirectory: inMemoryFs.get(key) === "__dir__" });
            }
          }
        }
        return entries;
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

function cleanupMockEnv() {
  clearCoreEnv();
  inMemoryFs.clear();
}

// ============================================================================
// Tests
// ============================================================================

async function testRoundTrip() {
  const store = new MediaStore(getEnv());

  // 1. Save a base64 value
  const ref = await store.save(TINY_PNG_BASE64, "image/png", "test.png", "url");
  assert.equal(ref.mimeType, "image/png");
  assert.equal(ref.filename, "test.png");
  assert.equal(ref.sourceType, "url");
  assert(ref.hash.length > 0, "hash should not be empty");
  assert(ref.size > 0, "size should be > 0");

  // 2. Load it back
  const loaded = await store.load(ref);
  assert.equal(loaded, TINY_PNG_DATA_URL, "load should reconstruct data URL");

  // 3. Same hash for same content
  const ref2 = await store.save(TINY_PNG_BASE64, "image/png", "test2.png", "data");
  assert.equal(ref2.hash, ref.hash, "same content should produce same hash");

  console.log("  ✓ round-trip save/load");
}

async function testExtractBase64() {
  const { extractBase64Content, buildDataUrl } = await import("../dist/dev.mjs");

  // Data URL
  assert.equal(
    extractBase64Content(TINY_PNG_DATA_URL),
    TINY_PNG_BASE64,
    "extractBase64Content should strip data URL prefix"
  );

  // Raw base64
  assert.equal(
    extractBase64Content(TINY_PNG_BASE64),
    TINY_PNG_BASE64,
    "extractBase64Content should pass through raw base64"
  );

  // Build data URL
  assert.equal(
    buildDataUrl("image/png", TINY_PNG_BASE64),
    TINY_PNG_DATA_URL,
    "buildDataUrl should reconstruct data URL"
  );

  console.log("  ✓ extractBase64Content / buildDataUrl");
}

async function testDehydrateHydrateRoundTrip() {
  const messages = [
    makeMessage([makeImagePart("url", TINY_PNG_DATA_URL)]),
    makeMessage([makeImagePart("data", TINY_PNG_BASE64)]),
    makeMessage([{ type: "text", content: "hello" }]),
  ];

  // Dehydrate
  const dehydrated = await dehydrateUIMessages(messages, { env: getEnv() });
  assert.equal(dehydrated.length, 3, "should keep same message count");

  // Check image parts are dehydrated
  const img1Source = dehydrated[0].parts[0].source;
  assert.ok(img1Source.value.startsWith("media://"), "data URL should be replaced with media:// ref");

  const img2Source = dehydrated[1].parts[0].source;
  assert.ok(img2Source.value.startsWith("media://"), "raw base64 should be replaced with media:// ref");

  // Check text part is unchanged
  assert.equal(dehydrated[2].parts[0].type, "text");

  // Check metadata has mediaRef
  assert.ok(dehydrated[0].parts[0].metadata?.mediaRef, "dehydrated part should have mediaRef in metadata");
  assert.ok(dehydrated[1].parts[0].metadata?.mediaRef, "dehydrated part should have mediaRef in metadata");

  // Hydrate
  const hydrated = await hydrateUIMessages(dehydrated, { env: getEnv() });
  assert.equal(hydrated.length, 3, "should keep same message count");

  // Check parts are restored
  assert.equal(hydrated[0].parts[0].source.value, TINY_PNG_DATA_URL, "data URL should be restored after hydrate");
  assert.equal(hydrated[1].parts[0].source.value, TINY_PNG_BASE64, "raw base64 should be restored after hydrate");

  // Check metadata.mediaRef is cleaned up after hydrate
  assert.equal(hydrated[0].parts[0].metadata?.mediaRef, undefined, "mediaRef should be removed after hydrate");

  // Check original messages are not mutated
  assert.equal(messages[0].parts[0].source.value, TINY_PNG_DATA_URL, "original messages should not be mutated");

  console.log("  ✓ dehydrate/hydrate round-trip for url and data source types");
}

async function testInlineDataUrlWithoutMediaRef() {
  // Runtime / not-yet-dehydrated message — no mediaRef, value is a data URL
  const messages = [makeMessage([makeImagePart("url", TINY_PNG_DATA_URL)])];

  const hydrated = await hydrateUIMessages(messages, { env: getEnv() });
  assert.equal(
    hydrated[0].parts[0].source.value,
    TINY_PNG_DATA_URL,
    "inline data URL without mediaRef should pass through"
  );

  console.log("  ✓ inline data URL without mediaRef passes through");
}

async function testTypesUtils() {
  // mimeToExtension
  assert.equal(mimeToExtension("image/png"), "png");
  assert.equal(mimeToExtension("application/pdf"), "pdf");
  assert.equal(mimeToExtension("unknown/type"), "bin");

  // parseMediaRefPath
  const parsed = parseMediaRefPath("media://abc123.png");
  assert.ok(parsed !== null);
  assert.equal(parsed.hash, "abc123");
  assert.equal(parsed.ext, "png");

  // Invalid ref
  assert.equal(parseMediaRefPath("data:image/png;base64,abc"), null);
  assert.equal(parseMediaRefPath("media://"), null);

  // buildMediaRefPath
  const ref = { hash: "abc123", mimeType: "image/png", filename: "test.png", size: 100, sourceType: "url" };
  assert.equal(buildMediaRefPath(ref), "media://abc123.png");

  console.log("  ✓ type utilities (mimeToExtension, parseMediaRefPath, buildMediaRefPath)");
}

async function testDuplicateContent() {
  const store = new MediaStore(getEnv());

  // Save same content twice
  const ref1 = await store.save(TINY_PNG_BASE64, "image/png", "a.png", "url");
  const ref2 = await store.save(TINY_PNG_BASE64, "image/png", "b.png", "url");

  assert.equal(ref1.hash, ref2.hash, "same content should produce same hash");
  assert.equal(ref1.size, ref2.size, "same content should produce same size");

  // Verify only one file was written (same hash → same path)
  const filePath = `.agents/media/${ref1.hash}.png`;
  assert.ok(inMemoryFs.has(filePath), "file should exist in mock fs");

  console.log("  ✓ duplicate content skips re-write");
}

async function testBinaryOnDisk() {
  const store = new MediaStore(getEnv());
  const ref = await store.save(TINY_PNG_BASE64, "image/png", "pixel.png", "url");
  const filePath = `.agents/media/${ref.hash}.png`;
  const stored = inMemoryFs.get(filePath);
  assert.ok(stored instanceof Uint8Array, "media file should be binary Uint8Array");
  assert.equal(stored[0], 0x89, "PNG magic byte 0");
  assert.equal(stored[1], 0x50, "PNG magic byte 1");
  assert.equal(ref.size, stored.byteLength, "size should match decoded byte length");

  const loaded = await store.load(ref);
  assert.equal(loaded, TINY_PNG_DATA_URL, "binary file should hydrate to data URL");

  console.log("  ✓ media files stored as binary PNG bytes");
}

async function testRepairStringifiedMultimodalOnHydrate() {
  const parts = [
    { type: "text", content: "[Image #1: clipboard-test.png] what is this?" },
    {
      type: "image",
      source: { type: "url", value: TINY_PNG_DATA_URL },
      metadata: { mediaType: "image/png", filename: "clipboard-test.png", imageIndex: 1 },
    },
  ];
  const corrupted = [makeMessage([{ type: "text", content: JSON.stringify(parts) }])];

  const repaired = repairStringifiedMultimodalUIMessages(corrupted);
  assert.equal(repaired[0].parts.length, 2, "should restore text + image parts");
  assert.equal(repaired[0].parts[0].type, "text");
  assert.equal(repaired[0].parts[1].type, "image");

  const hydrated = await hydrateUIMessages(corrupted, { env: getEnv() });
  assert.equal(hydrated[0].parts.length, 2, "hydrate should repair then process");
  assert.equal(hydrated[0].parts[1].type, "image");

  const dehydrated = await dehydrateUIMessages(corrupted, { env: getEnv() });
  assert.equal(dehydrated[0].parts[1].type, "image");
  assert.ok(dehydrated[0].parts[1].source.value.startsWith("media://"), "dehydrate after repair");

  console.log("  ✓ repair stringified multimodal on hydrate/dehydrate");
}

// ============================================================================
// Run
// ============================================================================

async function main() {
  setupMockEnv();

  console.log("MediaStore validation...\n");

  await testRoundTrip();
  await testExtractBase64();
  await testDehydrateHydrateRoundTrip();
  await testInlineDataUrlWithoutMediaRef();
  await testTypesUtils();
  await testDuplicateContent();
  await testBinaryOnDisk();
  await testRepairStringifiedMultimodalOnHydrate();
  await testCreatedAtRevival();

  cleanupMockEnv();

  console.log("\n✓ All media-store validation tests passed");
}

// JSON persistence serializes the Date-typed UIMessage `createdAt` into an ISO
// string; TanStack's wire conversion calls `.toISOString()` and would crash on
// the string form. Hydration must revive it back to a Date.
async function testCreatedAtRevival() {
  const { hydrateUIMessages } = await import("../dist/dev.mjs");
  const messages = [
    {
      id: "msg_created",
      role: "user",
      parts: [{ type: "text", content: "hello" }],
      createdAt: "2026-08-25T08:00:00.000Z",
    },
    { id: "msg_plain", role: "assistant", parts: [{ type: "text", content: "hi" }] },
  ];
  const revivedMessages = await hydrateUIMessages(messages, { env: getEnv() });
  assert.equal(revivedMessages[0].createdAt instanceof Date, true, "createdAt string must revive to Date");
  assert.equal(revivedMessages[0].createdAt.toISOString(), "2026-08-25T08:00:00.000Z");
  assert.ok(
    !("createdAt" in revivedMessages[1]) || !(revivedMessages[1].createdAt instanceof Date),
    "absent createdAt stays absent"
  );
  console.log("  ✓ createdAt revival on hydrate");
}

main().catch((err) => {
  console.error("✗ Media-store validation failed:", err);
  cleanupMockEnv();
  process.exit(1);
});
