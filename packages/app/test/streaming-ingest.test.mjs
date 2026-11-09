import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  clearStreamingIngest,
  getStreamingStoreOutput,
  ingestStreamingChunk,
  registerStreamingThrottle,
  resetStreamingIngest,
  seedStreamingBuffers,
} from "../dist/utils/streaming-ingest.mjs";

test("ingestStreamingChunk with throttleMs=0 flushes every chunk", () => {
  const unregister = registerStreamingThrottle("call-immediate", 0);
  ingestStreamingChunk("call-immediate", "stdout", "a");
  assert.equal(getStreamingStoreOutput("call-immediate")?.stdout, "a");
  ingestStreamingChunk("call-immediate", "stdout", "b");
  assert.equal(getStreamingStoreOutput("call-immediate")?.stdout, "ab");
  unregister();
  clearStreamingIngest("call-immediate");
});

test("ingestStreamingChunk batches updates when throttled", async () => {
  const unregister = registerStreamingThrottle("call-throttled", 40);
  ingestStreamingChunk("call-throttled", "stdout", "1");
  ingestStreamingChunk("call-throttled", "stdout", "2");
  ingestStreamingChunk("call-throttled", "stdout", "3");

  assert.equal(getStreamingStoreOutput("call-throttled"), undefined);

  await delay(50);
  assert.equal(getStreamingStoreOutput("call-throttled")?.stdout, "123");

  unregister();
  clearStreamingIngest("call-throttled");
});

test("clearStreamingIngest drops pending buffer", async () => {
  const unregister = registerStreamingThrottle("call-clear", 100);
  ingestStreamingChunk("call-clear", "stdout", "pending");
  clearStreamingIngest("call-clear");
  unregister();

  await delay(120);
  assert.equal(getStreamingStoreOutput("call-clear"), undefined);
});

test("seedStreamingBuffers seeds a remount and never truncates newer live output", () => {
  // A chunk that arrived before the remount seed is already in the buffer and is the newer text.
  ingestStreamingChunk("call-seed-live", "stdout", "full-live-output");
  seedStreamingBuffers({
    "call-seed-live": { stdout: "partial", stderr: "" },
    "call-seed-new": { stdout: "seed-out", stderr: "seed-err" },
  });

  assert.equal(getStreamingStoreOutput("call-seed-live")?.stdout, "full-live-output");
  assert.equal(getStreamingStoreOutput("call-seed-new")?.stdout, "seed-out");
  assert.equal(getStreamingStoreOutput("call-seed-new")?.stderr, "seed-err");

  resetStreamingIngest();
  assert.equal(getStreamingStoreOutput("call-seed-live"), undefined);
  assert.equal(getStreamingStoreOutput("call-seed-new"), undefined);
});
