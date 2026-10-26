/**
 * Validation: end-to-end auto-diagnostics with REAL typescript-language-server.
 *
 * Verifies the production wiring (ExtensionRunner → createLspExtension) with the
 * real TLS server + real node transport: writing a file with syntax errors via the
 * write interceptor injects `_lspDiagnostics` into the tool result.
 *
 * Run: pnpm --filter @codent/core run validate:lsp-real-server
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Printed when this validator is skipping rather than verifying. The suite reads this marker
 * to report a skip instead of counting the `exit 0` as a pass — without it, a run where the
 * language server is absent is indistinguishable from a run that checked everything.
 */
const SKIP_MARKER = "[validator-skip]";

// This validation needs a real typescript-language-server. Skip explicitly (not silently)
// when it is absent (no global install, no project-local bin).
//
// The probe goes through production code (`CoreEnv.commandExists`) rather than
// `spawnSync("sh", ["-c", "command -v ..."])`: that form is POSIX-only, so on Windows it
// could never find the server and the run degraded to a silent pass — a false green.
const probeEnv = (await import("@codent/node")).createNodeEnv({ rootPath: process.cwd() });
const hasServer = await probeEnv.commandExists?.("typescript-language-server").catch(() => false);
if (!hasServer) {
  console.log(`${SKIP_MARKER} typescript-language-server not found on PATH — real-server validation skipped`);
  process.exit(0);
}

// ---- Boot a temp project dir (NOT hidden) with a sample file ----
const projectDir = mkdtempSync(resolve(tmpdir(), "lsp-real-"));
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

// Register CoreEnv (node)
const nodePkg = await import("@codent/node");
const core = await import("@codent/core");
const env = nodePkg.createNodeEnv({ rootPath: projectDir, cwd: projectDir, platform: "linux" });
core.registerCoreEnv(env);

const coreDistDir = resolve(import.meta.dirname, "..", "dist");
const dev = await import(pathToFileURL(resolve(coreDistDir, "dev.mjs")).href);
const { ExtensionRunner } = dev;

const registeredTools = [];
const runner = new ExtensionRunner({
  onRegisterTool: (def) => registeredTools.push(def),
  onRegisterCommand: () => {},
  cwd: projectDir,
  getCoreEnv: () => env,
});

const api = await dev.createLspExtension();
const instance = await runner.loadExtension(api);
record("extension activates (state=active)", instance.state === "active", instance.error?.message ?? "no error");
if (instance.state !== "active") process.exit(1);

const eventBus = runner.getEventBus();
async function syncWrite(filePath, resultText = "ok") {
  await eventBus.emit({
    type: "tool:after:write_file",
    payload: { toolName: "write_file", args: { path: filePath }, result: { text: resultText }, durationMs: 5 },
    defaultReturn: undefined,
  });
}

// ---- Write a file with syntax errors, then trigger the write interceptor ----
const badFile = resolve(projectDir, "src", "bad.ts");
writeFileSync(
  badFile,
  `export function brokenDemo(input: string): string {
  const bad = "unterminated string
  const missingName = ;
  return input.toUpperCase(
}
`
);

await syncWrite(badFile, "wrote bad.ts");

// The write interceptor waits for the server to publish diagnostics for the written file.
// Wait for server startup + analysis.
await new Promise((r) => setTimeout(r, 8000));

const diagTool = registeredTools.find((t) => t.name === "lsp_diagnostics");
let diagOut = "";
for (let attempt = 0; attempt < 30; attempt++) {
  const res = await diagTool.execute({ path: badFile }, { toolCallId: "t1" });
  diagOut = res?.text ?? String(res);
  if (/error/i.test(diagOut)) break;
  if (!/starting|not available|no client/i.test(diagOut)) break;
  await new Promise((r) => setTimeout(r, 500));
}
record(
  "lsp_diagnostics reports real TLS errors after write",
  /error/i.test(diagOut),
  diagOut.slice(0, 200).replace(/\n/g, " ")
);

// ---- Verify the write interceptor injected _lspDiagnostics into the result ----
// Diagnostics are attached to `payload.modifiedResult` (the model-facing result),
// not to the original tool result.
console.log("\n--- auto-diagnostics injection (_lspDiagnostics) ---");

// Re-emit a write event and inspect the modifiedResult the interceptor produces.
const injectedResult = { text: "wrote bad.ts" };
const injEvent = {
  type: "tool:after:write_file",
  payload: { toolName: "write_file", args: { path: badFile }, result: injectedResult, durationMs: 5 },
  defaultReturn: undefined,
};
await eventBus.emit(injEvent);
// The interceptor waits for the publish that follows the write; give it a bit more
// for a warm server to finish analyzing.
await new Promise((r) => setTimeout(r, 4000));
const diagField = injEvent.payload.modifiedResult?._lspDiagnostics;
record(
  "_lspDiagnostics injected into modifiedResult",
  typeof diagField === "string" && /error/i.test(diagField),
  String(diagField ?? "(absent)")
    .slice(0, 200)
    .replace(/\n/g, " ")
);

// ---- Cleanup: shutdown all servers ----
await runner.emitSessionEnd?.("sess-1").catch?.(() => {});
await instance.deactivate?.().catch?.(() => {});
await runner.shutdown?.().catch?.(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n=== REAL TLS SERVER VALIDATION ===`);
console.log(`Total: ${results.length}, Passed: ${results.length - failed.length}, Failed: ${failed.length}`);
process.exit(failed.length ? 1 : 0);
