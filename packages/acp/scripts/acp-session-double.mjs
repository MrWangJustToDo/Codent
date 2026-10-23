/**
 * The in-process doubles the ACP validators drive: a session whose `dispatch` is a per-test hook, the
 * host that serves one, and a real SDK client on the other end of the wire.
 *
 * One definition, because these fakes are load-bearing: a double that drifts from production's shape
 * makes a validator pass without testing anything (the same reason `session-fixture.mjs` owns the
 * snapshot shape). The client capabilities are a parameter rather than a constant — the
 * `ask_user` fallback is DEFINED by a client that does not advertise `elicitation.form`, so that
 * case has to be expressible.
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";

import { baseSnapshot } from "./session-fixture.mjs";

/**
 * A session double whose `dispatch` is a per-test hook.
 *
 * `subscribe` delivers the retained `messages` value synchronously, exactly like core — that is
 * what makes the cold-resume check meaningful.
 */
export function makeSession({
  id,
  diskId = `ses_${id}`,
  messages = [],
  model,
  modelInfo,
  retained = false,
  onCommand,
}) {
  let snap = baseSnapshot(id, {
    activeSessionId: diskId,
    messages,
    ...(model ? { model } : {}),
    ...(modelInfo ? { modelInfo } : {}),
  });
  const listeners = new Set();
  const dispatched = [];
  const emit = (channel, payload) => {
    for (const listener of listeners) listener({ channel, payload, ts: Date.now() });
  };
  const api = {
    id,
    dispatched,
    emit,
    setSnapshot(overrides) {
      snap = baseSnapshot(id, { activeSessionId: diskId, ...overrides });
      return snap;
    },
    get snapshot() {
      return snap;
    },
    get diskId() {
      return diskId;
    },
  };
  const session = {
    id,
    getSnapshot: () => snap,
    getAgentStreamSnapshot: () => null,
    subscribe(handler, options) {
      listeners.add(handler);
      if (!options?.channels || options.channels.includes("messages")) {
        handler({ channel: "messages", payload: snap.messages, ts: Date.now() });
      }
      if (retained) {
        handler({ channel: "extensions", payload: { extensions: [] }, ts: Date.now() });
        handler({ channel: "todos", payload: { items: [], title: null }, ts: Date.now() });
        handler({ channel: "usage", payload: { contextFillTokens: 0, tokenLimit: 200000 }, ts: Date.now() });
        handler({ channel: "state", payload: snap, ts: Date.now() });
      }
      return () => listeners.delete(handler);
    },
    async dispatch(command) {
      dispatched.push(command);
      const result = await onCommand?.(command, api);
      return result ?? { ok: true };
    },
  };
  return { session, api };
}

export function makeHost(factory) {
  const created = [];
  return {
    created,
    async create(options) {
      const built = factory(options);
      created.push({ options, ...built });
      return { session: built.session };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  };
}

/**
 * The capabilities a fully-featured client advertises — what every case assumes unless it says
 * otherwise (a case that omits a capability is asserting the degradation path).
 */
export const FULL_CLIENT_CAPABILITIES = {
  session: { notices: {}, compaction: {}, configOptions: {} },
  elicitation: { form: {} },
};

export async function runClient(app, fn, handlers = {}, capabilities = FULL_CLIENT_CAPABILITIES) {
  const updates = [];
  let clientApp = createClient({ name: "conformance-client" }).onNotification(methods.client.session.update, (ctx) =>
    updates.push(ctx.params)
  );
  for (const [method, handler] of Object.entries(handlers)) {
    clientApp = clientApp.onRequest(method, handler);
  }
  let value;
  await clientApp.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: capabilities,
    });
    value = await fn(cx, updates);
  });
  return { updates, value };
}

export const TOOL_CALL = (overrides = {}) => ({
  type: "tool-call",
  id: "tc1",
  name: "run_command",
  input: { command: "echo hi" },
  state: "input-complete",
  approval: { needsApproval: true, id: "ap1" },
  ...overrides,
});
