/**
 * Validates that a failure after root bootstrap tears down resources acquired before the
 * agent reached the manager registry.
 *
 * Run: pnpm --filter @codent/core run validate:create-bootstrap-rollback
 */

import assert from "node:assert/strict";

import {
  AgentLog,
  AgentManager,
  AgentRuntime,
  buildManagedAgent,
  clearCoreEnv,
  ManagedAgent,
  McpManager,
  MemoryManager,
  SessionStore,
  registerCoreEnv,
} from "../dist/dev.mjs";

const env = {
  rootPath: "/tmp/create-bootstrap-rollback",
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
  path: {
    join: (...parts) => parts.join("/"),
    resolve: (...parts) => parts.join("/"),
    dirname: (p) => p.slice(0, p.lastIndexOf("/")) || "/",
    basename: (p, ext) => {
      const base = p.split("/").pop() ?? p;
      return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
    },
    extname: (p) => p.slice(p.lastIndexOf(".")),
    isAbsolute: (p) => p.startsWith("/"),
    normalize: (p) => p,
    getSep: () => "/",
    parse: (p) => ({ root: "/", dir: "/", base: p, name: p, ext: "" }),
  },
  fs: {
    exists: async () => true,
    readFile: async () => {
      throw new Error("session log read failed");
    },
    writeFile: async () => {},
    appendFile: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ isDirectory: false, isFile: true, size: 0, mtime: new Date() }),
    remove: async () => {},
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
};

registerCoreEnv(env);
const runtime = new AgentRuntime({ env });
const manager = new AgentManager(runtime);
const originalCleanup = ManagedAgent.prototype.disposeBuiltResources;
let cleanupCalls = 0;
ManagedAgent.prototype.disposeBuiltResources = async function () {
  cleanupCalls += 1;
  return originalCleanup.call(this);
};

const originalStoreCreate = SessionStore.prototype.create;
try {
  // Force the failure after bootstrap but before the manager registers the agent.
  // (The factory no longer loads the transcript just to adopt its id, so a failing
  // session-log read is no longer a post-bootstrap failure point.)
  SessionStore.prototype.create = () => {
    throw new Error("session placeholder creation failed");
  };
  await assert.rejects(
    () =>
      buildManagedAgent({
        config: {
          name: "bootstrap-rollback",
          model: "test-model",
          initialSessionId: "ses_failing_create",
          // Keep bootstrap on the deterministic failure: the session placeholder cannot be made.
          skills: false,
          memory: false,
          mcp: false,
          lsp: false,
          codeMode: false,
        },
        manager,
        runtime,
        getDefaultSkillDirs: async () => [],
      }),
    /session placeholder creation failed/
  );
  assert.equal(cleanupCalls, 1, "the failed build invokes built-resource cleanup");
  assert.deepEqual(manager.getAgents(), [], "the half-built agent never reaches the registry");
} finally {
  ManagedAgent.prototype.disposeBuiltResources = originalCleanup;
  SessionStore.prototype.create = originalStoreCreate;
}

// The failure path must actually release the resources it claims to release, not just
// invoke a cleanup method. Exercise each owner with a fake/spied resource.
{
  const managed = new ManagedAgent(
    { name: "cleanup-probe", model: "test-model" },
    { log: new AgentLog(), tools: {}, todoManager: null }
  );
  const memory = new MemoryManager({ rootPath: env.rootPath, env });
  memory.scheduleRefreshIndex();
  assert.ok(memory.refreshTimeout, "the memory index debounce must be armed");
  managed.setMemoryManager(memory);

  const child = {
    killed: false,
    kill: () => {
      child.killed = true;
    },
  };
  const transport = {};
  const mcp = new McpManager({
    ...env,
    getMCPTransportProcess: () => child,
  });
  // The manager owns this private list; seed it so forceKill exercises the real
  // transport/child path rather than a fake manager method.
  mcp.stdioTransports = [transport];
  managed.setMcpManager(mcp);

  let runnerDestroys = 0;
  let sinkDetaches = 0;
  managed.extensions.setExtensionRunner({
    destroyAll: async () => {
      runnerDestroys += 1;
    },
  });
  managed.manager = {
    getLogExtension: () => ({
      attachSink: () => () => {
        sinkDetaches += 1;
      },
    }),
  };
  managed.bindSessionLogSink("ses_cleanup");

  await managed.disposeBuiltResources();
  assert.equal(child.killed, true, "cleanup force-kills the real MCP transport child");
  assert.equal(runnerDestroys, 1, "cleanup destroys the extension runner (LSP included)");
  assert.equal(memory.refreshTimeout, undefined, "cleanup clears the memory debounce timer");
  assert.equal(sinkDetaches, 1, "cleanup releases the log sink");
}

// AgentManager.dispose() closes the root log extension and its sink registry.
{
  const manager = new AgentManager();
  const log = new AgentLog();
  manager.getLogExtension().attachSink(log, { dir: ".agents/logs/ses_cleanup", env });
  assert.equal(manager.getLogExtension().getAttachedSinkCount(), 1);
  await manager.dispose();
  assert.equal(manager.getLogExtension().getAttachedSinkCount(), 0, "manager dispose releases every log sink");
  await manager.dispose(); // idempotent
}

// Close the manager used by the failed bootstrap probe too (no sinks/agents remain).
await manager.dispose();

clearCoreEnv();
console.log("create-bootstrap-rollback validation passed");
