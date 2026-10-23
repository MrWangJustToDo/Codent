/**
 * Validation: the workspace image-preview cache.
 *
 * The panel asks for a preview on every selection, so this module decides how much work that costs
 * and when a cached answer is still the right one. Three failure modes are what this pins:
 *
 *   1. **A stale picture.** `FileContent` remounts on `refreshToken`, so an entry keyed only by path
 *      would show a file as it was before the refresh. The key carries `size` + `mtime` for exactly
 *      that reason.
 *   2. **A decode storm.** `null` (no decoder, unreadable bytes, file gone) is a RESULT: caching
 *      only successes makes an un-previewable file retry `sharp` on every re-render.
 *   3. **Unbounded memory.** Browsing a folder of screenshots must not pin every decoded grid for
 *      the session; the cache is an LRU with a bound.
 *
 * A host without `imageToText` must also answer without touching the filesystem — reading bytes to
 * learn that there is no decoder is work with a known answer.
 *
 * Run: node packages/app/test/image-preview-cache.test.mjs
 */
import assert from "node:assert/strict";

import { clearImagePreviewCache, imagePreviewCacheKey, loadImagePreview } from "../dist/index.mjs";

const BYTES = new Uint8Array([137, 80, 78, 71]);

const RESULT = {
  rows: ["\u001b[38;2;255;0;0m\u2580"],
  imageWidth: 400,
  imageHeight: 300,
  region: { x: 0, y: 0, width: 400, height: 300 },
};

/** Minimal `CoreEnv` surface `loadImagePreview` touches. */
function makeEnv({ files, rows = RESULT.rows, decode } = {}) {
  const state = { decoded: 0, read: 0, resized: 0, stat: 0 };
  const env = {
    rootPath: "/workspace",
    fs: {
      stat: async (path) => {
        state.stat++;
        const file = files[path];
        if (!file) throw new Error("ENOENT");
        return { isFile: true, isDirectory: false, size: file.size, mtime: new Date(file.mtime) };
      },
      readFile: async () => {
        state.read++;
        return BYTES;
      },
    },
    imageToText: async (_bytes, options) => {
      state.decoded++;
      state.lastRegion = options.region;
      return decode ? decode() : { ...RESULT, rows };
    },
    resizeImage: async () => {
      state.resized++;
      return BYTES;
    },
  };
  return { env, state };
}

const file = (size = 100, mtime = 1_700_000_000_000) => ({ size, mtime });

// ── the key carries file identity, not just the path ────────────────────────
{
  const base = { path: "/w/a.png", size: 10, mtimeMs: 1000, maxCols: 48, maxRows: 16, color: true };
  assert.equal(imagePreviewCacheKey(base), imagePreviewCacheKey({ ...base }), "same inputs, same key");
  assert.notEqual(imagePreviewCacheKey(base), imagePreviewCacheKey({ ...base, size: 11 }), "a resize must invalidate");
  assert.notEqual(
    imagePreviewCacheKey(base),
    imagePreviewCacheKey({ ...base, mtimeMs: 1001 }),
    "an edit must invalidate"
  );
  assert.notEqual(
    imagePreviewCacheKey(base),
    imagePreviewCacheKey({ ...base, color: false }),
    "the colorless render is a different picture"
  );
  assert.notEqual(
    imagePreviewCacheKey(base),
    imagePreviewCacheKey({ ...base, maxCols: 49 }),
    "a resize of the pane is a different render"
  );
  assert.notEqual(
    imagePreviewCacheKey(base),
    imagePreviewCacheKey({ ...base, region: { x: 0, y: 0, width: 400, height: 300 } }),
    "an explicit window is not the fitted render: the host may upsample one and not the other"
  );
  assert.notEqual(
    imagePreviewCacheKey(base),
    imagePreviewCacheKey({ ...base, region: { x: 10, y: 0, width: 200, height: 150 } }),
    "a different zoom window is a different picture"
  );
  assert.equal(
    imagePreviewCacheKey({ ...base, region: { x: 10.4, y: 20.6, width: 200, height: 150 } }),
    imagePreviewCacheKey({ ...base, region: { x: 10, y: 21, width: 200, height: 150 } }),
    "sub-pixel pan steps reuse the entry they round to"
  );
}

// ── a successful preview is decoded once ────────────────────────────────────
{
  clearImagePreviewCache();
  const { env, state } = makeEnv({ files: { "/w/a.png": file() } });
  const request = { env, path: "/w/a.png", maxCols: 48, maxRows: 16, color: true };

  const first = await loadImagePreview(request);
  const second = await loadImagePreview(request);

  assert.deepEqual(first?.rows, ["\u001b[38;2;255;0;0m\u2580"], "rows come back");
  assert.equal(first?.imageWidth, 400, "the source size comes back, for the zoom window");
  assert.deepEqual(second, first, "the cached result is identical");
  assert.equal(state.decoded, 1, "the second request hits the cache");
}

// ── `null` is cached too ────────────────────────────────────────────────────
{
  clearImagePreviewCache();
  const { env, state } = makeEnv({ files: { "/w/b.png": file() }, decode: () => null });

  assert.equal(await loadImagePreview({ env, path: "/w/b.png", maxCols: 8, maxRows: 4, color: true }), null);
  assert.equal(await loadImagePreview({ env, path: "/w/b.png", maxCols: 8, maxRows: 4, color: true }), null);
  assert.equal(state.decoded, 1, "an undecodable file is not retried on every render");
}

// ── no decoder: no filesystem work ──────────────────────────────────────────
{
  clearImagePreviewCache();
  const { env, state } = makeEnv({ files: { "/w/c.png": file() } });
  delete env.imageToText;

  assert.equal(await loadImagePreview({ env, path: "/w/c.png", maxCols: 8, maxRows: 4, color: true }), null);
  assert.equal(state.stat, 0, "a host without a decoder is detected before any I/O");
  assert.equal(state.read, 0, "and no bytes are read");
}

// ── a missing file degrades instead of throwing ─────────────────────────────
{
  clearImagePreviewCache();
  const { env } = makeEnv({ files: {} });
  assert.equal(await loadImagePreview({ env, path: "/w/gone.png", maxCols: 8, maxRows: 4, color: true }), null);
}

// ── a zoom window reaches the host ──────────────────────────────────────────
{
  clearImagePreviewCache();
  const { env, state } = makeEnv({ files: { "/w/zoom.png": file(8 * 1024 * 1024) } });
  env.fs.readFile = async () => new Uint8Array(3 * 1024 * 1024);
  const region = { x: 100, y: 50, width: 200, height: 150 };

  await loadImagePreview({ env, path: "/w/zoom.png", maxCols: 48, maxRows: 16, color: true, region });
  assert.deepEqual(state.lastRegion, region, "the window is forwarded to the decoder");
}

// ── the bytes are never pre-shrunk, so the reported size is the SOURCE size ──
// `resizeImage` produces a smaller copy with no EXIF rotation. Feeding that to the decoder makes the
// host report the copy's size, and every later zoom window is then computed in the wrong coordinate
// system (a 2172px screenshot reported as 512 → zoom crops a 250px box out of the original). It also
// made the fitted view disagree with the zoomed views of a rotated photo.
{
  clearImagePreviewCache();
  const { env, state } = makeEnv({ files: { "/w/big.png": file(8 * 1024 * 1024) } });
  env.fs.readFile = async () => new Uint8Array(3 * 1024 * 1024);

  const result = await loadImagePreview({ env, path: "/w/big.png", maxCols: 96, maxRows: 32, color: true });
  assert.equal(state.resized, 0, "a large file is decoded as-is");
  assert.equal(result.imageWidth, RESULT.imageWidth, "and the host reports the real source width");
}

// ── the window sent to the host is the one the cache key describes ───────────
{
  clearImagePreviewCache();
  const { env, state } = makeEnv({ files: { "/w/sub.png": file() } });

  await loadImagePreview({
    env,
    path: "/w/sub.png",
    maxCols: 48,
    maxRows: 16,
    color: true,
    region: { x: 10.4, y: 20.6, width: 200.5, height: 150.2 },
  });
  assert.deepEqual(
    state.lastRegion,
    { x: 10, y: 21, width: 201, height: 150 },
    "a sub-pixel window is rounded before it is sent, so key and request agree"
  );
}

// ── clearing while a decode is in flight does not resurrect the entry ────────
{
  clearImagePreviewCache();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { env, state } = makeEnv({
    files: { "/w/race.png": file() },
    decode: () => ({ ...RESULT, rows: ["in-flight"] }),
  });
  const slowDecode = env.imageToText;
  env.imageToText = async (bytes, options) => {
    await gate;
    return slowDecode(bytes, options);
  };

  const inFlight = loadImagePreview({ env, path: "/w/race.png", maxCols: 48, maxRows: 16, color: true });
  // Let the load get far enough to have started decoding (stat → readFile → decode) before the clear,
  // otherwise the "generation" it records is the post-clear one and the race is never exercised.
  await new Promise((resolve) => setTimeout(resolve, 20));
  clearImagePreviewCache();
  release();
  await inFlight;

  // The clear happened first, so the answer must be thrown away — a second load has to decode again.
  await loadImagePreview({ env, path: "/w/race.png", maxCols: 48, maxRows: 16, color: true });
  assert.equal(state.decoded, 2, "a decode that finishes after a clear is not cached");
}

// ── the cache is bounded (LRU) ──────────────────────────────────────────────
{
  clearImagePreviewCache();
  const files = {};
  for (let i = 0; i < 40; i++) files[`/w/${i}.png`] = file();
  const { env, state } = makeEnv({ files });

  const load = (i) => loadImagePreview({ env, path: `/w/${i}.png`, maxCols: 8, maxRows: 4, color: true });

  for (let i = 0; i < 33; i++) await load(i);
  const afterFill = state.decoded;
  assert.equal(afterFill, 33, "each distinct file decodes once");

  // 0 was evicted by the 33rd insert (bound is 32), so it decodes again…
  await load(0);
  assert.equal(state.decoded, afterFill + 1, "the oldest entry was evicted");

  // …while the most recent one is still cached.
  await load(32);
  assert.equal(state.decoded, afterFill + 1, "the newest entry survives");
}

console.log("image-preview-cache — ok");
