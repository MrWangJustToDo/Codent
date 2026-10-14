/**
 * End-to-end validation of GET /api/env/workspace — the effective workspace the
 * UI header shows for remote sessions (server-process CoreEnv rootPath + git).
 *
 * Boots the real server on an ephemeral port rooted at a freshly created git
 * worktree (with one dirty file) and asserts the full git metadata shape.
 *
 * Run: pnpm --filter @codent/server run validate:env-workspace
 */
/* eslint-disable no-undef */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";

const ws = mkdtempSync(join(tmpdir(), "env-workspace-git-"));
execSync("git init -q", { cwd: ws, stdio: "ignore" });
execSync("git -c user.name=test -c user.email=test@example.com commit -q --allow-empty -m init", {
  cwd: ws,
  stdio: "ignore",
});
writeFileSync(join(ws, "dirty.txt"), "x\n");

// Configure before importing dist/index.mjs (it reads env at module load).
process.env.ROOT_PATH = ws;
process.env.SERVER_PORT = "0";
process.env.SANDBOX_ENV = "native";

const { createServer } = await import("../dist/index.mjs");

const server = createServer();
await new Promise((resolve) => setTimeout(resolve, 400));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
assert.ok(port > 0, "server must listen on an ephemeral port");
const baseUrl = `http://127.0.0.1:${port}`;

// ── 1. /api/env/info reports the server rootPath ──
const info = await (await fetch(`${baseUrl}/api/env/info`)).json();
assert.equal(info.rootPath, ws);

// ── 2. /api/env/workspace returns effective rootPath + full git metadata ──
const wsRes = await fetch(`${baseUrl}/api/env/workspace`);
assert.equal(wsRes.status, 200);
const body = await wsRes.json();
assert.equal(body.rootPath, ws);
assert.ok(body.git, "git metadata must be present for a git worktree");
assert.ok(body.git.branch.length > 0, `branch present (got ${body.git.branch})`);
assert.ok(/^[0-9a-f]{7,}$/.test(body.git.shortSha), `shortSha hex (got ${body.git.shortSha})`);
assert.equal(body.git.dirty, true, "dirty file must be detected");
assert.equal(typeof body.git.ahead, "number", "ahead is a number");
assert.equal(typeof body.git.behind, "number", "behind is a number");
console.log("workspace:", JSON.stringify(body));

// Await the close, and destroy keep-alive sockets first. `server.close()` only fires its
// callback once every connection has ended, and undici's `fetch` keeps connections alive — so
// awaiting close() alone can hang forever (caught by CI as a validator timeout). Firing the
// callback without awaiting would instead exit mid-close, which trips a libuv assertion on
// Windows (`!(handle->flags & UV_HANDLE_CLOSING)`) after the success line was already printed.
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
rmSync(ws, TEMP_RM_OPTIONS);
console.log("env-workspace validation passed");

// No `process.exit()`: forcing one while an async stdout/handle is closing trips libuv's
// shutdown assertion on Windows (`!(handle->flags & UV_HANDLE_CLOSING)`), which made this
// script print "passed" and then abort. Draining is enough once the server is closed.
setTimeout(() => process.exit(0), 500).unref();
