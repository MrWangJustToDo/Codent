/**
 * `truncateHead` (the LSP tools' bounded-output helper) must bound by real UTF-8 bytes and must
 * never split a multi-byte character.
 *
 * It used to test `out.length * 2 > maxBytes` and then `out.slice(0, maxBytes)` — a two-argument
 * approximation that both over-counted ASCII (halving an ASCII budget) and sliced by characters,
 * so a CJK body could be cut to an invalid string. This asserts the corrected behaviour.
 */

import assert from "node:assert/strict";
import { TextEncoder } from "node:util";

import { truncateHead } from "../dist/dev.mjs";

const byteLength = (text) => new TextEncoder().encode(text).length;

// (1) A multibyte body is cut to the byte budget, on a character boundary.
const cjk = "中".repeat(100); // 100 chars, 300 bytes
const cut = truncateHead(cjk, 200, 60);
assert.ok(byteLength(cut.content) <= 60, `content must fit 60 bytes (got ${byteLength(cut.content)})`);
assert.ok(!cut.content.includes("\uFFFD"), "must not split a multi-byte character");
assert.equal(cut.truncated, true);
// The old approximation kept 60 *characters* (180 bytes); the true bound keeps 20.
assert.equal(cut.content.length, 20);
console.log("ok  multibyte output is bounded by real bytes, not `length * 2`");

// (2) The line cap is unchanged for ASCII.
const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
const lineCapped = truncateHead(lines, 3);
assert.equal(lineCapped.content, "line 0\nline 1\nline 2");
assert.equal(lineCapped.truncated, true);
assert.equal(lineCapped.totalLines, 5);
assert.equal(lineCapped.outputLines, 3);
console.log("ok  the line cap still truncates to `maxLines`");

// (3) Content under both caps is returned untouched.
const small = truncateHead("a\nb", 10, 1000);
assert.deepEqual(small, { content: "a\nb", truncated: false, totalLines: 2, outputLines: 2 });
console.log("ok  content under both caps is unchanged");

console.log("validate-lsp-output-bytes: ok");
