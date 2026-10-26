/**
 * Validation: LSP server lifecycle — session:start/session:shutdown cleanup.
 *
 * Run: pnpm --filter @codent/core run validate:lsp-lifecycle
 *
 * Server startup is LAZY (triggered by an LSP tool call, not by read_file —
 * read_file only didOpen's an already-running server). This validation:
 *   1. activate extension (node CoreEnv + mock server)
 *   2. call lsp_diagnostics → lazy-start mock server (child process)
 *   3. session:start (new cwd) → old manager shutdownAll (old child gone)
 *   4. call lsp_diagnostics in new cwd → new server starts
 *   5. session:shutdown → all children gone (this run's tagged mock servers, count 0)
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createMockServerCounter } from "./process-count.mjs";

const MOCK_SERVER = resolve(import.meta.dirname, "mock-lsp-server.mjs");
// Scope the process count to THIS run's children. The fast mock server is spawned by several LSP
// validators at once, so an unscoped `pgrep` baseline mixes concurrent runs together and goes
// stale mid-run (observed as `-1 left (baseline 1)`). The counter tags the spawned child's argv.
const serverCounter = createMockServerCounter("lsp-lifecycle");
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// Reaping is only assertable where processes are observable. The counter emits the skip itself;
// a null count means assert nothing rather than compare against a fabricated 0, which is the
// value that means "all children gone".

function waitForCount(target, attempts = 20, delayMs = 250) {
  return new Promise((resolveP) => {
    let n = 0;
    const tick = () => {
      const c = serverCounter.count();
      if (c === null || c === target || n++ >= attempts) return resolveP(c);
      setTimeout(tick, delayMs);
    };
    tick();
  });
}

// ---- Setup project dirs ----
const projectA = mkdtempSync(resolve(tmpdir(), "lsp-lifecycle-a-"));
const projectB = mkdtempSync(resolve(tmpdir(), "lsp-lifecycle-b-"));
for (const p of [projectA, projectB]) {
  writeFileSync(
    resolve(p, ".lsp.json"),
    JSON.stringify({
      servers: { typescript: { command: process.execPath, args: [MOCK_SERVER, ...serverCounter.getTagArgs()] } },
    })
  );
  writeFileSync(resolve(p, "a.ts"), "export const a: number = 1;\n");
}

// ---- Wire up ----
const nodePkg = await import("@codent/node");
const core = await import("@codent/core");
const env = nodePkg.createNodeEnv({ rootPath: projectA, cwd: projectA, platform: "linux" });
core.registerCoreEnv(env);

const coreDistDir = resolve(import.meta.dirname, "..", "dist");
const dev = await import(pathToFileURL(resolve(coreDistDir, "dev.mjs")).href);
const { ExtensionRunner } = dev;

const registeredTools = [];
const runner = new ExtensionRunner({
  onRegisterTool: (def) => registeredTools.push(def),
  cwd: projectA,
  getCoreEnv: () => env,
});
await runner.loadExtension(await dev.createLspExtension());
const diagTool = registeredTools.find((t) => t.name === "lsp_diagnostics");

// The count is scoped to this run's tagged children (see process-count.mjs), so a peer
// validator's mock server can never enter the baseline. The delta-against-baseline form is kept
// as a second guard: a crashed earlier run can still leave *this* tag behind (tag = pid + random).
const baseline = serverCounter.observe();
// `null` = this platform cannot count processes. Assert nothing rather than comparing
// against a fabricated 0, which is the value that means "all children gone".
const canCount = baseline !== null;

// ---- 1. lsp_diagnostics triggers lazy start in project A ----
await diagTool.execute({ path: resolve(projectA, "a.ts") }, { toolCallId: "t1" });
const afterA = await waitForCount(baseline + 1);
if (canCount) {
  record(
    "lsp_diagnostics lazy-starts mock server (A)",
    afterA === baseline + 1,
    `${afterA - baseline} new process(es)`
  );
}
// Let the server finish its initialize handshake so a later shutdown() is clean.
await new Promise((r) => setTimeout(r, 1200));

// ---- 2. session:start with a NEW cwd (project B) → old server torn down ----
await runner.emitSessionStart(projectB, "sess-1");
// emitSessionStart is fire-and-forget (void emit); wait for shutdown to complete.
const afterStartB = await waitForCount(baseline, 30, 200);
if (canCount) {
  record(
    "session:start tears down old manager's server",
    afterStartB === baseline,
    `${afterStartB - baseline} left (baseline ${baseline})`
  );
}

// ---- 3. lsp_diagnostics in project B → new server starts ----
await diagTool.execute({ path: resolve(projectB, "a.ts") }, { toolCallId: "t2" });
const afterB = await waitForCount(baseline + 1);
if (canCount) {
  record(
    "lsp_diagnostics starts server for new manager (B)",
    afterB === baseline + 1,
    `${afterB - baseline} new process(es)`
  );
}

// ---- 4. session:shutdown → all servers torn down ----
await runner.emitSessionShutdown("sess-1");
const afterShutdown = await waitForCount(baseline, 40, 200);
if (canCount) {
  record(
    "session:shutdown tears down all servers",
    afterShutdown === baseline,
    `${afterShutdown - baseline} left (baseline ${baseline})`
  );
}

await runner.destroyAll();
core.clearCoreEnv();

const failed = results.filter((r) => !r.ok);
console.log("\n=== LSP LIFECYCLE VALIDATION ===");
console.log(`Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
console.log("All lifecycle checks passed ✅");
process.exit(0);
