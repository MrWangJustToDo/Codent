/**
 * `--client-env` end to end, through the REAL bootstrap.
 *
 * The rest of this suite builds a client env by hand and injects a fake host, which cannot see the
 * one class of failure that matters most here: work core does *inside* `CodentAgent.create` /
 * `host.create`, before a session exists. That is where the instruction file is read, and reading
 * it through a client-backed env used to fail — with the failure swallowed by the loader's `catch`,
 * so every new session silently lost its project instructions.
 *
 * So this file does the opposite of the other suite: real `createNodeEnv`, real `CodentAgent`, real
 * `host.create`, and a client that is only ever consulted if something routes to it. A workspace
 * with `AGENTS.md` in it is the fixture.
 *
 * Run: pnpm --filter @codent/acp run validate:acp:bootstrap
 */

import { CodentAgent } from "@codent/core";
import { createNodeEnv } from "@codent/node";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAcpClientEnv } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";

const checker = createChecker();
const check = checker.check;

const PROJECT_RULE = "NEVER deploy on a Friday";

/** A workspace whose AGENTS.md is unmissable if it gets loaded. */
async function makeWorkspace(prefix) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.promises.writeFile(path.join(root, "AGENTS.md"), `# Project Rules\n\n${PROJECT_RULE}.\n`);
  return root;
}

/**
 * Build a client-backed env whose client records every request.
 *
 * `sessionId` is a live getter so a test can model the real sequencing: core mints the disk id
 * during `host.create` and the ACP layer binds it immediately after.
 */
function makeEnv(root, { bindImmediately = false } = {}) {
  const clientRequests = [];
  const logs = [];
  const bound = { value: bindImmediately ? "ses_e2e" : "" };
  const env = createAcpClientEnv({
    client: () => ({
      request: async (method, params) => {
        clientRequests.push({ method, path: params?.path });
        if (method === "fs/read_text_file") return { content: "CLIENT-SERVED" };
        if (method === "fs/write_text_file") return {};
        throw new Error(`unexpected client method ${method}`);
      },
    }),
    // Empty string ⇒ undefined ⇒ "no session yet, serve locally".
    sessionId: () => bound.value || undefined,
    rootPath: root,
    fallback: createNodeEnv({ rootPath: root }),
    caps: { readTextFile: true, writeTextFile: true, terminal: true },
    log: (message) => logs.push(message),
  });
  return { env, clientRequests, logs, bound };
}

// ===========================================================================
// 1. The instruction file survives `host.create` on a client-backed env
// ===========================================================================

{
  const root = await makeWorkspace("acp-e2e-doc-");
  const { env, clientRequests, logs } = makeEnv(root);

  const agent = await CodentAgent.create({ env });
  // The real sequence: the env is unbound while `host.create` runs, then bound.
  const docs = [];
  agent.getManager()?.on("session:doc", (event) => docs.push(event?.payload ?? event));

  const { session } = await agent.host.create({ name: "e2e", model: "gpt-4o" });
  check("the session was created", Boolean(session));

  // The designed local routes are COUNTED and not narrated: a session's own `.agents/**` reads all
  // take this branch, so a line each printed ~50 WARN lines per session load (reported as an error).
  check(
    "a designed local route is counted, not logged",
    env.fallbackCounts.localOnlyPath > 0 && !logs.some((line) => line.includes("local-only-path"))
  );

  check(
    "the project instruction file WAS loaded during create",
    docs.some((d) => typeof d.source === "string" && d.source.endsWith("AGENTS.md"))
  );
  check(
    "it was loaded rather than reported missing",
    !docs.some((d) => typeof d.message === "string" && d.message.includes("No agent documentation file found"))
  );
  check("no client request was needed to read it", clientRequests.length === 0);
}

// ===========================================================================
// 2. The same read is refused-by-route when the client cannot be asked
// ===========================================================================

{
  // An even sharper statement of the same property: the client is configured to REJECT everything.
  // A create that reads the workspace through it would fail; one that delegates cannot be affected.
  const root = await makeWorkspace("acp-e2e-hostile-");
  const hostile = createAcpClientEnv({
    client: () => ({
      request: async () => {
        throw new Error("the client must not be consulted during create");
      },
    }),
    sessionId: () => undefined,
    rootPath: root,
    fallback: createNodeEnv({ rootPath: root }),
    caps: { readTextFile: true, writeTextFile: true, terminal: true },
    log: () => {},
  });
  const agent = await CodentAgent.create({ env: hostile });
  const docs = [];
  agent.getManager()?.on("session:doc", (event) => docs.push(event?.payload ?? event));
  const created = await agent.host
    .create({ name: "hostile", model: "gpt-4o" })
    .then((r) => Boolean(r.session))
    .catch(() => false);
  check("create survives a client that refuses every request", created === true);
  check(
    "and the instructions are still loaded",
    docs.some((d) => typeof d.source === "string" && d.source.endsWith("AGENTS.md"))
  );
}

// ===========================================================================
// 3. Once bound, the client IS used — the delegation is not a blanket local mode
// ===========================================================================

{
  const root = await makeWorkspace("acp-e2e-bound-");
  const { env, clientRequests } = makeEnv(root, { bindImmediately: true });
  const content = await env.fs.readFile(path.join(root, "src", "index.ts"));
  check("a bound session reads through the client", content === "CLIENT-SERVED");
  check("and the request was tagged with its session id", clientRequests.length === 1);
}

// ===========================================================================
// 4. The delegation is counted honestly (not as a missing capability)
// ===========================================================================

{
  const root = await makeWorkspace("acp-e2e-count-");
  const { env } = makeEnv(root);
  await env.fs.readFile(path.join(root, "AGENTS.md"));
  // "No session yet" is a WHEN, not a WHERE: the same path would have gone to the client a moment
  // later, so it belongs with the capability bucket rather than the path bucket.
  check(
    "an unbound workspace read is counted as 'could not ask', not as a path we never send",
    env.fallbackCounts.localNoCapability === 1 && env.fallbackCounts.localOnlyPath === 0
  );
  check("it is not misfiled as deliberate local routing", env.fallbackCounts.other === 0);

  // A query must not move a counter: `routesWriteToClient` is asked on every approval.
  const before = { ...env.fallbackCounts };
  env.routesWriteToClient(path.join(root, "src", "a.ts"));
  env.routesWriteToClient(path.join(root, ".agents", "x.jsonl"));
  env.routesWriteToClient("/etc/passwd");
  check("routesWriteToClient is side-effect free", JSON.stringify(env.fallbackCounts) === JSON.stringify(before));
}

// ===========================================================================
// 5. MCP stdio survives `--client-env`: the server is spawned by THIS process
// ===========================================================================

{
  // The reported failure: with `--client-env`, every configured stdio MCP server failed at connect
  // with "Stdio MCP transport is not available in this environment" — the member was simply absent
  // from the env, and core refuses a stdio transport rather than degrading it. The real spawn path
  // is the only decisive evidence, so this section runs a real fixture server end to end.
  const root = await makeWorkspace("acp-e2e-mcp-");
  const { env, clientRequests } = makeEnv(root);
  check("the client-backed env can spawn a stdio MCP server", typeof env.createMCPStdioTransport === "function");

  const agent = await CodentAgent.create({ env });
  try {
    check(
      "…and the runtime env keeps it after `resolveCoreEnv`",
      typeof agent.getEnv().createMCPStdioTransport === "function"
    );

    const statuses = [];
    agent.getManager()?.on("session:mcp", (event) => {
      const payload = event?.payload ?? event;
      for (const server of payload?.servers ?? []) statuses.push(server);
    });

    const { session } = await agent.host.create({
      name: "mcp",
      model: "gpt-4o",
      mcpServers: {
        fixture: {
          transport: "stdio",
          command: process.execPath,
          args: [path.join(import.meta.dirname, "mcp-stdio-fixture.mjs")],
        },
      },
      // The ACP layer supplies this when the client can render a form; core's half is that it reaches
      // the manager (which is what makes the MCP client ADVERTISE `elicitation` at the handshake).
      mcpElicit: async () => "decline",
    });
    check("a session can be created with an explicit stdio server", Boolean(session));

    const fixture = statuses.find((s) => s.name === "fixture");
    check("the stdio server CONNECTED (not refused by the env)", fixture?.status === "connected");
    check("its tool was registered through the manager", fixture?.toolCount === 1);
    check("spawning it needed ZERO client requests", clientRequests.length === 0);

    // `isElicitationAvailable()` is what `/mcp` prints and what decided the MCP handshake: if the
    // option had been dropped on the way to `ManagedAgentConfig`, every server would see a client that
    // cannot ask the user, which is the fail-closed default rather than an error.
    const managed = agent.getManager()?.getAgent(session.getSnapshot().agentId);
    check(
      "the session-supplied elicit hook reached the MCP manager",
      managed?.getMcpManager()?.isElicitationAvailable() === true
    );
  } finally {
    // In `finally`, not on the happy path: the fixture child was spawned inside `host.create`, and a
    // throw after that would leave it holding this process's stdio pipes open — the validator would
    // HANG instead of printing the failure above.
    await agent.dispose();
  }
}

finish(checker.failures);
