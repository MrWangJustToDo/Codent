/**
 * Mock sessions, a projector harness, and an ACP app harness for the subagent validator.
 *
 * Extracted so `validate-acp-subagents.mjs` stays inside the file-size gate. They drive the REAL
 * `AcpProjector` / `createAcpAgent` over doubles; every emitted update is validated against the SDK's
 * own zod schema on the way out.
 */

import { client as createAcpClient, methods } from "@agentclientprotocol/sdk";

import { AcpProjector, createAcpAgent } from "../dist/index.mjs";

import { zod } from "./acp-scenario.mjs";
import { baseSnapshot } from "./session-fixture.mjs";

export const schemaFailures = [];

export function validateUpdate(update) {
  const parsed = zod.zSessionUpdate.safeParse(update);
  if (parsed.success) return;
  schemaFailures.push(
    `${update.sessionUpdate}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"} ${i.message}`).join("; ")}`
  );
}

export const row = (over = {}) => ({
  id: "child-1",
  status: "running",
  name: "explore",
  description: "find the tests",
  parentTaskToolCallId: "tc1",
  ...over,
});

export function projectorScenario({
  client = { compaction: true, notices: true, subagents: true },
  messages = [],
} = {}) {
  const listeners = new Set();
  const emitted = [];
  const attached = [];
  let snapshot = baseSnapshot("parent", { messages });

  const projector = new AcpProjector(
    {
      getSnapshot: () => snapshot,
      subscribe: (handler) => {
        listeners.add(handler);
        return () => listeners.delete(handler);
      },
    },
    {
      rootPath: "/ws",
      emit: (update) => {
        emitted.push(update);
        validateUpdate(update);
      },
      commands: () => ({ builtin: [], extension: [] }),
      client,
      onSubagents: (rows) => attached.push({ at: emitted.length, ids: rows.map((row) => row.id) }),
    }
  );
  projector.start({ seedState: false });

  return {
    emitted,
    attached,
    projector,
    push: (channel, payload) => {
      for (const listener of listeners) listener({ channel, payload, ts: Date.now() });
    },
    subagents: (rows) => {
      snapshot = { ...snapshot, subagents: rows };
      for (const listener of listeners)
        listener({ channel: "subagents", payload: { subagents: rows }, ts: Date.now() });
    },
    setMessages: (next) => {
      snapshot = { ...snapshot, messages: next };
      for (const listener of listeners) listener({ channel: "messages", payload: next, ts: Date.now() });
    },
    stop: () => projector.stop(),
  };
}

export function makeSession(id, { messages = [], subagents = [], retained = false } = {}) {
  const listeners = new Set();
  const subscriptions = [];
  let snapshot = baseSnapshot(id, { messages, subagents });
  let dispatched = [];
  return {
    id,
    getSnapshot: () => snapshot,
    /** The `channels` each projector asked for (the child must not subscribe to interaction/etc.). */
    subscriptions: () => subscriptions,
    getSummaryStreamSnapshot: () => null,
    setMessages: (next) => {
      snapshot = { ...snapshot, messages: next };
    },
    /** A `subagents` snapshot: the channel event AND the snapshot field (the host resyncs from it). */
    pushSubagents: (rows) => {
      snapshot = { ...snapshot, subagents: rows };
      for (const listener of listeners)
        listener({ channel: "subagents", payload: { subagents: rows }, ts: Date.now() });
    },
    subscribe: (handler, options = {}) => {
      listeners.add(handler);
      subscriptions.push(options.channels ?? null);
      // Real sessions deliver retained channel values on subscribe; `retained` exercises the
      // `session/new` deferred window (the announcement is queued before the response).
      if (retained && (options.channels ?? []).includes("subagents")) {
        handler({ channel: "subagents", payload: { subagents: snapshot.subagents }, ts: Date.now() });
      }
      return () => listeners.delete(handler);
    },
    listenerCount: () => listeners.size,
    push: (channel, payload) => {
      for (const listener of listeners) listener({ channel, payload, ts: Date.now() });
    },
    dispatch: async (command) => {
      dispatched.push(command);
      if (command.type === "session.clone") {
        // The fork re-keys the SAME bridge to the cloned disk id; the mock has to move it too.
        snapshot = { ...snapshot, activeSessionId: "ses_cloned" };
        return { ok: true, data: { sessionId: "ses_cloned" } };
      }
      return { ok: true };
    },
    take: () => {
      const seen = dispatched;
      dispatched = [];
      return seen;
    },
    /** Every dispatched command, without consuming it (poll with `waitFor`). */
    commands: () => dispatched,
  };
}

/**
 * Drive one ACP app over a fake host. `capability` decides whether the client is a subagent client.
 *
 * Everything runs INSIDE `connectWith` — once it returns, the connection is closed and no further
 * request/notification can be observed.
 */

export async function hostScenario(
  { subagents, create, connect, parentOptions = {}, elicitation, onElicitation },
  run
) {
  const prompt = { id: "u1", role: "user", parts: [{ type: "text", content: "explore the repo" }] };
  const parent = makeSession("parent", parentOptions);
  const child = makeSession("child-1", { messages: [prompt] });
  const events = [];
  const destroyed = [];
  const deleted = [];
  const connected = [];

  const client = createAcpClient({ name: "subagents-client" }).onNotification(methods.client.session.update, (ctx) => {
    events.push({ sessionId: ctx.params.sessionId, update: ctx.params.update });
    validateUpdate(ctx.params.update);
  });
  if (onElicitation) client.onRequest(methods.client.elicitation.create, onElicitation);

  const app = createAcpAgent({
    host: {
      async create(options) {
        const custom = create ? await create(options) : undefined;
        return custom ?? { session: parent };
      },
      connect: (id) => {
        connected.push(id);
        return connect ? connect(id, { child }) : id === "child-1" ? child : null;
      },
      // Live agents include the child AND an internal worker that is never announced; the disk
      // catalog is separate and holds no child at all.
      list: () => [
        { agentId: "parent", name: "parent", status: "running", createdAt: 1, updatedAt: 2 },
        {
          agentId: "child-1",
          name: "find the tests",
          parentId: "parent",
          status: "running",
          createdAt: 1,
          updatedAt: 2,
        },
        {
          agentId: "worker-1",
          name: "memory-summarizer",
          parentId: "parent",
          status: "running",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      listPersistedSessions: () => [],
      async destroy(id) {
        destroyed.push(id);
      },
      async deleteSession(id) {
        deleted.push(id);
      },
    },
    defaults: { model: "fake-model" },
    rootPath: "/ws",
  });

  await client.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        // `undefined` = absent, `null` = explicitly unsupported, `{}` = supported — all three are
        // legal protocol values and only the object form may enable the feature.
        ...(subagents === undefined ? {} : { subagents }),
        ...(elicitation === undefined ? {} : { elicitation }),
        session: { compaction: true, notices: true },
      },
    });
    const started = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    await run({
      cx,
      started,
      parent,
      child,
      events,
      destroyed,
      deleted,
      connected,
      /** Notifications are sent asynchronously; one macrotask flushes the frames. */
      settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
      /** Poll a value produced by an async handler (elicitation round-trip, text answer). */
      waitFor: async (probe, attempts = 100) => {
        for (let index = 0; index < attempts; index += 1) {
          const value = probe();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return undefined;
      },
      rejection: async (method, params) => {
        try {
          await cx.request(method, params);
          return undefined;
        } catch (error) {
          return error;
        }
      },
    });
  });
}
