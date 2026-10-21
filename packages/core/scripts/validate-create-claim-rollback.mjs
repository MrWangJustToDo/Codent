/**
 * Validates that a root create whose initial session is already owned by another live agent does
 * not leave a half-built agent in the registry or a second log sink on that session.
 *
 * Run: pnpm --filter @codent/core run validate:create-claim-rollback
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentManager, clearCoreEnv, registerCoreEnv } from "../dist/dev.mjs";

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "create-claim-rollback-"));
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

const config = {
  name: "create-claim",
  model: "test-model",
  modelStyle: "openai",
  skillDirs: [],
  agentDocFilenames: [],
  memory: false,
  mcp: false,
  lsp: false,
  skills: false,
  codeMode: false,
};

const manager = new AgentManager();
try {
  const first = await manager.createManagedAgent(config);
  const firstSession = first.getSessionData();
  assert.ok(firstSession, "first root has a session");
  await first.getSessionStore()?.save(firstSession);

  assert.equal(
    manager.acquireSessionOwnership(firstSession.id, "probe-agent"),
    false,
    "the live root owns its active session"
  );

  await assert.rejects(
    () => manager.createManagedAgent({ ...config, name: "second", initialSessionId: firstSession.id }),
    /already active in another live session/,
    "a foreign initial session is refused"
  );
  assert.equal(manager.getAgents().length, 1, "the refused agent is removed from the registry");
  assert.equal(manager.getAgents()[0].id, first.id);
} finally {
  manager.reset();
  await manager.settleTeardowns();
  clearCoreEnv();
  await fs.promises.rm(rootPath, { recursive: true, force: true });
}

console.log("create-claim-rollback validation passed");
