/**
 * End-to-end validation of the remote-env plane: boots the real Hono server on
 * an ephemeral port and exercises every CoreEnv HTTP surface through the real
 * `createRemoteEnv` client (fs / exec / runCommand / startCommand polling /
 * fetch proxy / MCP init failure / error deserialization).
 *
 * Run: pnpm --filter @codent/server run validate:coreenv-http
 */
/* eslint-disable no-undef */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";

// Configure before importing dist/index.mjs (it reads env at module load).
const ws = mkdtempSync(join(tmpdir(), "coreenv-http-"));
process.env.ROOT_PATH = ws;
process.env.SERVER_PORT = "0";
process.env.SANDBOX_ENV = "native";

const { createServer } = await import("../dist/index.mjs");
const { createRemoteEnv } = await import("../dist/client.mjs");

const server = createServer();
await new Promise((resolve) => setTimeout(resolve, 400));
// Port 0 → random; read it back from the server address.
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
assert.ok(port > 0, "server must listen on an ephemeral port");
const baseUrl = `http://127.0.0.1:${port}`;

// ── 1. Health + env info parity ──
const health = await (await fetch(`${baseUrl}/health`)).json();
assert.equal(health.status, "ok");
assert.equal(health.rootPath, ws);

const env = await createRemoteEnv(baseUrl);
assert.equal(env.rootPath, ws);
assert.equal(await env.getPlatform(), process.platform);
const homedir = await env.homedir();
assert.ok(homedir.length > 0);

// ── 2. fs text roundtrip + append + exists + stat ──
await env.fs.writeFile("hello.txt", "# Hello\n");
assert.equal(await env.fs.readFile("hello.txt"), "# Hello\n");
await env.fs.appendFile("hello.txt", "- world\n");
assert.equal(await env.fs.readFile("hello.txt"), "# Hello\n- world\n");
assert.equal(await env.fs.exists("hello.txt"), true);
assert.equal(await env.fs.exists("missing.txt"), false);
const stat = await env.fs.stat("hello.txt");
assert.equal(stat.isFile, true);
assert.equal(stat.isDirectory, false);
assert.equal(stat.size, "# Hello\n- world\n".length);

// ── 3. fs binary roundtrip (base64 wire) ──
const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
await env.fs.writeFile("blob.bin", bytes);
const roundTripped = await env.fs.readFile("blob.bin", "buffer");
assert.ok(roundTripped instanceof Uint8Array);
assert.deepEqual([...roundTripped], [...bytes]);

// ── 4. mkdir + readdir ──
await env.fs.mkdir("sub");
await env.fs.writeFile("sub/nested.txt", "nested");
const entries = await env.fs.readdir(".");
const names = entries.map((e) => e.name).sort();
assert.ok(names.includes("hello.txt"));
assert.ok(names.includes("blob.bin"));
assert.ok(names.includes("sub"));
const subEntry = entries.find((e) => e.name === "sub");
assert.equal(subEntry.type, "directory");

// ── 5. mimeType ──
const mime = await env.getMimeType?.("hello.txt");
assert.ok(mime !== undefined, "getMimeType must exist on remote env");
assert.match(String(mime), /text\/plain/);

// ── 6. path traversal rejected with deserialized FileError ──
let traversalError = null;
try {
  await env.fs.writeFile(join("..", "escaped.txt"), "nope");
} catch (error) {
  traversalError = error;
}
assert.ok(traversalError, "path traversal must throw");
assert.equal(traversalError.name, "FileError", `expected FileError, got ${traversalError?.name}`);

// ── 7. exec ──
const execResult = await env.exec(`echo exec-ok`);
assert.equal(execResult.code, 0);
assert.match(execResult.stdout, /exec-ok/);

// ── 8. runCommand — full buffers delivered via onStdout/onStderr fallback ──
let streamedStdout = "";
const runResult = await env.runCommand(`echo run-ok && echo err-line >&2`, {
  onStdout: (chunk) => (streamedStdout += chunk),
});
assert.equal(runResult.exitCode, 0);
assert.match(streamedStdout, /run-ok/, "onStdout fallback must receive full buffer over HTTP");

// ── 9. startCommand — background job with incremental output polling ──
const jobScript = `console.log("job-line-1"); setTimeout(() => { console.log("job-line-2"); process.exit(0); }, 300);`;
const handle = await env.startCommand(`node -e ${JSON.stringify(jobScript)}`, {
  onStdout: () => {},
  onExit: () => {},
});
assert.ok(handle.pid != null || handle.kill, "startCommand must return a handle");
await new Promise((resolve) => setTimeout(resolve, 1200));
assert.ok(handle.kill, "handle exposes kill");

// ── 10. fetch proxy — text and binary encodings against a local upstream ──
const binaryBody = Buffer.from([137, 80, 78, 71, 0, 255]);
const upstream = createHttpServer((req, res) => {
  if (req.url === "/text") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("proxied-text");
    return;
  }
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(binaryBody);
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;

const textRes = await env.fetch(`http://127.0.0.1:${upstreamPort}/text`);
assert.equal(textRes.status, 200);
assert.equal(await textRes.text(), "proxied-text");

const binRes = await env.fetch(`http://127.0.0.1:${upstreamPort}/bin`);
assert.equal(binRes.status, 200);
const binBuf = new Uint8Array(await binRes.arrayBuffer());
assert.deepEqual([...binBuf], [...binaryBody]);
upstream.close();

// ── 11. MCP stdio init failure surfaces as a rejected transport start ──
if (env.createMCPStdioTransport) {
  const transport = env.createMCPStdioTransport({ command: "definitely-not-a-real-binary-xyz" });
  let startError = null;
  try {
    await transport.start();
  } catch (error) {
    startError = error;
  }
  assert.ok(startError, "MCP init for a missing binary must fail");
} else {
  assert.fail("remote env must expose createMCPStdioTransport");
}

// ── 11b. Aborting the request kills the SERVER-side child ──
//
// The gap this closes: an AbortSignal cannot travel in a JSON body, so the only channel is the request
// itself closing — and the command routes did not read `c.req.raw.signal`, nor did the client send one.
// Esc on a `--remote-env` search therefore left the server's `rg` running to its own deadline, while the
// local plane killed the child immediately.
//
// The marker file is the proof: the child writes it only if it survives, and a control run shows the same
// command does write it when nothing aborts.
{
  const marker = join(ws, "abort-marker.txt");
  const script = `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 1500)`;

  const controller = new AbortController();
  const pending = env.execFile(process.execPath, ["-e", script], {
    signal: controller.signal,
    timeout: 30_000,
  });
  setTimeout(() => controller.abort(), 200);

  let rejected = false;
  await pending.then(
    () => {},
    () => {
      rejected = true;
    }
  );
  assert.equal(rejected, true, "an aborted request rejects on the client");

  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert.equal(existsSync(marker), false, "the server-side child was killed — it never wrote its marker");

  await env.execFile(process.execPath, ["-e", script], { timeout: 30_000 });
  assert.ok(existsSync(marker), "control: the same command does write the marker without an abort");
}

// ── 12. image preview (workspace panel) ──
//
// The panel decodes an image through the host that owns the codec, so this plane has to carry the
// bytes and the rendered rows. Two properties matter here: a preview never fails loudly (an
// undecodable buffer is `null`, not a 500 — the panel has no error state for it), and the request
// is bounded, because `sharp` would otherwise decode whatever a caller uploads.
{
  assert.equal(typeof env.imageToText, "function", "the remote env exposes the image preview capability");

  // 8×2 PNG rendered by the server's own decoder. A Node server without `sharp` answers `null`
  // instead, which is the same contract, so accept either and assert the shape.
  const png = new Uint8Array(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAACCAIAAADq9gq6AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP4z8CAFTHgEP8PAI6xD/GRc0rlAAAAAElFTkSuQmCC",
      "base64"
    )
  );
  const preview = await env.imageToText(png, { maxCols: 8, maxRows: 2, color: true });
  assert.ok(preview === null || Array.isArray(preview?.rows), "a valid PNG renders or degrades to null");
  if (preview) {
    assert.ok(preview.rows.length > 0 && preview.rows.length <= 2, "row budget respected over the wire");
    assert.equal(preview.imageWidth, 8, "the source geometry survives the wire");
    assert.equal(preview.imageHeight, 2, "the source geometry survives the wire");
    assert.deepEqual(preview.region, { x: 0, y: 0, width: 8, height: 2 }, "the fitted window is reported");
    for (const line of preview.rows) {
      // `new RegExp` from an interpolated ESC keeps the control character out of the source pattern
      // literal (`no-control-regex` flags that shape, and the escape is deliberate here).
      const ESC = "\u001b";
      const visible = line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
      assert.ok(visible.length <= 8, "column budget respected over the wire");
    }
  }

  assert.equal(
    await env.imageToText(new Uint8Array([0, 1, 2, 3, 255]), { maxCols: 8, maxRows: 2 }),
    null,
    "undecodable bytes answer null instead of a failed request"
  );

  // A zoom window has to survive the wire: the decoded side owns the clamping, and the client's
  // pan bounds come from the echoed rectangle rather than from a second, possibly divergent clamp.
  if (preview) {
    const zoomed = await env.imageToText(png, {
      maxCols: 4,
      maxRows: 2,
      color: true,
      region: { x: 4, y: 0, width: 4, height: 2 },
    });
    assert.ok(zoomed, "a window renders over the wire");
    assert.deepEqual(zoomed.region, { x: 4, y: 0, width: 4, height: 2 }, "the requested window round-trips");

    const clamped = await env.imageToText(png, {
      maxCols: 4,
      maxRows: 2,
      color: true,
      region: { x: 99, y: 99, width: 99, height: 99 },
    });
    assert.ok(clamped, "an impossible window still renders");
    assert.deepEqual(clamped.region, { x: 0, y: 0, width: 8, height: 2 }, "and comes back clamped");
  }

  // The branch a Node-hosted server cannot reach: an env with no decoder at all (browser or
  // WebContainer hosts). The route must answer `{ rows: null }` instead of throwing on a missing
  // member — that answer is what makes the panel show its placeholder.
  {
    const { createImageRoutes } = await import("../dist/index.mjs");
    const routes = createImageRoutes(() => ({}));
    const response = await routes.request("/text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "AAAA", maxCols: 8, maxRows: 4 }),
    });
    assert.equal(response.status, 200, "a host without a decoder still answers");
    assert.deepEqual(await response.json(), { result: null }, "and reports 'no preview'");
  }

  // An oversized cell budget is CLAMPED, not rejected. The local host clamps (`@codent/node` floors
  // to [1, 200]), so rejecting here would make the same picture preview on one plane and show
  // "Cannot preview" on the other — a terminal wider than ~313 columns was enough to hit it, because
  // the panel's own budget is derived from the terminal width.
  const oversized = await fetch(`${baseUrl}/api/image/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: png.toString("base64"), maxCols: 5000, maxRows: 5000 }),
  });
  assert.equal(oversized.status, 200, "an oversized preview budget is still answered");
  const oversizedBody = await oversized.json();
  if (oversizedBody.result) {
    // `new RegExp` from an interpolated ESC keeps the control character out of a source pattern
    // literal (`no-control-regex` flags that shape, and the escape is deliberate here).
    const ESC = "\u001b";
    const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const widest = Math.max(...oversizedBody.result.rows.map((line) => line.replace(SGR, "").length));
    assert.ok(widest <= 200, `the grid is clamped to 200 columns (got ${widest})`);
  }

  // A caller that is not our client cannot hang the server on a non-numeric size either.
  const malformed = await fetch(`${baseUrl}/api/image/text`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: "AAAA", maxCols: "big", maxRows: 4 }),
  });
  assert.equal(malformed.status, 400, "a non-numeric size is refused by validation");

  // The client degrades a transport failure to `null`, like the local host does for every failure
  // mode: a rejected promise here reads as a broken panel rather than "no preview". The failure is
  // induced by replacing `fetch` (the Hono RPC client uses the global) because `createRemoteEnv`
  // itself probes the server on construction, so an unreachable URL never gets this far.
  {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("induced transport failure");
    };
    try {
      const answer = await env.imageToText(png, { maxCols: 8, maxRows: 4, color: true });
      assert.equal(answer, null, "a transport failure answers null instead of throwing");
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

// ── 13. cleanup ──
await env.fs.remove("hello.txt");
await env.fs.remove("blob.bin");
assert.equal(await env.fs.exists("hello.txt"), false);
await env.destroy();

// Await the close, and destroy keep-alive sockets first. `server.close()` only fires its
// callback once every connection has ended, and undici's `fetch` keeps connections alive — so
// awaiting close() alone can hang forever (caught by CI as a validator timeout). Firing the
// callback without awaiting would instead exit mid-close, which trips a libuv assertion on
// Windows (`!(handle->flags & UV_HANDLE_CLOSING)`) after the success line was already printed.
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
rmSync(ws, TEMP_RM_OPTIONS);
console.log("coreenv-http validation passed");
