/**
 * Validates streaming output line helpers.
 *
 * Run: node packages/app/test/streaming-output-lines.test.mjs
 */
import { padLatestLines, splitStreamingLines, takeLatestLines } from "@codent/core";
import assert from "node:assert/strict";

import { buildFixedStreamingWindow } from "../dist/utils/streaming-output-lines.mjs";

assert.deepEqual(splitStreamingLines(""), []);
assert.deepEqual(splitStreamingLines("a\nb"), ["a", "b"]);
assert.deepEqual(splitStreamingLines("a\nb\n"), ["a", "b"]);
assert.deepEqual(splitStreamingLines("a\n\nb\n"), ["a", "", "b"]);
// WebContainer / Windows shells often emit CRLF — trailing `\r` must not reach Ink Text.
assert.deepEqual(splitStreamingLines("total 1\r\ndrwxr-xr-x usr\r\n"), ["total 1", "drwxr-xr-x usr"]);
assert.deepEqual(splitStreamingLines("a\rb\rc"), ["a", "b", "c"]);

assert.deepEqual(takeLatestLines(["a"], 3), ["a"]);
assert.deepEqual(takeLatestLines(["a", "b", "c", "d"], 3), ["b", "c", "d"]);
assert.deepEqual(takeLatestLines([], 2), []);

assert.deepEqual(padLatestLines(["a"], 3), ["", "", "a"]);
assert.deepEqual(padLatestLines(["a", "b", "c", "d"], 3), ["b", "c", "d"]);
assert.deepEqual(padLatestLines([], 2), ["", ""]);

const empty = buildFixedStreamingWindow("", 3);
assert.deepEqual(empty.lines, []);
assert.equal(empty.hidden, 0);

const waiting = buildFixedStreamingWindow("", 3, { emptyPlaceholder: "Waiting..." });
assert.deepEqual(waiting.lines, ["Waiting..."]);
assert.equal(waiting.hidden, 0);

const paddedWaiting = buildFixedStreamingWindow("", 3, {
  emptyPlaceholder: "Waiting...",
  padToMax: true,
});
assert.deepEqual(paddedWaiting.lines, ["", "", "Waiting..."]);

const overflowing = buildFixedStreamingWindow("1\n2\n3\n4\n5", 3);
assert.deepEqual(overflowing.lines, ["… 2 lines hidden above", "4", "5"]);
assert.equal(overflowing.hidden, 2);

const overflowingSingle = buildFixedStreamingWindow("1\n2\n3\n4", 3);
assert.deepEqual(overflowingSingle.lines, ["… 1 line hidden above", "3", "4"]);
assert.equal(overflowingSingle.hidden, 1);

const overflowingLarge = buildFixedStreamingWindow("a\nb\nc\nd\ne\nf\ng", 4);
assert.deepEqual(overflowingLarge.lines, ["… 3 lines hidden above", "e", "f", "g"]);
assert.equal(overflowingLarge.hidden, 3);

const growing = buildFixedStreamingWindow("line1\nline2", 5);
assert.deepEqual(growing.lines, ["line1", "line2"]);
assert.equal(growing.hidden, 0);

console.log("streaming-output-lines validation passed");
