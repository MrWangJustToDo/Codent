/**
 * Validates instantiable agent runtimes (`CodentAgent` + `AgentRuntime`).
 *
 * Stage 2 (additive): each `CodentAgent` owns a distinct runtime — its own env,
 * provider, manager, name, and session list — and the ambient env registry still
 * backs `getEnv()` for code that has no runtime in scope.
 *
 * Run: pnpm --filter @codent/core run validate:agent-runtime-instances
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
  AgentRuntime,
  clearCoreEnv,
  CodentAgent,
  createListFileTool,
  getEnv,
  registerCoreEnv,
  resolveModelConfigFromProvider,
} from "../dist/dev.mjs";

/** Minimal CoreEnv stub: create() only reads `rootPath`; dispose reads `destroy?`. */
const fakeEnv = (root) => ({
  rootPath: root,
  fs: {},
  path: { resolve: (...p) => p.join("/") },
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
  runCommand: async () => ({}),
  exec: async () => ({}),
  fetch: async () => new Response(""),
});

// ---------------------------------------------------------------------------
// 1. AgentRuntime carries env/provider/name; name defaults to the root basename
// ---------------------------------------------------------------------------
{
  const env = fakeEnv("/workspaces/project-alpha");
  const runtime = new AgentRuntime({ env });
  assert.equal(runtime.rootPath, "/workspaces/project-alpha");
  assert.equal(runtime.name, "project-alpha", "name defaults to the workspace root basename");
  assert.equal(runtime.env.rootPath, "/workspaces/project-alpha", "runtime carries its env (resolved copy)");
  assert.ok(runtime.id.startsWith("rt"), "the runtime carries a stable id");

  const named = new AgentRuntime({ env, name: "custom" });
  assert.equal(named.name, "custom", "an explicit name wins");
}

// ---------------------------------------------------------------------------
// 2. Two CodentAgents are isolated runtimes
// ---------------------------------------------------------------------------
{
  const a = await CodentAgent.create({
    env: fakeEnv("/tmp/runtime-a"),
    direct: { model: "m-a", style: "openai", baseURL: "http://a", apiKey: "key-a" },
    name: "Alpha",
  });
  const b = await CodentAgent.create({
    env: fakeEnv("/tmp/runtime-b"),
    direct: { model: "m-b", style: "openai", baseURL: "http://b", apiKey: "key-b" },
  });

  assert.notEqual(a.id, b.id, "each runtime has its own id");
  assert.notEqual(a.getEnv(), b.getEnv(), "each runtime has its own env");
  assert.notEqual(a.getManager(), b.getManager(), "each runtime has its own manager");
  assert.equal(a.getRootPath(), "/tmp/runtime-a");
  assert.equal(b.getRootPath(), "/tmp/runtime-b");
  assert.equal(a.getName(), "Alpha", "explicit runtime name");
  assert.equal(b.getName(), "runtime-b", "default runtime name from the root basename");

  assert.deepEqual(await a.listSessions(), [], "runtime A owns no sessions");
  assert.deepEqual(await b.listSessions(), [], "runtime B owns no sessions (no shared registry)");

  // Provider isolation: the host exposes the runtime provider, and model resolution
  // through it resolves THAT runtime's connection (not the ambient registry).
  assert.equal(a.host.getModelProvider(), a.getModelProvider(), "the local host exposes its runtime's provider");
  const { connection: connA } = await resolveModelConfigFromProvider({}, a.host.getModelProvider());
  const { connection: connB } = await resolveModelConfigFromProvider({}, b.host.getModelProvider());
  assert.equal(connA.baseURL, "http://a");
  assert.equal(connA.apiKey, "key-a");
  assert.equal(connA.model, "m-a");
  assert.equal(connB.baseURL, "http://b");
  assert.equal(connB.apiKey, "key-b");
  assert.equal(connB.model, "m-b");
  assert.notEqual(connA.apiKey, connB.apiKey, "each runtime resolves its own provider key");

  await a.dispose();
  await b.dispose();
}

// ---------------------------------------------------------------------------
// 3. Ambient fallback keeps the legacy bootstrap working
// ---------------------------------------------------------------------------
{
  registerCoreEnv(fakeEnv("/tmp/ambient"));
  assert.equal(getEnv().rootPath, "/tmp/ambient", "getEnv() resolves the ambient runtime");
  clearCoreEnv();
}

// ---------------------------------------------------------------------------
// 4. A real tool run resolves the CALLING runtime's env (two runtimes in flight)
// ---------------------------------------------------------------------------
{
  const makeNodeEnv = (root) => ({
    rootPath: root,
    fs: {
      exists: async (p) => {
        try {
          statSync(join(root, p));
          return true;
        } catch {
          return false;
        }
      },
      readdir: async (p) =>
        readdirSync(join(root, p)).map((name) => {
          const s = statSync(join(root, p, name));
          return { name, type: s.isDirectory() ? "directory" : "file", size: s.size, mtime: s.mtime };
        }),
      stat: async (p) => {
        const s = statSync(join(root, p));
        return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtime };
      },
      readFile: async () => "",
      writeFile: async () => {},
      mkdir: async () => {},
      remove: async () => {},
    },
    path: { resolve: (...a) => a.join("/"), join: (...a) => a.join("/"), extname: (p) => p.slice(p.lastIndexOf(".")) },
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => root,
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    fetch: async () => new Response(""),
  });

  const rootA = mkdtempSync(join(tmpdir(), "rt-inst-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "rt-inst-b-"));
  writeFileSync(join(rootA, "a-only.txt"), "A");
  writeFileSync(join(rootB, "b-only.txt"), "B");

  const agentA = await CodentAgent.create({ env: makeNodeEnv(rootA), name: "A" });
  const agentB = await CodentAgent.create({ env: makeNodeEnv(rootB), name: "B" });
  const tool = createListFileTool();

  const [outA, outB] = await Promise.all([
    tool.execute({ path: "." }, { context: { agentId: "a", coreEnv: agentA.getEnv() }, toolCallId: "a" }),
    tool.execute({ path: "." }, { context: { agentId: "b", coreEnv: agentB.getEnv() }, toolCallId: "b" }),
  ]);
  const sa = JSON.stringify(outA);
  const sb = JSON.stringify(outB);
  assert.ok(sa.includes("a-only.txt") && !sa.includes("b-only.txt"), "runtime A's tool lists only A's workspace");
  assert.ok(sb.includes("b-only.txt") && !sb.includes("a-only.txt"), "runtime B's tool lists only B's workspace");

  await agentA.dispose();
  await agentB.dispose();
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. A managed agent on a second runtime loads ITS OWN project instructions
//
// The ambient-reads bug this guards: project-instruction loading used the process-global
// getEnv(), so runtime B (a different root) either loaded A's AGENTS.md or nothing. This
// creates a real managed agent on each runtime and asserts each reads its own root.
// ---------------------------------------------------------------------------
{
  const realEnv = (root) => {
    // `isAbsolute` (node:path), not `startsWith("/")`: on Windows `root` is `C:\...`,
    // so a POSIX-only check would treat core's already-absolute memory/log paths as
    // relative and re-join the root onto itself.
    const abs = (p) => (isAbsolute(p) ? p : join(root, p));
    return {
      rootPath: root,
      path: {
        resolve: (...a) => a.join("/"),
        join: (...a) => a.join("/"),
        dirname: (p) => p.slice(0, p.lastIndexOf("/")) || "/",
        basename: (p, ext) => {
          const b = p.split("/").pop() ?? p;
          return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
        },
        extname: (p) => p.slice(p.lastIndexOf(".")),
        isAbsolute: (p) => p.startsWith("/"),
        normalize: (p) => p,
        parse: (p) => {
          const base = p.split("/").pop() ?? "";
          const i = base.lastIndexOf(".");
          return { root: "", dir: "", base, name: i > 0 ? base.slice(0, i) : base, ext: i > 0 ? base.slice(i) : "" };
        },
        getSep: () => "/",
      },
      fs: {
        exists: async (p) => existsSync(abs(p)),
        readdir: async (p) =>
          readdirSync(abs(p)).map((name) => {
            const s = statSync(join(abs(p), name));
            return { name, type: s.isDirectory() ? "directory" : "file", size: s.size, mtime: s.mtime };
          }),
        stat: async (p) => {
          const s = statSync(abs(p));
          return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtime: s.mtime };
        },
        readFile: async (p) => readFileSync(abs(p), "utf-8"),
        writeFile: async (p, content) => {
          mkdirSync(dirname(abs(p)), { recursive: true });
          writeFileSync(abs(p), content);
        },
        mkdir: async (p) => mkdirSync(abs(p), { recursive: true }),
        remove: async (p) => rmSync(abs(p), { recursive: true, force: true }),
        appendFile: async (p, content) => {
          mkdirSync(dirname(abs(p)), { recursive: true });
          appendFileSync(abs(p), content);
        },
      },
      getPlatform: async () => "linux",
      getArch: async () => "x64",
      getEnv: async () => ({}),
      homedir: async () => root,
      runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      fetch: async () => new Response(""),
    };
  };

  const rootA = mkdtempSync(join(tmpdir(), "rt-managed-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "rt-managed-b-"));
  writeFileSync(join(rootA, "AGENTS.md"), "# Project A\n\nA-ONLY-MARKER\n");
  writeFileSync(join(rootB, "AGENTS.md"), "# Project B\n\nB-ONLY-MARKER\n");

  const agentA = await CodentAgent.create({
    env: realEnv(rootA),
    name: "A",
    direct: { model: "m-a", style: "openai", baseURL: "http://a", apiKey: "ka" },
  });
  const agentB = await CodentAgent.create({
    env: realEnv(rootB),
    name: "B",
    direct: { model: "m-b", style: "openai", baseURL: "http://b", apiKey: "kb" },
  });

  const { session: sessionB } = await agentB.createSession({ name: "b", model: "m-b" });
  const managedB = agentB.getManager()?.getAgent(sessionB.id);
  assert.ok(managedB, "runtime B created a managed agent");
  assert.equal(managedB.getCoreEnv().rootPath, rootB, "the managed agent reads its runtime root");
  const docB = managedB.getAgentDocContent();
  assert.ok(docB && docB.includes("B-ONLY-MARKER"), "runtime B loads its own AGENTS.md");
  assert.ok(!docB.includes("A-ONLY-MARKER"), "runtime B does not load runtime A's AGENTS.md");

  await agentA.dispose();
  await agentB.dispose();
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
}

console.log("agent-runtime-instances validation passed");
