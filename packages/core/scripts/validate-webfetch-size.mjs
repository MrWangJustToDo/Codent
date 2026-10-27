/**
 * Validates the `webfetch` response-size bound (audit finding ④).
 *
 * The bug: `content-length` is the WIRE (compressed) length, so it cannot bound a gzip/deflate
 * bomb, a chunked body, or a header that lies — and the whole body was materialised with
 * `response.arrayBuffer()` BEFORE the `MAX_RESPONSE_SIZE` check, so a hostile URL could OOM the
 * process (server-side under `--remote-env` / remote-session). The fix streams the body and
 * cancels the reader the moment the running total exceeds the limit.
 *
 * This asserts, against the REAL tool over a stubbed CoreEnv:
 *   1. a streaming body larger than the limit rejects with the too-large error, the reader is
 *      cancelled, and the tool stops pulling early — it does NOT buffer the whole body;
 *   2. a deceitful (small) `content-length` header does not bypass the streaming bound;
 *   3. a small normal text response still succeeds;
 *   4. the no-body fallback path still enforces the same bound (large rejects, small succeeds).
 *
 * Run: pnpm --filter @codent/core run validate:webfetch-size
 */

/* eslint-disable no-undef */

import assert from "node:assert/strict";

import { createWebfetchTool } from "../dist/dev.mjs";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // mirrors the tool's advertised 5MB limit
const MB = 1024 * 1024;

// ============================================================================
// Helpers
// ============================================================================

/** Build a streaming body of `chunkCount` × `chunkSize` bytes, recording pull/cancel activity. */
function makeBombStream({ chunkCount, chunkSize }) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulled >= chunkCount) {
        controller.close();
        return;
      }
      pulled += 1;
      // Allocate a real (zero-filled) chunk on demand: only the chunks the tool actually pulls
      // are ever materialised.
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, stats: () => ({ pulled, cancelled }) };
}

/** Minimal CoreEnv stub carrying the parts `webfetch` touches. */
const fakeEnv = (fetchImpl) => ({
  rootPath: "/mock",
  fetch: fetchImpl,
  base64Encode: (bytes) => Buffer.from(bytes).toString("base64"),
  fs: {
    readFile: async () => "",
    writeFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
  },
  path: { join: (...parts) => parts.join("/") },
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
});

/** Run the real tool with a stubbed env. */
const run = (env, url) => createWebfetchTool().execute({ url }, { toolCallId: "t", context: { coreEnv: env } });

// ============================================================================
// 1. A streaming body over the limit rejects instead of buffering everything
// ============================================================================

async function testBombRejected() {
  const { stream, stats } = makeBombStream({ chunkCount: 20, chunkSize: 1 * MB });
  const env = fakeEnv(
    async () =>
      new Response(stream, {
        status: 200,
        // A DECEITFUL header: the wire length says 1KB, far below the limit, so the cheap early
        // reject cannot catch this — only the streaming bound can.
        headers: { "content-type": "text/plain", "content-length": "1024" },
      })
  );

  await assert.rejects(() => run(env, "https://example.test/bomb"), /Response too large/, "a 20MB body must reject");

  const { pulled, cancelled } = stats();
  assert.equal(cancelled, true, "the reader must be cancelled once the limit is crossed");
  assert.ok(pulled <= 8, `the tool must stop pulling early, not drain the body (pulled ${pulled} of 20 chunks)`);

  console.log("  ✓ over-limit streaming body rejects, reader cancelled, stops pulling early");
}

// ============================================================================
// 2. A small normal text response still succeeds
// ============================================================================

async function testSmallSucceeds() {
  const body = "hello from the web";
  const env = fakeEnv(
    async () => new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })
  );

  const out = await run(env, "https://example.test/ok");
  assert.equal(out.content, body, "the body must be read intact");
  assert.equal(out.isImage, false);
  assert.equal(out.truncated, false);
  assert.equal(out.contentType, "text/plain; charset=utf-8");

  console.log("  ✓ small normal text response succeeds");
}

// ============================================================================
// 3. The no-body fallback still enforces the bound
// ============================================================================

async function testNoBodyFallback() {
  const duck = (bytes) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://example.test/fallback",
    headers: new Headers({ "content-type": "text/plain" }),
    // No streaming body → the tool falls back to `arrayBuffer()`.
    body: null,
    arrayBuffer: async () => bytes,
  });

  const large = fakeEnv(async () => duck(new ArrayBuffer(MAX_RESPONSE_SIZE + 1)));
  await assert.rejects(
    () => run(large, "https://example.test/fallback-large"),
    /Response too large/,
    "the fallback path must still reject an over-limit body"
  );

  const smallEnv = fakeEnv(async () => duck(new TextEncoder().encode("fallback ok").buffer));
  const out = await run(smallEnv, "https://example.test/fallback-small");
  assert.equal(out.content, "fallback ok", "the fallback path must still return a small body");

  console.log("  ✓ no-body fallback enforces the bound (large rejects, small succeeds)");
}

// ============================================================================
// 4. SSRF: a private / loopback / metadata target is refused before any request
// ============================================================================

async function testPrivateTargetsRejected() {
  let called = 0;
  const env = fakeEnv(async () => {
    called += 1;
    return new Response("should never be fetched", { status: 200, headers: { "content-type": "text/plain" } });
  });

  const blocked = [
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/iam/security-credentials/"],
    ["GCP metadata name", "http://metadata.google.internal/computeMetadata/v1/"],
    ["loopback", "http://127.0.0.1:8080/admin"],
    ["localhost", "http://localhost/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]/"],
    ["private 10/8", "http://10.0.0.5/"],
    ["private 192.168/16", "http://192.168.1.1/"],
    ["link-local", "http://169.254.1.1/"],
    ["decimal loopback", "http://2130706433/"],
    ["userinfo loopback", "http://example.com@127.0.0.1/"],
    ["non-http scheme", "file:///etc/passwd"],
  ];

  for (const [label, url] of blocked) {
    await assert.rejects(() => run(env, url), /Refusing to fetch|must start with http/, `must refuse ${label}`);
  }
  assert.equal(called, 0, "a refused URL must not reach the fetch implementation");

  console.log(`  ✓ ${blocked.length} private/loopback/metadata targets refused before any request`);
}

// ============================================================================
// 5. A redirect that lands on a private address is refused before the body is used
// ============================================================================

async function testRedirectToPrivateRejected() {
  const duck = {
    ok: true,
    status: 200,
    statusText: "OK",
    url: "http://127.0.0.1/secret",
    headers: new Headers({ "content-type": "text/plain" }),
    body: null,
    arrayBuffer: async () => new TextEncoder().encode("internal secret").buffer,
  };
  const env = fakeEnv(async () => duck);

  await assert.rejects(() => run(env, "https://example.test/redirect"), /Refusing to fetch|private/);

  console.log("  ✓ a redirect to a private address is refused");
}

// ============================================================================
// 6. A redirect to a private address is refused BEFORE the second request
// ============================================================================
async function testRedirectHopIsValidatedBeforeRequest() {
  let calls = 0;
  let sawManual = false;
  const env = fakeEnv(async (_url, init) => {
    calls += 1;
    sawManual = init?.redirect === "manual";
    if (calls === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      });
    }
    return new Response("internal secret", { status: 200, headers: { "content-type": "text/plain" } });
  });

  await assert.rejects(() => run(env, "https://example.test/start"), /Refusing to fetch|private/);
  assert.equal(calls, 1, "the private redirect target must not be requested");
  assert.equal(sawManual, true, "webfetch must ask the host for manual redirects");
  console.log("  ✓ a redirect hop is validated before it is requested");
}

// ============================================================================
// 7. A public redirect chain is followed and reports the final URL
// ============================================================================
async function testPublicRedirectChain() {
  let calls = 0;
  const env = fakeEnv(async (url) => {
    calls += 1;
    if (url === "https://example.test/start") {
      return new Response(null, { status: 301, headers: { location: "/next" } });
    }
    return new Response("landed", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  });

  const result = await run(env, "https://example.test/start");
  assert.equal(calls, 2, "both the redirect and its target are requested");
  assert.equal(result.content, "landed");
  assert.equal(result.finalUrl, "https://example.test/next", "relative Location resolves against the hop");
  console.log("  ✓ a public redirect chain is followed with the final URL");
}

// ============================================================================
// Run
// ============================================================================

async function main() {
  console.log("webfetch size-bound validation...\n");
  await testBombRejected();
  await testSmallSucceeds();
  await testNoBodyFallback();
  await testPrivateTargetsRejected();
  await testRedirectToPrivateRejected();
  await testRedirectHopIsValidatedBeforeRequest();
  await testPublicRedirectChain();
  console.log("\n✓ All webfetch size-bound validation tests passed");
}

main().catch((err) => {
  console.error("✗ webfetch size-bound validation failed:", err);
  process.exit(1);
});
