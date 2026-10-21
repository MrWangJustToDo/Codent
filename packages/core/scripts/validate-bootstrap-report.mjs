/**
 * Validates bootstrap accounting: every attempted extension load lands in exactly one of
 * active/failed, including fail-open activation errors and loaders that threw before producing
 * an instance. This is the invariant the old per-site counters violated.
 *
 * Run: pnpm --filter @codent/core run validate:bootstrap-report
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AgentManager,
  buildManagedAgent,
  clearCoreEnv,
  createBootstrapReport,
  recordExtensionError,
  recordExtensionResult,
  registerCoreEnv,
} from "../dist/dev.mjs";

const report = createBootstrapReport();
assert.deepEqual(report.extensions, { attempted: 0, active: 0, failed: 0, failures: [] });

assert.equal(recordExtensionResult(report, "disk", { id: "active-ext", state: "active" }), true);
assert.deepEqual(report.extensions, {
  attempted: 1,
  active: 1,
  failed: 0,
  failures: [],
});

assert.equal(
  recordExtensionResult(report, "config", {
    id: "failed-ext",
    state: "error",
    error: { message: "activation exploded" },
  }),
  false
);
assert.deepEqual(report.extensions.failures, [{ id: "failed-ext", error: "activation exploded" }]);

assert.equal(
  recordExtensionResult(report, "builtin", { id: "other-error", state: "error" }),
  false,
  "an activation error without a message still counts as a failure"
);
assert.deepEqual(report.extensions.failures.at(-1), { id: "other-error", error: "unknown" });

recordExtensionError(report, "factory", new Error("create failed"));
assert.deepEqual(report.extensions.failures.at(-1), { id: "factory", error: "create failed" });

assert.equal(report.extensions.attempted, report.extensions.active + report.extensions.failed);
assert.deepEqual(
  { attempted: report.extensions.attempted, active: report.extensions.active, failed: report.extensions.failed },
  { attempted: 4, active: 1, failed: 3 },
  "attempted is active + failed, across all load paths"
);

// ---------------------------------------------------------------------------
// 2. Real bootstrap: a throwing config factory is one attempted + one failed
// ---------------------------------------------------------------------------
{
  const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bootstrap-report-"));
  const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));
  registerCoreEnv({
    rootPath,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    fs: {
      readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding ?? "utf-8"),
      writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
      appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
      rename: async (from, to) => fs.promises.rename(toAbs(from), toAbs(to)),
      mkdir: async (p) => fs.promises.mkdir(toAbs(p), { recursive: true }),
      exists: async (p) =>
        fs.promises.access(toAbs(p)).then(
          () => true,
          () => false
        ),
      readdir: async (p) => {
        try {
          const entries = await fs.promises.readdir(toAbs(p), { withFileTypes: true });
          return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
        } catch {
          return [];
        }
      },
      stat: async (p) => {
        const st = await fs.promises.stat(toAbs(p));
        return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
      },
      remove: async (p) => fs.promises.rm(toAbs(p), { recursive: true, force: true }),
    },
    runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
  });

  const manager = new AgentManager();
  try {
    const built = await buildManagedAgent({
      config: {
        name: "bootstrap-report",
        model: "test-model",
        modelStyle: "openai",
        skillDirs: [],
        agentDocFilenames: [],
        memory: false,
        mcp: false,
        lsp: false,
        skills: false,
        codeMode: false,
        extensions: [
          {
            create: async () => {
              throw new Error("factory boom");
            },
          },
        ],
      },
      manager,
      getDefaultSkillDirs: async () => [],
    });

    const report = built.bootstrap.report;
    assert.ok(report, "root bootstrap returns a report");
    assert.equal(report.extensions.attempted, 2, "Jobs (active) + config factory (failed)");
    assert.equal(report.extensions.active, 1);
    assert.equal(report.extensions.failed, 1);
    assert.equal(report.extensions.failures[0].id, "config");
    assert.match(report.extensions.failures[0].error, /factory boom/);
    assert.equal(report.extensions.attempted, report.extensions.active + report.extensions.failed);
    assert.deepEqual(report.memory, { enabled: false });

    built.managed.getExtensionRunner()?.destroyAll?.();
  } finally {
    clearCoreEnv();
    await fs.promises.rm(rootPath, { recursive: true, force: true });
  }
}

console.log("bootstrap-report validation passed");
