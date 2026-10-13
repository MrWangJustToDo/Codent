/**
 * Validation: `read_file`'s read path.
 *
 * The text branch reads a file in bounded BYTE WINDOWS and keeps only the requested line window, so
 * memory is bounded by the output caps at any file size instead of by a "file too large" gate. This
 * pins:
 *
 *   1. a streamed read uses bounded windows (no request asks for the whole file), reads the head
 *      once for the binary probe, and never calls the whole-file `readFile`;
 *   2. the window is exactly what the old whole-file slice produced: line numbers, offset/limit,
 *      `totalLines` (the `split("\n")` rule), per-line truncation, and the static window cap with
 *      its notice;
 *   3. a multi-byte character straddling a window boundary survives — windows are line-aligned, so
 *      a character is never decoded from two half-ranges;
 *   4. a single line LONGER than a window cannot grow memory, and is truncated like any over-long
 *      line;
 *   5. a host without `readFileRange` (the fallback) still gates on `stat.size` before
 *      materialising the file;
 *   6. the PDF and image branches gate on `stat.size` before reading;
 *   7. the bounded head probe still rejects non-text content.
 *
 * Run: pnpm --filter @codent/core run validate:read-file-size
 */

import assert from "node:assert/strict";

import { createReadFileTool, defaultPath } from "../dist/dev.mjs";

const MB = 1024 * 1024;

// The tool's own caps are module-private; mirror them here so moving a cap is a deliberate test
// edit rather than a silent pass. Every read is bounded by one shared value, whatever the file
// kind (text, PDF, image).
const MAX_FILE_READ_BYTES = 10 * MB;
const MAX_LINE_CHARS = 2000;
const MAX_RESULT_CONTENT_CHARS = 100000;
/** The streaming window size (`READ_CHUNK_BYTES`). */
const CHUNK = 64 * 1024;

/**
 * A stubbed CoreEnv for the tool.
 *
 * `fs.readFileRange` mimics the real host exactly: a BYTE window, decoded independently — so a
 * range whose edge lands inside a multi-byte character yields a replacement character, which is the
 * failure the line-aligned chunker exists to avoid. `fs.stat` reports `size`; both read primitives
 * record what they were asked for, so a test can assert the read shape (not just the output).
 */
function makeEnv({ content = "", size, mimeType = false, withRange = true }) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  const reportedSize = size ?? bytes.length;
  const log = { readFileCalls: 0, rangeCalls: 0, rangeRequests: [], bytesServed: 0, resizeCalls: 0 };

  const fs = {
    exists: async () => true,
    stat: async () => ({ isDirectory: false, isFile: true, size: reportedSize, mtime: new Date(0) }),
    readdir: async () => [],
    readFile: async (_path, encoding) => {
      log.readFileCalls++;
      log.bytesServed += bytes.length;
      return encoding === "buffer" ? bytes : bytes.toString("utf8");
    },
  };
  if (withRange) {
    fs.readFileRange = async (_path, start, end) => {
      log.rangeCalls++;
      log.rangeRequests.push(Math.max(0, Math.floor(end) - Math.floor(start)));
      const from = Math.max(0, Math.floor(start));
      const to = Math.min(bytes.length, Math.floor(end));
      const served = Math.max(0, to - from);
      log.bytesServed += served;
      return bytes.subarray(from, to).toString("utf8");
    };
  }

  const env = {
    rootPath: "/workspace",
    path: defaultPath,
    fs,
    getMimeType: async () => mimeType,
    base64Encode: (data) => Buffer.from(data).toString("base64"),
    /** A decode, which is exactly what the pixel gate must prevent for an oversized image. */
    resizeImage: async () => {
      log.resizeCalls++;
      return null;
    },
  };
  return { env, log, bytes };
}

const tool = createReadFileTool();
const read = (env, input) => tool.execute(input, { toolCallId: "t", context: { coreEnv: env } });

// ---------------------------------------------------------------------------
// (1) A small text file is one window, and never the whole-file read
// ---------------------------------------------------------------------------
{
  const text = "line one\nline two\nline three";
  const { env, log } = makeEnv({ content: text });
  const out = await read(env, { path: "notes.txt" });
  assert.equal(out.type, "text");
  assert.match(out.content, /1: line one\n2: line two\n3: line three/);
  assert.equal(out.totalLines, 3);
  assert.equal(out.startLine, 1);
  assert.equal(out.endLine, 3);
  assert.equal(out.truncated, false);
  assert.equal(log.rangeCalls, 1, "a small file is a single window");
  assert.equal(log.readFileCalls, 0, "the whole-file read is not used when the host can window");
  console.log("ok  small text file read in one bounded window");
}

// ---------------------------------------------------------------------------
// (2) A file larger than a window is streamed, not refused, and never asks for
//     the whole file in one call
// ---------------------------------------------------------------------------
{
  const line = (i) => `L${String(i).padStart(4, "0")} ${"x".repeat(100)}`;
  const text = `${Array.from({ length: 4000 }, (_, i) => line(i + 1)).join("\n")}\n`;
  const { env, log } = makeEnv({ content: text });
  const out = await read(env, { path: "big.txt" });
  assert.equal(out.type, "text");
  assert.equal(out.totalLines, 4001, "the exact line count survives the streamed scan");
  assert.ok(
    log.rangeRequests.length >= 6,
    `a multi-window file must be read in several calls (got ${log.rangeRequests.length})`
  );
  assert.equal(Math.max(...log.rangeRequests), CHUNK, "no request asks for more than one window");
  assert.equal(log.readFileCalls, 0, "no whole-file read");
  assert.ok(
    out.content.length <= MAX_RESULT_CONTENT_CHARS + 60,
    `the window is capped (got ${out.content.length} chars)`
  );
  assert.match(out.content, /\[content truncated for context limit\]/, "the cut window says so");
  assert.equal(out.truncated, true);
  console.log(`ok  multi-window file streamed in ${log.rangeRequests.length} bounded reads`);
}

// ---------------------------------------------------------------------------
// (2') A stat larger than the byte ceiling is no longer a reason to refuse the
//      streamed path (the ceiling is the fallback's bound)
// ---------------------------------------------------------------------------
{
  const { env, log } = makeEnv({ content: "a\nb\n", size: MAX_FILE_READ_BYTES + 1 });
  const out = await read(env, { path: "huge.txt" });
  assert.equal(out.type, "text");
  assert.equal(out.totalLines, 3);
  assert.equal(log.readFileCalls, 0);
  console.log("ok  an oversized stat does not refuse a host that can stream");
}

// ---------------------------------------------------------------------------
// (3) A multi-byte character straddling a window boundary survives
// ---------------------------------------------------------------------------
{
  // 65535 bytes of ASCII ending in a newline, so the next window would start on byte 65535 —
  // inside the 3-byte `中` that follows. Only a line-aligned window keeps it whole.
  const ascii = `${"x".repeat(65534)}\n`;
  const text = `${ascii}中\n尾\n`;
  assert.equal(Buffer.byteLength(ascii, "utf8"), 65535, "the CJK character straddles the boundary");
  const { env, log } = makeEnv({ content: text });
  const out = await read(env, { path: "cjk.txt" });
  assert.match(out.content, /2: 中/, "the character on the window boundary is intact");
  assert.ok(!out.content.includes("\uFFFD"), "no replacement character leaks from a window edge");
  assert.match(out.content, /3: 尾/);
  assert.equal(out.totalLines, 4, "the trailing newline starts one more line, as split('\\n') does");
  assert.ok(log.rangeRequests.length >= 2, "the boundary was crossed by a second window");
  console.log("ok  a multi-byte character on a window boundary is not corrupted");
}

// ---------------------------------------------------------------------------
// (4) A single line longer than a window cannot grow memory
// ---------------------------------------------------------------------------
{
  const text = `${"y".repeat(200000)}\nz\n`;
  const { env, log } = makeEnv({ content: text });
  const out = await read(env, { path: "one-line.txt" });
  assert.match(out.content, new RegExp(`^1: ${"y".repeat(MAX_LINE_CHARS)}\\.\\.\\. \\(line truncated\\)`));
  assert.equal(out.totalLines, 3);
  assert.equal(out.truncated, true);
  assert.ok(
    log.rangeRequests.every((request) => request <= CHUNK),
    "the giant line is read in windows"
  );
  console.log("ok  a line longer than a window is truncated and read in bounded windows");
}

// ---------------------------------------------------------------------------
// (5) Paging: offset/limit, and the offset-out-of-range error
// ---------------------------------------------------------------------------
{
  const text = "a\nb\nc\nd\ne";
  const { env } = makeEnv({ content: text });
  const out = await read(env, { path: "five.txt", offset: 3, limit: 2 });
  assert.equal(out.content, "3: c\n4: d");
  assert.equal(out.startLine, 3);
  assert.equal(out.endLine, 4);
  assert.equal(out.totalLines, 5);
  assert.equal(out.truncated, true, "later lines remain");
}
{
  const { env } = makeEnv({ content: "a\nb\nc\nd\ne" });
  await assert.rejects(
    () => read(env, { path: "five.txt", offset: 6 }),
    /Offset 6 is out of range for this file \(5 lines\)/
  );
  console.log("ok  offset/limit paging and the out-of-range error are unchanged");
}

// ---------------------------------------------------------------------------
// (6) The window is capped and a long line is truncated with its suffix
// ---------------------------------------------------------------------------
{
  const long = "z".repeat(MAX_LINE_CHARS + 500);
  const { env } = makeEnv({ content: `${long}\nshort\n` });
  const out = await read(env, { path: "long.txt" });
  assert.ok(
    out.content.startsWith(`1: ${"z".repeat(MAX_LINE_CHARS)}... (line truncated)`),
    "an over-long line is cut with the suffix"
  );
  assert.match(out.content, /2: short/);
  assert.equal(out.truncated, true);
  console.log("ok  an over-long line is truncated with its suffix");
}

// ---------------------------------------------------------------------------
// (7) Without `readFileRange` the byte ceiling is the fallback's bound
// ---------------------------------------------------------------------------
{
  const text = "alpha\nbeta";
  const { env, log } = makeEnv({ content: text, withRange: false });
  const out = await read(env, { path: "notes.txt" });
  assert.equal(out.type, "text");
  assert.match(out.content, /1: alpha\n2: beta/);
  assert.equal(log.readFileCalls, 1, "a single buffer read");
  assert.equal(log.rangeCalls, 0);
  console.log("ok  fallback host reads once via the buffer");
}
{
  const { env, log } = makeEnv({
    content: "x".repeat(16),
    size: MAX_FILE_READ_BYTES + 1,
    withRange: false,
  });
  await assert.rejects(
    () => read(env, { path: "huge.txt" }),
    (error) =>
      // The gate must not be a dead end: it names a way to read the file in pieces.
      /File too large to read/.test(error.message) && /grep/.test(error.message) && /run_command/.test(error.message),
    "oversized fallback text is rejected with a usable alternative"
  );
  assert.equal(log.readFileCalls, 0, "oversized fallback text: no read attempted");
  assert.equal(log.bytesServed, 0, "oversized fallback text: no bytes requested");
  console.log("ok  oversized text on a fallback host is rejected before any read");
}

// ---------------------------------------------------------------------------
// (8) The PDF and image branches gate on stat.size before reading
// ---------------------------------------------------------------------------
{
  const { env, log } = makeEnv({ size: MAX_FILE_READ_BYTES + 1, mimeType: "application/pdf" });
  await assert.rejects(() => read(env, { path: "huge.pdf" }), /PDF file too large/);
  assert.equal(log.readFileCalls, 0, "oversized PDF: no read attempted");
}
{
  const { env, log } = makeEnv({ size: MAX_FILE_READ_BYTES + 1, mimeType: "image/png" });
  await assert.rejects(() => read(env, { path: "huge.png" }), /Image too large to read/);
  assert.equal(log.readFileCalls, 0, "oversized image: no read attempted");
  console.log("ok  oversized PDF and image are rejected on stat.size, without a read");
}
{
  const { env, log } = makeEnv({
    content: Buffer.from([0x25, 0x50, 0x44, 0x46]), // "%PDF"
    size: 4,
    mimeType: "application/pdf",
  });
  const out = await read(env, { path: "doc.pdf" });
  assert.equal(out.type, "pdf");
  assert.equal(log.readFileCalls, 1, "a normal PDF is read once");
  console.log("ok  a normal PDF is read once");
}

// ---------------------------------------------------------------------------
// (9) The bounded head probe still rejects non-text content
// ---------------------------------------------------------------------------
{
  const { env } = makeEnv({ content: "\u0000binary-ish" });
  await assert.rejects(() => read(env, { path: "blob.txt" }), /appears to be binary/);
  console.log("ok  the bounded head probe still rejects binary content");
}

// ---------------------------------------------------------------------------
// (10) An image that DECLARES an enormous size is refused before anything decodes
// ---------------------------------------------------------------------------
{
  /** Minimal PNG (signature + IHDR) declaring the given size — a decompression bomb. */
  const pngHeader = (width, height) => {
    const bytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8); // IHDR length
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  };
  /** Minimal GIF logical screen descriptor. */
  const gifHeader = (width, height) => {
    const bytes = Buffer.alloc(24);
    bytes.write("GIF89a", 0, "ascii");
    bytes.writeUInt16LE(width, 6);
    bytes.writeUInt16LE(height, 8);
    return bytes;
  };

  // 50000x50000 = 2.5 gigapixels in ~33 bytes: the byte ceiling cannot see this.
  {
    const { env, log } = makeEnv({ content: pngHeader(50000, 50000), mimeType: "image/png" });
    await assert.rejects(
      () => read(env, { path: "bomb.png" }),
      /Image too large to decode: 50000x50000/,
      "a declared 2.5-gigapixel PNG is refused"
    );
    assert.equal(log.resizeCalls, 0, "nothing decodes the bomb (no resize attempt)");
  }
  // A degenerate single side is caught by the per-side cap even under the pixel ceiling.
  {
    const { env, log } = makeEnv({ content: pngHeader(1, 20000), mimeType: "image/png" });
    await assert.rejects(() => read(env, { path: "tall.png" }), /Image too large to decode/);
    assert.equal(log.resizeCalls, 0);
  }
  // GIF declares its size little-endian; 65535^2 is ~4.3 gigapixels.
  {
    const { env, log } = makeEnv({ content: gifHeader(65535, 65535), mimeType: "image/gif" });
    await assert.rejects(
      () => read(env, { path: "bomb.gif" }),
      /Image too large to decode: 65535x65535/,
      "the GIF screen descriptor is read too"
    );
    assert.equal(log.resizeCalls, 0);
  }
  // ...and a normal image still reads.
  {
    const content = pngHeader(1024, 768);
    const { env, log } = makeEnv({ content, mimeType: "image/png" });
    const out = await read(env, { path: "photo.png" });
    assert.equal(out.type, "image");
    assert.equal(out.size, content.length);
    assert.equal(log.resizeCalls, 0, "an image within budget is not resized");
  }
  console.log("ok  oversized declared image dimensions are refused before any decode");
}

console.log("read-file-size validation passed");
