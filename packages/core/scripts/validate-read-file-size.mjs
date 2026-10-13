/**
 * Validation: `read_file` gates oversized files on `stat.size` BEFORE allocating, and reads a
 * text file once instead of twice. Pins the fix for audit finding ③:
 *
 *   1. an oversized text file (stat.size above the cap) is rejected with the "File too large"
 *      error and NO read is attempted — a multi-GB file must never be pulled into memory.
 *   2. a normal text file is read exactly once: the binary probe runs on a bounded head sample
 *      of the SAME read (`readFileRange` is preferred when the host provides it, otherwise a
 *      single buffer read) — not a whole-file probe followed by a second content read.
 *   3. the PDF branch rejects `stat.size > MAX_BINARY_SIZE` before reading, and a normal PDF is
 *      still read once.
 *   4. the bounded head probe still rejects a file whose head is non-text.
 *   5. the image branch takes the same pre-read gate (it used to materialise the whole image
 *      before the vision-token budget was consulted).
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

/** UTF-8 byte length without a `TextEncoder` global (not in the scripts' lint globals). */
const byteLen = (text) => Buffer.byteLength(text, "utf8");

/**
 * A stubbed CoreEnv for the tool. `fs.stat` reports `size`; the read primitives record how many
 * bytes they were asked for and how many times they were called, so a test can assert a rejected
 * file was never read.
 */
function makeEnv({ size, content = "", mimeType = false, withRange = true }) {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const log = { readFileCalls: 0, readFileRangeCalls: 0, bytesRequested: 0 };
  const fs = {
    exists: async () => true,
    stat: async () => ({ isDirectory: false, isFile: true, size, mtime: new Date(0) }),
    readdir: async () => [],
    readFile: async (_path, encoding) => {
      log.readFileCalls++;
      log.bytesRequested += bytes.length;
      return encoding === "buffer" ? bytes : content;
    },
  };
  if (withRange) {
    fs.readFileRange = async (_path, start, end) => {
      log.readFileRangeCalls++;
      log.bytesRequested += Math.max(0, end - start);
      return content.slice(start, end);
    };
  }
  const env = {
    rootPath: "/workspace",
    path: defaultPath,
    fs,
    getMimeType: async () => mimeType,
    base64Encode: (data) => Buffer.from(data).toString("base64"),
  };
  return { env, log, totalReads: () => log.readFileCalls + log.readFileRangeCalls };
}

const tool = createReadFileTool();

// ---------------------------------------------------------------------------
// (a) An oversized text file is rejected on stat.size, before any read
// ---------------------------------------------------------------------------
{
  const { env, log, totalReads } = makeEnv({ size: MAX_FILE_READ_BYTES + 1, content: "x".repeat(16) });
  await assert.rejects(
    () => tool.execute({ path: "huge.txt" }, { toolCallId: "t", context: { coreEnv: env } }),
    (error) =>
      // The gate must not be a dead end: it names a way to read the file in pieces.
      /File too large to read/.test(error.message) && /grep/.test(error.message) && /run_command/.test(error.message),
    "oversized text is rejected with a usable alternative"
  );
  assert.equal(totalReads(), 0, "oversized text: no read attempted");
  assert.equal(log.bytesRequested, 0, "oversized text: no bytes requested");
  console.log("ok  oversized text rejected on stat.size, without a read");
}

// ---------------------------------------------------------------------------
// (b) A normal text file is read exactly once — readFileRange preferred
// ---------------------------------------------------------------------------
{
  const text = "line one\nline two\nline three";
  const { env, log, totalReads } = makeEnv({ size: byteLen(text), content: text });
  const out = await tool.execute({ path: "notes.txt" }, { toolCallId: "t", context: { coreEnv: env } });
  assert.equal(out.type, "text");
  assert.match(out.content, /2: line two/, "the decoded content is the file's");
  assert.equal(log.readFileRangeCalls, 1, "readFileRange preferred when the host provides it");
  assert.equal(log.readFileCalls, 0, "no second (buffer) read");
  assert.equal(totalReads(), 1, "text file read once");
  console.log("ok  normal text read once via readFileRange");
}

// ---------------------------------------------------------------------------
// (b') Same, on a host without readFileRange: exactly one buffer read
// ---------------------------------------------------------------------------
{
  const text = "alpha\nbeta";
  const { env, log, totalReads } = makeEnv({
    size: byteLen(text),
    content: text,
    withRange: false,
  });
  const out = await tool.execute({ path: "notes.txt" }, { toolCallId: "t", context: { coreEnv: env } });
  assert.equal(out.type, "text");
  assert.match(out.content, /1: alpha/);
  assert.equal(log.readFileCalls, 1, "a single buffer read");
  assert.equal(log.readFileRangeCalls, 0);
  assert.equal(totalReads(), 1, "text file read once");
  console.log("ok  normal text read once via a single buffer read");
}

// ---------------------------------------------------------------------------
// (c) An oversized PDF is rejected on stat.size before reading; a normal PDF
//     is still read once
// ---------------------------------------------------------------------------
{
  const { env, log, totalReads } = makeEnv({ size: MAX_FILE_READ_BYTES + 1, mimeType: "application/pdf" });
  await assert.rejects(
    () => tool.execute({ path: "huge.pdf" }, { toolCallId: "t", context: { coreEnv: env } }),
    /PDF file too large/
  );
  assert.equal(totalReads(), 0, "oversized PDF: no read attempted");
  assert.equal(log.bytesRequested, 0, "oversized PDF: no bytes requested");
  console.log("ok  oversized PDF rejected on stat.size, without a read");
}
{
  const { env, log } = makeEnv({
    size: 4,
    content: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // "%PDF"
    mimeType: "application/pdf",
  });
  const out = await tool.execute({ path: "doc.pdf" }, { toolCallId: "t", context: { coreEnv: env } });
  assert.equal(out.type, "pdf");
  assert.equal(log.readFileCalls, 1, "normal PDF read once");
  assert.equal(log.readFileCalls + log.readFileRangeCalls, 1);
  console.log("ok  normal PDF read once");
}

// ---------------------------------------------------------------------------
// (d) The bounded head probe still rejects non-text content
// ---------------------------------------------------------------------------
{
  const content = "\u0000binary-ish";
  const { env } = makeEnv({ size: byteLen(content), content });
  await assert.rejects(
    () => tool.execute({ path: "blob.txt" }, { toolCallId: "t", context: { coreEnv: env } }),
    /appears to be binary/
  );
  console.log("ok  bounded head probe still rejects binary content");
}

// ---------------------------------------------------------------------------
// (e) An oversized IMAGE is rejected on stat.size before reading
//     (the whole image was materialised before the vision-token budget was consulted)
// ---------------------------------------------------------------------------
{
  const { env, log, totalReads } = makeEnv({ size: MAX_FILE_READ_BYTES + 1, mimeType: "image/png" });
  await assert.rejects(
    () => tool.execute({ path: "huge.png" }, { toolCallId: "t", context: { coreEnv: env } }),
    /Image too large to read/
  );
  assert.equal(totalReads(), 0, "oversized image: no read attempted");
  assert.equal(log.bytesRequested, 0, "oversized image: no bytes requested");
  console.log("ok  oversized image rejected on stat.size, without a read");
}

console.log("read-file-size validation passed");
