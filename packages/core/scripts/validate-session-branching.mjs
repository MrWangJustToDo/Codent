/**
 * Validation: session branching (`/clone` and `/fork`).
 *
 * A branch writes a NEW session file and switches to it, leaving the source intact:
 *   - `SessionStore.branchFrom` copies the messages (optionally truncated), copies the
 *     model settings, resets per-session work state, and records `forkedFrom`.
 *   - `branchSession` builds it from the live channel, saves, and switches via the
 *     same `restoreSession` path as `session.resume`; `/fork` returns the chosen
 *     message's text for the editor.
 *
 * Run: pnpm --filter @codent/core run validate:session-branching
 */

import assert from "node:assert/strict";

import { SessionStore, branchSession, clearCoreEnv, registerCoreEnv } from "../dist/dev.mjs";

// ============================================================================
// In-memory CoreEnv fs (relative workspace paths)
// ============================================================================

const files = new Map();

function dirChildren(dir) {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  const seen = new Map();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    seen.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? "file" : "directory");
  }
  return [...seen.entries()].map(([name, type]) => ({ name, type }));
}

registerCoreEnv({
  rootPath: "/tmp/session-branching-ws",
  getPlatform: async () => "linux",
  getArch: async () => "x64",
  getEnv: async () => ({}),
  homedir: async () => "/tmp",
  fs: {
    exists: async (path) => files.has(path) || dirChildren(path).length > 0,
    readFile: async (path) => {
      if (!files.has(path)) throw new Error(`no such file: ${path}`);
      return files.get(path);
    },
    writeFile: async (path, content) => {
      files.set(path, String(content));
    },
    appendFile: async (path, content) => {
      files.set(path, (files.get(path) ?? "") + String(content));
    },
    rename: async (from, to) => {
      const value = files.get(from);
      files.delete(from);
      if (value !== undefined) files.set(to, value);
    },
    mkdir: async () => {},
    remove: async (path) => {
      files.delete(path);
    },
    readdir: async (dir) => dirChildren(dir),
    stat: async (path) => ({
      isDirectory: dirChildren(path).length > 0,
      isFile: files.has(path),
      size: (files.get(path) ?? "").length,
      mtime: new Date(0),
    }),
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(""),
});

const text = (content) => ({ type: "text", content });

try {
  const store = new SessionStore();

  // A source session with two turns and non-default settings / work state.
  const source = store.create({ modelStyle: "anthropic", model: "claude-x" });
  source.name = "Source session";
  source.reasoningEffort = "medium";
  source.uiMessages = [
    { id: "u1", role: "user", parts: [text("first prompt")] },
    { id: "a1", role: "assistant", parts: [text("first answer")] },
    { id: "u2", role: "user", parts: [text("second prompt")] },
  ];
  source.todos = [{ id: "t1", content: "do x", status: "pending", priority: "high", createdAt: 1, updatedAt: 1 }];
  await store.save(source);

  // --------------------------------------------------------------------------
  // 1. branchFrom: clone copies everything, resets work state, records lineage
  // --------------------------------------------------------------------------
  {
    const clone = store.branchFrom(source);
    assert.notEqual(clone.id, source.id, "a new session id is minted");
    assert.equal(clone.uiMessages.length, 3, "clone copies every message");
    assert.equal(clone.forkedFrom, source.id, "the source id is recorded as forkedFrom");
    assert.equal(clone.model, "claude-x", "model copied");
    assert.equal(clone.modelStyle, "anthropic", "model style copied");
    assert.equal(clone.reasoningEffort, "medium", "reasoning effort copied");
    assert.deepEqual(clone.todos, [], "todos reset");
    assert.equal(clone.usage.totalTokens, 0, "window usage reset");
    assert.equal(clone.name, source.name, "name derived from source when not given");
  }

  // --------------------------------------------------------------------------
  // 2. branchFrom: fork truncates strictly before the index; name override
  // --------------------------------------------------------------------------
  {
    const fork = store.branchFrom(source, { upToIndex: 2 });
    assert.equal(fork.uiMessages.length, 2, "fork keeps only messages before the index");
    assert.deepEqual(
      fork.uiMessages.map((m) => m.id),
      ["u1", "a1"]
    );
    const named = store.branchFrom(source, { name: "custom name" });
    assert.equal(named.name, "custom name", "an explicit name wins");
  }

  // --------------------------------------------------------------------------
  // 3. branchSession: clone end-to-end (save + switch), source untouched
  // --------------------------------------------------------------------------
  const fakeManaged = (session, { running = false } = {}) => ({
    session: { awaitPersistIdle: async () => {} },
    getSessionStore: () => store,
    getSessionData: () => session,
    getChatController: () => ({ isRunActive: () => running }),
    getUI: () => ({ getMessages: () => session.uiMessages }),
    restoreSession: async (id) => await store.load(id),
  });

  {
    const result = await branchSession(fakeManaged(source), { mode: "clone" });
    assert.equal(result.ok, true, "clone succeeds");
    assert.notEqual(result.sessionId, source.id, "clone switches to a new session");
    const loaded = await store.load(result.sessionId);
    assert.equal(loaded.forkedFrom, source.id, "the persisted clone records lineage");
    assert.equal(loaded.uiMessages.length, 3, "the persisted clone has the full transcript");
  }

  // --------------------------------------------------------------------------
  // 4. branchSession: fork returns the chosen message's text
  // --------------------------------------------------------------------------
  {
    const result = await branchSession(fakeManaged(source), { mode: "fork", upToMessageId: "u2" });
    assert.equal(result.ok, true, "fork succeeds");
    assert.equal(result.forkText, "second prompt", "the chosen message's text is handed back");
    const loaded = await store.load(result.sessionId);
    assert.equal(loaded.uiMessages.length, 2, "the fork drops the chosen message and everything after");
  }

  // --------------------------------------------------------------------------
  // 5. Safety: refused mid-run; invalid fork point fails
  // --------------------------------------------------------------------------
  {
    const busy = await branchSession(fakeManaged(source, { running: true }), { mode: "clone" });
    assert.equal(busy.ok, false, "refused while the agent is running");
    assert.match(busy.error, /running/i);

    const atStart = await branchSession(fakeManaged(source), { mode: "fork", upToMessageId: "u1" });
    assert.equal(atStart.ok, false, "forking at the first message (nothing before it) fails");
  }

  // --------------------------------------------------------------------------
  // 6. branchSession: 1-based user-message index shortcut + non-user rejection
  // --------------------------------------------------------------------------
  {
    const byIndex = await branchSession(fakeManaged(source), { mode: "fork", upToMessageId: "2" });
    assert.equal(byIndex.ok, true, "a 1-based user-message index forks like the id");
    assert.equal(byIndex.forkText, "second prompt", "index 2 selects the second user message");
    assert.equal((await store.load(byIndex.sessionId)).uiMessages.length, 2, "index fork truncates the same way");

    const first = await branchSession(fakeManaged(source), { mode: "fork", upToMessageId: "1" });
    assert.equal(first.ok, false, "index 1 (nothing before the first user message) fails");

    const atAssistant = await branchSession(fakeManaged(source), { mode: "fork", upToMessageId: "a1" });
    assert.equal(atAssistant.ok, false, "forking at a non-user message is rejected");
  }

  console.log("session-branching validation passed");
} finally {
  clearCoreEnv();
}
