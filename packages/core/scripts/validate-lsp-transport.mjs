/**
 * Validation: LSP transport layer (node's createLspConnection) against a mock server.
 *
 * Run: pnpm --filter @codent/core run validate:lsp-transport
 *
 * Verifies the full client chain that the LSP extension relies on:
 *   - spawn mock LSP server over stdio
 *   - initialize handshake (serverCapabilities populated, initialized=true)
 *   - didOpen / didChange (file-sync) → server pushes diagnostics
 *   - publishDiagnostics callback (diagnostics cached by LspManager)
 *   - hover / documentSymbol / completion / codeAction / definition / references
 *   - shutdown (graceful) and process cleanup
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = resolve(__dirname, "mock-lsp-server.mjs");

// `"/tmp"` exists on POSIX but not on Windows, where a spawn with that cwd fails ENOENT —
// which reads as an LSP transport failure. Use a real directory on both platforms.
const WORK_DIR = mkdtempSync(resolve(tmpdir(), "lsp-transport-"));

// Import the production transport via the built @codent/node package.
const nodePkg = await import("@codent/node");
const env = nodePkg.createNodeEnv({ rootPath: WORK_DIR, cwd: WORK_DIR, platform: "linux" });
assert.equal(typeof env.createLspConnection, "function", "createNodeEnv must expose createLspConnection");
assert.equal(typeof env.locateTreeSitterGrammar, "function", "createNodeEnv must expose locateTreeSitterGrammar");

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- 1. createLspConnection + initialize handshake ----
const CANCEL_LOG = resolve(WORK_DIR, "cancelled-requests.jsonl");
const config = {
  command: process.execPath, // node
  args: [MOCK_SERVER],
  cwd: WORK_DIR,
  // The mock appends every `$/cancelRequest` it receives here, so the deadline check below can assert
  // the server was actually told to stop working.
  env: { ...process.env, MOCK_LSP_CANCEL_LOG: CANCEL_LOG },
};
const conn = env.createLspConnection(config);

try {
  await conn.start();
  record("connection.start() completes", true);
} catch (err) {
  record("connection.start() completes", false, String(err));
}

assert.equal(conn.initialized, true, "conn.initialized should be true after start");
record("conn.initialized === true after handshake", conn.initialized === true);

const caps = conn.serverCapabilities;
assert.ok(caps && typeof caps === "object", "serverCapabilities from initialize");
record(
  "serverCapabilities populated",
  !!caps,
  caps ? `hover=${caps.hoverProvider} def=${caps.definitionProvider} symbols=${caps.documentSymbolProvider}` : ""
);

// ---- 2. publishDiagnostics callback (server→client push) ----
const pushed = new Map(); // uri -> diagnostics
conn.onPublishDiagnostics((uri, diagnostics) => {
  pushed.set(uri, diagnostics);
});

const uri = "file:///tmp/sample.ts";
const goodCode = 'const x: number = 1;\nfunction hello(): string { return "hi"; }\n';
conn.didOpen(uri, "typescript", 1, goodCode);

// Give the server a moment to push diagnostics.
await new Promise((r) => setTimeout(r, 300));
record("publishDiagnostics received for clean doc", pushed.has(uri), pushed.has(uri) ? "[] diags" : "not pushed");
assert.deepEqual(pushed.get(uri) ?? [], [], "clean doc should have zero diagnostics");

// ---- 3. didChange → re-push with a marker (error + warning) ----
const badCode = 'const x: number = 1; // ERR\nfunction hello(): string { // WARN\n  return "hi";\n}\n';
conn.didChange(uri, 2, badCode);
await new Promise((r) => setTimeout(r, 300));

const badDiags = pushed.get(uri) ?? [];
const hasError = badDiags.some((d) => d.severity === 1 && /ERR/.test(d.message ?? ""));
const hasWarning = badDiags.some((d) => d.severity === 2 && /WARN/.test(d.message ?? ""));
record("didChange triggers error+warning diagnostics", hasError && hasWarning, `${badDiags.length} diags`);

// ---- 4. hover / symbols / completion / codeAction / definition / references ----
const hover = await conn.sendRequest("textDocument/hover", {
  textDocument: { uri },
  position: { line: 1, character: 10 },
});
record("textDocument/hover returns contents", !!hover?.contents, hover?.contents?.value ?? "");

const symbols = await conn.sendRequest("textDocument/documentSymbol", { textDocument: { uri } });
record(
  "textDocument/documentSymbol returns functions",
  Array.isArray(symbols) && symbols.some((s) => s.name === "hello")
);

const completion = await conn.sendRequest("textDocument/completion", {
  textDocument: { uri },
  position: { line: 0, character: 0 },
});
record(
  "textDocument/completion returns array",
  Array.isArray(completion),
  `[${completion.map((c) => c.label).join(",")}]`
);

const actions = await conn.sendRequest("textDocument/codeAction", {
  textDocument: { uri },
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  context: { diagnostics: [] },
});
record("textDocument/codeAction returns array", Array.isArray(actions), actions[0]?.title ?? "");

const def = await conn.sendRequest("textDocument/definition", {
  textDocument: { uri },
  position: { line: 0, character: 0 },
});
record("textDocument/definition returns location", !!def?.uri || !!def?.range);

const refs = await conn.sendRequest("textDocument/references", {
  textDocument: { uri },
  position: { line: 0, character: 0 },
  context: { includeDeclaration: true },
});
record("textDocument/references returns locations", Array.isArray(refs) && refs.length > 0, `${refs.length} refs`);

// ---- 5. workspace/configuration request from server (client responds) ----
// (Transport registers a handler; nothing to assert without a server asking, so skip.)

// ---- 6a. a server that never answers cannot hold the run ----
//
// `test/hang` is answered by nobody, so only the host's deadline can settle it. Every LSP request used
// to be unbounded: a wedged server blocked that run forever and Esc could not break it, because nothing
// in the path listened for the run's signal.
{
  const started = Date.now();
  let rejected = null;
  // An outer guard as well: without the transport's deadline this request never settles, and a
  // validator that hangs reports a timeout instead of the missing bound. The guard fails in 3s with a
  // message that names the cause.
  try {
    await Promise.race([
      conn.sendRequest("test/hang", {}, { timeoutMs: 400 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no deadline: the request never settled")), 3000)),
    ]);
  } catch (err) {
    rejected = err;
  }
  const elapsed = Date.now() - started;
  record(
    "an unanswered request rejects at its deadline, naming it",
    rejected instanceof Error && /LSP request "test\/hang" timed out after 400ms/.test(rejected.message),
    rejected ? rejected.message : "resolved"
  );
  record("…without waiting for anything else", elapsed < 2000, `${elapsed}ms`);

  // The other half of the contract: the server was told to stop working on it. The notification is
  // dispatched asynchronously, so this polls rather than racing it.
  let cancelled = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    cancelled = existsSync(CANCEL_LOG) ? readFileSync(CANCEL_LOG, "utf8") : "";
    if (cancelled.includes("$/cancelRequest")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  record(
    "…and the host cancels the outstanding request with the server",
    cancelled.includes("$/cancelRequest"),
    cancelled.trim().split("\n").slice(-1)[0] || "(no cancel notification)"
  );
}

// ---- 6b. the caller's signal releases a pending request ----
{
  const controller = new AbortController();
  const started = Date.now();
  // 10s, not the default: a broken signal half has to fail this check in seconds, not minutes.
  const pending = conn.sendRequest("test/hang", {}, { timeoutMs: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("run stopped")), 50);
  let rejected = null;
  try {
    await pending;
  } catch (err) {
    rejected = err;
  }
  const elapsed = Date.now() - started;
  record(
    "stopping the run settles a pending request with the caller's reason",
    rejected instanceof Error && rejected.message === "run stopped",
    String(rejected?.message)
  );
  record("…immediately, not at the deadline", elapsed < 5000, `${elapsed}ms`);
}

// ---- 6c. a healthy request is unaffected by the bound ----
{
  const bounded = await conn.sendRequest(
    "textDocument/hover",
    { textDocument: { uri }, position: { line: 0, character: 0 } },
    { timeoutMs: 400 }
  );
  record(
    "a request the server answers is returned unchanged under a deadline",
    Boolean(bounded?.contents),
    String(bounded?.contents?.value ?? "").slice(0, 60)
  );
}

// ---- 6. graceful shutdown ----
conn.onUnexpectedExit(() => {
  // Registered so an unexpected exit during shutdown is observed here instead of
  // surfacing as unhandled; there is nothing to assert.
});
await conn.shutdown();
record("shutdown() completes gracefully", true);
record("conn.disposed === true after shutdown", conn.disposed === true);
assert.equal(conn.disposed, true, "disposed after shutdown");

// ---- 7. unexpected-exit path: spawn a server that exits immediately ----
const crashConn = env.createLspConnection({
  command: process.execPath,
  args: ["-e", "process.exit(0)"],
  cwd: WORK_DIR,
});
const exitCode = await new Promise((resolveExit) => {
  crashConn.onUnexpectedExit((code) => resolveExit(code));
  crashConn.start().catch(() => resolveExit(null));
});
record("onUnexpectedExit fires on server crash", exitCode !== undefined && exitCode !== null, `exit code=${exitCode}`);

// ---- Summary ----
const failed = results.filter((r) => !r.ok);
console.log("\n=== LSP TRANSPORT VALIDATION ===");
console.log(`Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
if (failed.length > 0) {
  console.log("Failures:");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
console.log("All transport checks passed ✅");
