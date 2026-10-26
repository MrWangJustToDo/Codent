/**
 * Validation: mid-startup shutdown — no child-process leak when a session ends
 * while an LSP server is still performing its initialize handshake.
 *
 * Run: pnpm --filter @codent/core run validate:lsp-midstartup-shutdown
 *
 * Uses a slow-initializing mock server (SLOW_MS=2000). Sequence:
 *   1. activate extension with slow mock server for "typescript"
 *   2. call lsp_diagnostics → server starts but handshake takes 2s (still "starting")
 *   3. immediately emit session:shutdown (mid-startup)
 *   4. wait until initialize would have resolved → child must be torn down (0 processes)
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createMockServerCounter } from "./process-count.mjs";

const SLOW_SERVER = resolve(import.meta.dirname, "slow-mock-lsp-server.mjs");
// Scope the process count to THIS run's children — see process-count.mjs. Named for the slow
// basename, so a concurrent fast-server validator can never be counted here either.
const serverCounter = createMockServerCounter("lsp-midstartup", "slow-mock-lsp-server.mjs");
const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// Reaping is only assertable where processes are observable. The counter emits the skip itself;
// a null count means assert nothing rather than compare against a fabricated 0 (the value that
// means "none running").
function countSlowProcesses() {
  return serverCounter.observe("slow mock-server reaping");
}

function waitForCount(target, attempts, delayMs) {
  return new Promise((resolveP) => {
    let n = 0;
    const tick = () => {
      const c = countSlowProcesses();
      if (c === target || n++ >= attempts) return resolveP(c);
      setTimeout(tick, delayMs);
    };
    tick();
  });
}

// ---- Setup ----
const projectDir = mkdtempSync(resolve(tmpdir(), "lsp-midstart-"));
writeFileSync(
  resolve(projectDir, ".lsp.json"),
  JSON.stringify({
    servers: { typescript: { command: process.execPath, args: [SLOW_SERVER, ...serverCounter.getTagArgs()] } },
  })
);
writeFileSync(resolve(projectDir, "a.ts"), "export const a = 1;\n");

const nodePkg = await import("@codent/node");
const core = await import("@codent/core");
const env = nodePkg.createNodeEnv({ rootPath: projectDir, cwd: projectDir, platform: "linux" });
core.registerCoreEnv(env);

const coreDistDir = resolve(import.meta.dirname, "..", "dist");
const dev = await import(pathToFileURL(resolve(coreDistDir, "dev.mjs")).href);
const { ExtensionRunner } = dev;

const tools = [];
const runner = new ExtensionRunner({
  onRegisterTool: (d) => tools.push(d),
  cwd: projectDir,
  getCoreEnv: () => env,
});
await runner.loadExtension(await dev.createLspExtension());
const diag = tools.find((t) => t.name === "lsp_diagnostics");

// ---- 1. Trigger start (server will take 2s to handshake) ----
const p = diag.execute({ path: resolve(projectDir, "a.ts") }, { toolCallId: "t1" }).catch(() => null);
await new Promise((r) => setTimeout(r, 300)); // enough for spawn; handshake still in flight
const midStart = countSlowProcesses();
const canCount = midStart !== null;
if (canCount) {
  record("slow server spawned (handshake in progress)", midStart === 1, `${midStart} process(es)`);
}

// ---- 2. Shutdown mid-startup ----
await runner.emitSessionShutdown("sess-1");

// ---- 3. Wait past the handshake delay; child must be cleaned up ----
const after = await waitForCount(0, 30, 250); // up to ~7.5s > 2s handshake + teardown
if (canCount) {
  record("mid-startup shutdown leaves no lingering child", after === 0, `${after} process(es)`);
}

await p; // let the diag promise settle (it should reject/resolve harmlessly)
await runner.destroyAll();
core.clearCoreEnv();

const failed = results.filter((r) => !r.ok);
console.log("\n=== LSP MID-STARTUP SHUTDOWN VALIDATION ===");
console.log(`Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
console.log("All mid-startup shutdown checks passed ✅");
process.exit(0);
