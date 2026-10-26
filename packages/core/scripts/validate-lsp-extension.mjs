/**
 * Validation: end-to-end LSP extension activation through the production path.
 *
 * Run: pnpm --filter @codent/core run validate:lsp-extension
 *
 * Uses the SAME wiring as production (agent-factory):
 *   - registerCoreEnv(createNodeEnv(...)) → global CoreEnv
 *   - ExtensionRunner → createLspExtension() → activate
 *
 * Verifies:
 *   - extension activates cleanly (state === "active", no error)
 *   - 11 tools registered (8 LSP + 3 tree-sitter)
 *   - 3 commands registered (/lsp, /lsp-restart, /lsp-config)
 *   - turn-context provider registered (LSP guidance)
 *   - lsp_diagnostics works with a real node transport against the mock server
 *     (trigger server start, wait, then read cached diagnostics)
 *   - lsp_diagnostics tree-sitter fallback (no server) reports syntax errors
 *   - write/edit auto-diagnostics injection appends _lspDiagnostics
 *   - commands execute (/lsp status)
 */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createMockServerCounter } from "./process-count.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = resolve(__dirname, "mock-lsp-server.mjs");
// Scope the process count to THIS run's children: the fast mock server is spawned by several LSP
// validators at once, so an unscoped `pgrep` baseline mixes concurrent runs together.
const serverCounter = createMockServerCounter("lsp-extension");

// Reaping is only assertable where processes are observable. The counter reports the skip
// itself; a null count means assert nothing — 0 is the value that means "all gone", which is
// how the reaping assertions below passed vacuously on a platform without `pgrep`.
function countMockServers() {
  return serverCounter.observe();
}

function waitForMockServers(target, attempts = 40, delayMs = 200) {
  return new Promise((resolveP) => {
    let n = 0;
    const tick = () => {
      const count = countMockServers();
      if (count <= target || n++ >= attempts) return resolveP(count);
      setTimeout(tick, delayMs);
    };
    tick();
  });
}

const mockBaseline = countMockServers();
// null = platform cannot count processes; the reaping assertions below must not run against
// a fabricated 0.
const canCount = mockBaseline !== null;
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- Boot a temp project dir with a sample file ----
const projectDir = mkdtempSync(resolve(tmpdir(), "lsp-ext-validate-"));
mkdirSync(resolve(projectDir, "src"), { recursive: true });
const sampleFile = resolve(projectDir, "src", "sample.ts");
writeFileSync(
  sampleFile,
  `interface User { id: number; name: string }
function greet(u: User): string {
  return "Hello " + u.name;
}
`
);
// .lsp.json maps "typescript" to the mock server so LSP tools can start it.
writeFileSync(
  resolve(projectDir, ".lsp.json"),
  JSON.stringify({
    servers: {
      typescript: { command: process.execPath, args: [MOCK_SERVER, ...serverCounter.getTagArgs()] },
    },
  })
);

// Register CoreEnv (node)
const nodePkg = await import("@codent/node");
const core = await import("@codent/core");
const env = nodePkg.createNodeEnv({ rootPath: projectDir, cwd: projectDir, platform: "linux" });
core.registerCoreEnv(env);

// dev.mjs is not exposed via package exports; load it directly from the built dist.
const coreDistDir = resolve(import.meta.dirname, "..", "dist");
const dev = await import(pathToFileURL(resolve(coreDistDir, "dev.mjs")).href);
const { ExtensionRunner } = dev;

const registeredTools = [];
const registeredCommands = [];
const runner = new ExtensionRunner({
  onRegisterTool: (def) => registeredTools.push(def),
  onRegisterCommand: (cmd) => registeredCommands.push(cmd),
  cwd: projectDir,
  getCoreEnv: () => env,
});

// ---- 1. Activate the built-in LSP extension ----
// enableAll keeps this validation meaningful: the default config skips the
// low-usage tools in DEFAULT_DISABLED_LSP_TOOLS, which are asserted below.
const api = await dev.createLspExtension({ enableAll: true });
const instance = await runner.loadExtension(api);
record("extension activates (state=active)", instance.state === "active", instance.error?.message ?? "no error");
if (instance.state !== "active") {
  console.error("Activation failed:", instance.error);
  process.exit(1);
}

// ---- 2. Tools registered ----
const toolNames = registeredTools.map((t) => t.name).sort();
const expectedTools = [
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_symbols",
  "lsp_rename",
  "lsp_completions",
  "lsp_code_actions",
  "code_overview",
  "ast_search",
  "code_rewrite",
].sort();
const missingTools = expectedTools.filter((t) => !toolNames.includes(t));
record("11 tools registered (8 LSP + 3 tree-sitter)", missingTools.length === 0, `${toolNames.length} tools`);
if (missingTools.length) record("missing tools", false, missingTools.join(", "));

// ---- 3. Commands registered ----
const cmdNames = registeredCommands.map((c) => c.name).sort();
const expectedCmds = ["lsp", "lsp-restart", "lsp-config"].sort();
const missingCmds = expectedCmds.filter((c) => !cmdNames.includes(c));
record("3 commands registered", missingCmds.length === 0, cmdNames.join(", "));

// ---- 4. Turn-context provider registered ----
const appends = await runner.collectBeforeAgentStart("hello", "sess-1");
const lspSection = (appends.turnContextSections ?? []).find((s) => /lsp_diagnostics/.test(s.content ?? ""));
record("turn-context provider contributes LSP guidance", Boolean(lspSection), lspSection?.id ?? "no LSP section");

// ---- 5. /lsp command (no server started yet) ----
const lspCmd = registeredCommands.find((c) => c.name === "lsp");
const lspStatus = await lspCmd.execute([]);
record("/lsp status runs (servers configured)", /typescript/.test(lspStatus), lspStatus.replace(/\n/g, " | "));

// ---- helper: emit a tool:after:read_file event to trigger file-sync (didOpen) ----
const eventBus = runner.getEventBus();
async function syncRead(filePath) {
  await eventBus.emit({
    type: "tool:after:read_file",
    payload: { toolName: "read_file", args: { path: filePath }, result: {}, durationMs: 1 },
    defaultReturn: undefined,
  });
}
// helper: emit a tool:after:write_file event to trigger file-sync (didOpen/didChange) + auto-diag
async function syncWrite(filePath) {
  await eventBus.emit({
    type: "tool:after:write_file",
    payload: { toolName: "write_file", args: { path: filePath }, result: {}, durationMs: 1 },
    defaultReturn: undefined,
  });
}

// ---- 6. lsp_diagnostics against mock server via real transport ----
const diagTool = registeredTools.find((t) => t.name === "lsp_diagnostics");
// First: read the clean sample file through the interceptor → file-sync opens it (didOpen).
await syncRead(sampleFile);
// Give the server a moment to start + push diagnostics.
await new Promise((r) => setTimeout(r, 500));
let diagOut = "";
for (let attempt = 0; attempt < 20; attempt++) {
  const res = await diagTool.execute({ path: sampleFile }, { toolCallId: "t1" });
  diagOut = res?.text ?? String(res);
  if (/server|starting|ready/i.test(diagOut) && /error|syntax/i.test(diagOut)) break;
  if (!/starting|not available|no client/i.test(diagOut)) break;
  await new Promise((r) => setTimeout(r, 250));
}
const cleanFileDiag = diagOut;
record(
  "lsp_diagnostics returns (mock server path)",
  cleanFileDiag.length > 0,
  cleanFileDiag.slice(0, 80).replace(/\n/g, " ")
);

// Write a version with the ERR marker, then trigger didChange via the write interceptor,
// and verify diagnostics pick it up.
const badFile = resolve(projectDir, "src", "bad.ts");
writeFileSync(badFile, "const x: number = 1; // ERR\n");
await syncWrite(badFile);
await new Promise((r) => setTimeout(r, 500));

let badOut = "";
for (let attempt = 0; attempt < 20; attempt++) {
  const res = await diagTool.execute({ path: badFile }, { toolCallId: "t2" });
  badOut = res?.text ?? String(res);
  if (/error/i.test(badOut)) break;
  if (!/starting|not available|no client/i.test(badOut)) break;
  await new Promise((r) => setTimeout(r, 250));
}
record(
  "lsp_diagnostics reports mock error after write",
  /error/i.test(badOut),
  badOut.slice(0, 120).replace(/\n/g, " ")
);

// ---- 7. tree-sitter fallback for lsp_diagnostics (no LSP server for a .py file) ----
const pyFile = resolve(projectDir, "src", "broken.py");
writeFileSync(pyFile, "def broken( { return 1 }\n");
const pyOut = await diagTool.execute({ path: pyFile }, { toolCallId: "t3" });
const pyText = pyOut?.text ?? String(pyOut);
record(
  "tree-sitter fallback reports syntax errors for .py",
  /syntax error|tree-sitter/i.test(pyText),
  pyText.slice(0, 100).replace(/\n/g, " ")
);

// ---- 8. lsp_symbols via mock server (documentSymbol) ----
const symTool = registeredTools.find((t) => t.name === "lsp_symbols");
// Ensure the sample file is open in the server (didOpen via read interceptor).
await syncRead(sampleFile);
let symOut = "";
for (let attempt = 0; attempt < 20; attempt++) {
  const res = await symTool.execute({ path: sampleFile }, { toolCallId: "t4" });
  symOut = res?.text ?? String(res);
  if (/greet|function/i.test(symOut)) break;
  if (!/starting|not available|no client/i.test(symOut)) break;
  await new Promise((r) => setTimeout(r, 250));
}
record("lsp_symbols returns document symbols", /greet/.test(symOut), symOut.slice(0, 120).replace(/\n/g, " "));

// ---- 9. lsp_hover via mock server ----
const hoverTool = registeredTools.find((t) => t.name === "lsp_hover");
let hoverOut = "";
for (let attempt = 0; attempt < 20; attempt++) {
  const res = await hoverTool.execute({ path: sampleFile, line: 2, character: 12 }, { toolCallId: "t5" });
  hoverOut = res?.text ?? String(res);
  if (/hover/i.test(hoverOut)) break;
  if (!/starting|not available|no client/i.test(hoverOut)) break;
  await new Promise((r) => setTimeout(r, 250));
}
record("lsp_hover returns hover text", /hover/i.test(hoverOut), hoverOut.slice(0, 120).replace(/\n/g, " "));

// ---- 10. Write/edit auto-diagnostics injection (tool:after interceptor) ----
// Simulate the write_file interceptor flow: emit tool:after:write_file with args + result,
// then check the result gained _lspDiagnostics when the file has an error.
const event = {
  type: "tool:after:write_file",
  payload: {
    toolName: "write_file",
    args: { path: badFile },
    result: { text: "wrote bad.ts" },
    durationMs: 5,
  },
  defaultReturn: undefined,
};
await eventBus.emit(event);
// Diagnostics land in `modifiedResult` (the model-facing result); the original
// tool result must stay untouched.
const injected = event.payload.modifiedResult?._lspDiagnostics;
record(
  "auto-diagnostics injected into write result (_lspDiagnostics)",
  typeof injected === "string" && /error/i.test(injected),
  typeof injected === "string" ? injected.slice(0, 100).replace(/\n/g, " ") : "none"
);

// ---- 11. toModelOutput decorator preserves diagnostics across rewrite ----
const rewrite = await diagTool.execute({ path: badFile }, { toolCallId: "t6" });
const rewriteText = rewrite?.text ?? String(rewrite);
record("lsp_diagnostics callable again (no decorator breakage)", rewriteText.length > 0);

// ---- 11b. Clean write must not stall on the diagnostics timeout ----
// Regression: auto-diagnostics used to poll until an error appeared, so a clean
// edit always burned AUTO_DIAG_SETTLE_TIMEOUT_MS (8s). Waiting for the publish
// that follows the write instead makes this return as soon as analysis finishes.
const cleanStart = Date.now();
const cleanEvent = {
  type: "tool:after:write_file",
  payload: {
    toolName: "write_file",
    args: { path: sampleFile },
    result: { text: "wrote sample.ts" },
    durationMs: 5,
  },
  defaultReturn: undefined,
};
await eventBus.emit(cleanEvent);
const cleanElapsed = Date.now() - cleanStart;
record(
  "clean write returns without waiting the settle timeout",
  cleanElapsed < 3000,
  `${cleanElapsed}ms (timeout is 8000ms)`
);
record(
  "clean write injects no diagnostics",
  cleanEvent.payload.modifiedResult?._lspDiagnostics === undefined,
  String(cleanEvent.payload.modifiedResult?._lspDiagnostics ?? "(none)")
);

// ---- 12. session:start with the same cwd reuses the active manager ----
// The bootstrap session:start follows activate() with the same root. Rebuilding there used to
// shut down and eagerly start every server a second time. The active manager (and its running
// mock server) must survive that event; a later disable/shutdown still reaps it.
const beforeStart = countMockServers();
await runner.emitSessionStart(projectDir, "sess-1");
await new Promise((r) => setTimeout(r, 100));
const afterStart = countMockServers();
record("session:start handler runs without throwing", true);
if (canCount) {
  record(
    "same-cwd session:start does not double-start language servers",
    afterStart <= beforeStart,
    `${afterStart} alive (before ${beforeStart}, baseline ${mockBaseline})`
  );
}

// ---- 13. tree-sitter structural tools actually work ----
// ast_search: find function declarations in the sample TS file.
const searchTool = registeredTools.find((t) => t.name === "ast_search");
const searchRes = await searchTool.execute(
  { pattern: "function $NAME($$$ARGS) { $$$BODY }", language: "typescript", path: "src" },
  { toolCallId: "ts1" }
);
const searchText = searchRes?.text ?? String(searchRes);
record(
  "ast_search finds functions by structure",
  /Found 1 match/.test(searchText) || /greet/.test(searchText),
  searchText.slice(0, 100).replace(/\n/g, " ")
);

// code_rewrite: dry-run preview of renaming greet → salute.
const rewriteTool = registeredTools.find((t) => t.name === "code_rewrite");
const tsRewriteRes = await rewriteTool.execute(
  {
    pattern: "function $NAME($$$ARGS) { $$$BODY }",
    replacement: "function salute($$$ARGS) { $$$BODY }",
    language: "typescript",
    path: "src",
    dry_run: true,
  },
  { toolCallId: "ts2" }
);
const tsRewriteText = tsRewriteRes?.text ?? String(tsRewriteRes);
record(
  "code_rewrite dry-run preview works",
  /salute/.test(tsRewriteText),
  tsRewriteText.slice(0, 100).replace(/\n/g, " ")
);

// code_rewrite: apply (dry_run=false) actually rewrites the file.
const rewriteApplyRes = await rewriteTool.execute(
  {
    pattern: "function $NAME($$$ARGS) { $$$BODY }",
    replacement: "function salute($$$ARGS) { $$$BODY }",
    language: "typescript",
    path: "src/sample.ts",
    dry_run: false,
  },
  { toolCallId: "ts3" }
);
const rewriteApplyText = rewriteApplyRes?.text ?? String(rewriteApplyRes);
record(
  "code_rewrite applies changes",
  /1 file/.test(rewriteApplyText) || /modified/.test(rewriteApplyText),
  rewriteApplyText.slice(0, 100).replace(/\n/g, " ")
);

// Verify the file was actually rewritten.
const { readFileSync } = await import("node:fs");
const rewritten = readFileSync(sampleFile, "utf-8");
record("code_rewrite changed file on disk", /salute/.test(rewritten));

// code_overview: project structure overview.
const overviewTool = registeredTools.find((t) => t.name === "code_overview");
const overviewRes = await overviewTool.execute({}, { toolCallId: "ts4" });
const overviewText = overviewRes?.text ?? String(overviewRes);
record(
  "code_overview returns project structure",
  /src|sample/.test(overviewText),
  overviewText.slice(0, 100).replace(/\n/g, " ")
);

// ---- 13b. Runtime disable must release the language servers immediately ----
const disabled = await runner.setEnabled("codent-lsp", false);
record("runtime disable deactivates the LSP extension", disabled.ok, disabled.message);
const afterDisable = await waitForMockServers(mockBaseline, 60, 200);
if (canCount) {
  record(
    "runtime disable shuts down LSP servers (no lingering children)",
    afterDisable <= mockBaseline,
    `${afterDisable} alive (baseline ${mockBaseline})`
  );
}

// ---- 14. Cleanup: session:shutdown must shut down all LSP servers (child processes) ----
// code_rewrite applies changes through fileSync.handleFileWrite (fire-and-forget),
// so a server can be lazily starting here. Wait the teardown out instead of exiting
// mid-shutdown (that is what used to orphan the mock server child).
await runner.emitSessionShutdown("sess-1");
const afterShutdown = await waitForMockServers(mockBaseline, 60, 200);
if (canCount) {
  record(
    "session:shutdown shuts down LSP servers (no lingering children)",
    afterShutdown <= mockBaseline,
    `${afterShutdown} alive (baseline ${mockBaseline})`
  );
}

// ---- Cleanup ----
await runner.destroyAll();
core.clearCoreEnv();
const atExit = await waitForMockServers(mockBaseline, 10, 200);
if (canCount) {
  record("no orphaned mock server at exit", atExit <= mockBaseline, `${atExit} alive (baseline ${mockBaseline})`);
}

const failed = results.filter((r) => !r.ok);
console.log("\n=== LSP EXTENSION VALIDATION ===");
console.log(`Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  process.exit(1);
}
console.log("All extension checks passed ✅");

// Exit without `process.exit()`.
//
// A forced exit while handles are still closing trips libuv's shutdown assertion on Windows
// (`!(handle->flags & UV_HANDLE_CLOSING)`, src/win/async.c) — observed here with the mock LSP
// child and several sockets still live, *after* the success line, so the script reported
// "all checks passed" and still exited non-zero. Letting the event loop drain avoids it; the
// timer is a backstop for a handle that outlives its owner, in which case the exit code stays
// 0 and the run is reported as a timeout by the suite rather than as a false pass.
setTimeout(() => process.exit(0), 500).unref();
