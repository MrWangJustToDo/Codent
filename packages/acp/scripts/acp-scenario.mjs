/**
 * The projector scenario harness, shared by the ACP projection validators.
 *
 * Every emitted `session/update` is validated against the SDK's own zod schema on the way out — the only
 * check that sees RUNTIME values (the SDK's types are erased, and this host assembles most payloads by
 * hand from core's channels).
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { AcpProjector } from "../dist/index.mjs";

const sdkDir = dirname(createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"));
const zod = await import(pathToFileURL(join(sdkDir, "schema/zod.gen.js")).href);
const schemaFailures = [];
function validateUpdate(update) {
  const parsed = zod.zSessionUpdate.safeParse(update);
  if (parsed.success) return;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`).join("; ");
  schemaFailures.push(`${update.sessionUpdate}: ${issues}`);
}

// ===========================================================================
// A mock session + a capture of everything the projector emits
// ===========================================================================

/** Every `session/update` the projector emitted, in order. */
export function capture(
  client = { compaction: true, notices: true },
  commands = () => ({ builtin: [], extension: [] })
) {
  const listeners = new Set();
  const emitted = [];
  const session = {
    getSnapshot: () => ({ todos: [], mode: "normal", usage: undefined, name: "probe", messages: [] }),
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const projector = new AcpProjector(session, {
    rootPath: "/ws",
    emit: (update) => {
      emitted.push(update);
      validateUpdate(update);
    },
    commands,
    client,
  });
  projector.start();
  return {
    emitted,
    projector,
    push: (channel, payload) => {
      for (const listener of listeners) listener({ channel, payload, ts: Date.now() });
    },
    /** The content of the last update that carried any, i.e. what the client is left holding. */
    lastContent(toolCallId) {
      const withContent = emitted.filter(
        (u) => u.toolCallId === toolCallId && Array.isArray(u.content) && u.content.length > 0
      );
      return withContent[withContent.length - 1]?.content;
    },
    updates: (sessionUpdate) => emitted.filter((u) => u.sessionUpdate === sessionUpdate),
    stop: () => projector.stop(),
  };
}
export { schemaFailures, zod };
