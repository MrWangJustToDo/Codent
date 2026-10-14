/**
 * End-to-end assembly validation: code-mode extension via the public host path.
 *
 * Registers a real Node CoreEnv (which provides `createIsolateDriver` backed by
 * isolated-vm), builds a managed agent through `agentManager.createManagedAgent`,
 * then asserts:
 *   1. `execute_typescript` (+ `discover_tools`) are registered on managed.tools.
 *   2. No sandbox-internal tools leaked into the agent tool set (only the curated
 *      external subset is exposed inside the sandbox).
 *   3. With `codeMode: false`, no code-mode tools are registered (disable path).
 *
 * Run: pnpm --filter @codent/node run validate:code-mode-assembly
 */
import { agentManager, clearCoreEnv, registerCoreEnv } from "@codent/core";
import { createNodeEnv } from "@codent/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
}

const rootPath = mkdtempSync(join(tmpdir(), "cm-assembly-"));

async function buildAgent(codeMode) {
  registerCoreEnv(createNodeEnv({ rootPath }));
  const managed = await agentManager.createManagedAgent({
    name: "code-mode-assembly",
    model: "test-model",
    codeMode, // true (default wiring) or false (disable)
    // Keep other built-ins quiet to isolate the code-mode path.
    lsp: false,
    skills: false,
    memory: false,
    mcp: false,
  });
  return managed;
}

try {
  // ---- With codeMode enabled (default host provides createIsolateDriver) ------
  const managed = await buildAgent(true);
  const toolNames = Object.keys(managed.tools);
  check("execute_typescript registered", toolNames.includes("execute_typescript"));
  check("discover_tools registered (lazy tools present)", toolNames.includes("discover_tools"));

  // Code-mode sandbox tools should NOT appear as agent-facing tools — the curated
  // external_* bindings live inside the isolate, not in the agent tool set.
  const sandboxLeaks = toolNames.filter((n) => n.startsWith("external_"));
  check("no external_* tools leaked into agent tools", sandboxLeaks.length === 0);
} finally {
  clearCoreEnv();
}

try {
  // ---- With codeMode: false, nothing is registered ----------------------------
  const managed = await buildAgent(false);
  const toolNames = Object.keys(managed.tools);
  check("codeMode:false -> no execute_typescript", !toolNames.includes("execute_typescript"));
  check("codeMode:false -> no discover_tools", !toolNames.includes("discover_tools"));
} finally {
  clearCoreEnv();
  rmSync(rootPath, TEMP_RM_OPTIONS);
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
