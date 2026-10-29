/**
 * Validation: MCP servers can come from the session's create options (not only a config file).
 *
 * The property under test is the one that motivates the whole option: a host that holds MCP
 * servers as data (an editor's settings, ACP's `session/new` parameter) must be able to
 * connect them without writing a file, and doing so must REPLACE the workspace config rather
 * than merge with it — two sources naming one server with different `command` / `url` have no
 * defensible winner.
 *
 * Asserted here, all against the real extension and a real temp-dir env (only the network
 * boundary, `McpManager.initialize`, is observable via the captured `McpConfig`):
 *
 *   1. explicit servers are connected and the config FILE is not even read;
 *   2. without explicit servers the file is still the source (no regression);
 *   3. the source kind travels as a KIND, never as a fake path in `configPath` / `configLoadedFrom`;
 *   4. `env` / `headers` values never reach the log;
 *   5. all three transports are passed through unchanged (incl. `sse`, which the ACP change
 *      declares as supported);
 *   6. an empty map means "no servers", not "an empty replace".
 *
 * `McpManager.initialize` is stubbed because a real MCP server is a process/HTTP dependency;
 * what this file is about is the CONFIG that reaches it, which the stub captures verbatim.
 *
 * Run: pnpm --filter @codent/core run validate:mcp-session-servers
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";

import {
  ExtensionRunner,
  McpManager,
  bridgeTelemetryToAgentLog,
  createAgentEventBus,
  createMcpExtension,
  mcpConfigFromServers,
  registerCoreEnv,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

const root = await mkdtemp(join(tmpdir(), "codent-mcp-session-servers-"));

/** A workspace config file that must NOT be consulted when servers come from the options. */
const FILE_SERVERS = { fromFile: { transport: "stdio", command: "/bin/file-server" } };
await mkdir(join(root, ".agents"), { recursive: true });
await writeFile(join(root, ".agents", "mcp.json"), JSON.stringify({ mcpServers: FILE_SERVERS }));

/** Files the env was asked to read — the direct evidence for "the file was skipped". */
const filesRead = [];

registerCoreEnv({
  rootPath: root,
  path: {
    join: (...p) => join(...p),
    dirname: (p) => dirname(p),
    basename: (p, ext) => (ext ? parse(p).name : parse(p).base),
    extname: (p) => parse(p).ext,
    resolve: (...p) => resolve(...p),
    normalize: (p) => normalize(p),
    isAbsolute: (p) => isAbsolute(p),
    getSep: () => sep,
    parse: (p) => parse(p),
  },
  getPlatform: async () => "test",
  getArch: async () => "test",
  getEnv: async () => ({}),
  homedir: async () => root,
  byteLength: (s) => Buffer.byteLength(s, "utf-8"),
  fs: {
    readFile: async (p) => {
      filesRead.push(p);
      return readFile(join(root, p), "utf-8");
    },
    stat: async (p) => {
      const s = await stat(join(root, p));
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    },
    readdir: async () => [],
    writeFile: async (p, c) => writeFile(join(root, p), c),
    mkdir: async (p) => {
      await mkdir(join(root, p), { recursive: true });
    },
    exists: async (p) => {
      try {
        await stat(join(root, p));
        return true;
      } catch {
        return false;
      }
    },
    remove: async (p) => rm(join(root, p), TEMP_RM_OPTIONS),
  },
});

// ============================================================================
// Harness
// ============================================================================

/**
 * Activate the real MCP extension with a `McpManager` whose connect step is captured.
 *
 * Returns the config that reached `initialize` (or `null` when it was never called — the
 * "no servers" case), plus every log line the extension wrote, so credential leakage is
 * asserted on the bytes rather than on a promise about the code.
 */
async function activateMcpExtension({ servers, configPath } = {}) {
  const logLines = [];
  const captured = { config: null, calls: 0 };

  // The extension's own `ctx.logger` rows and the `session:mcp` rows both reach the log through the
  // bridge now, so the harness runs the real bridge into a recording sink instead of handing the
  // runner an AgentLog handle (which no longer exists as an option).
  const bus = createAgentEventBus();
  bridgeTelemetryToAgentLog(bus, () => ({
    eventEntry: (level, category, _eventType, message) => {
      logLines.push({ level, category, message });
      return null;
    },
  }));

  const manager = new McpManager();
  // `initialize` is the network boundary (it would spawn processes / open sockets), and the
  // config that reaches it is the whole subject of this file — so capture it and stop there.
  // `getServerStatuses()` is left real (it returns a copy; the stub's statuses are recorded
  // through it below only in the stubbed path).
  manager.initialize = async (config) => {
    captured.calls += 1;
    captured.config = config;
    return {};
  };

  const runner = new ExtensionRunner({
    cwd: root,
    eventBus: bus,
    onRegisterTool: () => {},
    onRegisterCommand: () => {},
    onUnregisterTool: () => {},
  });

  const extension = createMcpExtension({
    mcpManager: manager,
    ...(configPath ? { configPath } : {}),
    ...(servers !== undefined ? { servers } : {}),
  });
  await runner.loadExtension(extension);

  return { manager, captured, logLines, extension, runner };
}

// ============================================================================
// 1. Explicit servers are used, and the file is not read
// ============================================================================

filesRead.length = 0;
const explicit = await activateMcpExtension({
  servers: mcpConfigFromServers({
    stdioOne: { transport: "stdio", command: "/bin/echo", args: ["a"], env: { SECRET_TOKEN: "s3cr3t-value" } },
    httpOne: { transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer hdr-secret" } },
    sseOne: { transport: "sse", url: "https://example.test/sse", headers: { "X-Api-Key": "sse-secret" } },
  }),
});

assert.equal(explicit.captured.calls, 1, "the extension connected the explicit servers");
assert.deepEqual(
  Object.keys(explicit.captured.config.mcpServers).sort(),
  ["httpOne", "sseOne", "stdioOne"],
  "every explicit server reached initialize"
);
assert.equal(filesRead.length, 0, "the config file was NOT read when servers came from the options");

// ============================================================================
// 2. All three transports pass through unchanged
// ============================================================================

const seen = explicit.captured.config.mcpServers;
assert.deepEqual(
  seen.stdioOne,
  { transport: "stdio", command: "/bin/echo", args: ["a"], env: { SECRET_TOKEN: "s3cr3t-value" } },
  "stdio config (incl. args/env) reaches the connect layer verbatim"
);
assert.deepEqual(
  seen.httpOne,
  { transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer hdr-secret" } },
  "http config (incl. headers) reaches the connect layer verbatim"
);
// `sse` specifically: the ACP side declares `sse: true`, so a silent drop here would make that
// declaration a lie. core's schema (`z.enum(["sse","http"])`) and `createTransportInput`'s
// pass-through of `config.transport` are what make it connectable.
assert.deepEqual(
  seen.sseOne,
  { transport: "sse", url: "https://example.test/sse", headers: { "X-Api-Key": "sse-secret" } },
  "sse config is carried through — not rejected, not downgraded to http"
);
assert.equal(explicit.manager.configSourceKind, "session-options", "the source kind is recorded");

// ============================================================================
// 3. Credentials never reach the log
// ============================================================================

const logText = JSON.stringify(explicit.logLines);
for (const secret of ["s3cr3t-value", "hdr-secret", "sse-secret"]) {
  assert.ok(!logText.includes(secret), `the log must not contain the credential "${secret}"`);
}
assert.ok(
  logText.includes("stdioOne/stdio") && logText.includes("httpOne/http") && logText.includes("sseOne/sse"),
  "the log records server names and transports (so the source is observable)"
);

// ============================================================================
// 4. The source is a KIND, never a fake path
// ============================================================================

assert.equal(explicit.manager.configPath, undefined, "configPath stays unset for a non-file source");
assert.equal(explicit.manager.configLoadedFrom, undefined, "configLoadedFrom stays unset for a non-file source");

// ============================================================================
// 5. Without explicit servers the file is still the source (no regression)
// ============================================================================

filesRead.length = 0;
const fromFile = await activateMcpExtension({});
assert.deepEqual(
  Object.keys(fromFile.captured.config.mcpServers),
  ["fromFile"],
  "no explicit servers ⇒ the workspace config file is connected"
);
assert.ok(
  filesRead.some((p) => p.includes(".agents/mcp.json")),
  "the file branch really reads the config file"
);
assert.equal(fromFile.manager.configSourceKind, "file", "the source kind reports the file");
assert.ok(
  typeof fromFile.manager.configLoadedFrom === "string" &&
    fromFile.manager.configLoadedFrom.includes(".agents/mcp.json"),
  "an existing path field still carries the loaded file path"
);
// The file branch's USEFUL answer is which file applied (the kind alone says only "some file"),
// so the source log has to name it — and it may, because a path is not a credential.
assert.ok(
  fromFile.logLines.some(
    (line) => line.message.includes("configuration source: file") && line.message.includes(".agents/mcp.json")
  ),
  "the source log names the loaded config file"
);

// ============================================================================
// 6. An empty map is an absence, not an empty replacement
// ============================================================================

assert.equal(mcpConfigFromServers({}), null, "an empty map yields no config (fall back to the file)");
assert.equal(mcpConfigFromServers(undefined), null, "an absent map yields no config");
assert.notEqual(
  mcpConfigFromServers({ a: { transport: "stdio", command: "x" } }),
  null,
  "a non-empty map yields config"
);

const empty = await activateMcpExtension({ servers: mcpConfigFromServers({}) });
// An empty map must behave EXACTLY like no map at all (spec: 未携带时沿用文件). This harness's
// workspace file holds one server, so "nothing connects" would be the bug, not the fix.
assert.deepEqual(
  Object.keys(empty.captured.config.mcpServers),
  ["fromFile"],
  "an empty map falls back to the config file, like no map at all"
);
assert.equal(empty.manager.configSourceKind, "file", "an empty map is treated as 'no options supplied'");

// ============================================================================
// 7. A failed server does not block the session (task 1.6)
// ============================================================================

{
  // Two servers, the first of which fails on connect: the second must still be connected and
  // the activation must still complete. A hand-written manager stub is used because the real
  // `McpManager.getServerStatuses()` returns a COPY — recording statuses through it would
  // silently write to a discarded array (which is exactly how the first draft of this section
  // asserted `undefined` and failed).
  const statuses = [
    { name: "bad", transport: "stdio", toolCount: 0, status: "failed", error: "boom" },
    { name: "good", transport: "stdio", toolCount: 0, status: "connected" },
  ];
  const registeredToolNames = [];

  const stubManager = {
    setConfigSource: () => {},
    setConfigSourceKind: () => {},
    configSourceKind: "session-options",
    initialize: async () => ({ mcp__good_tool: { name: "mcp__good_tool", description: "ok" } }),
    getServerStatuses: () => statuses,
    getServerInstructions: () => [],
    shutdown: async () => {},
  };

  const runner = new ExtensionRunner({
    cwd: root,
    onRegisterTool: (def) => registeredToolNames.push(def.name),
    onRegisterCommand: () => {},
    onUnregisterTool: () => {},
  });

  // Activation completing at all is the property: a per-server failure must not throw out of
  // `activate`, which would fail the whole extension for one unreachable server.
  await runner.loadExtension(
    createMcpExtension({
      mcpManager: stubManager,
      servers: mcpConfigFromServers({
        bad: { transport: "stdio", command: "/nonexistent" },
        good: { transport: "stdio", command: "/bin/echo" },
      }),
    })
  );

  const byName = Object.fromEntries(statuses.map((s) => [s.name, s.status]));
  assert.equal(byName.bad, "failed", "the failing server is recorded as failed");
  assert.equal(byName.good, "connected", "the other server is still connected");
  assert.ok(registeredToolNames.includes("mcp__good_tool"), "the healthy server's tools were registered");
}

await rm(root, TEMP_RM_OPTIONS);
console.log("mcp session-servers validation passed");
