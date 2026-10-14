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

// ── 12. cleanup ──
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
rmSync(ws, { recursive: true, force: true });
console.log("coreenv-http validation passed");
