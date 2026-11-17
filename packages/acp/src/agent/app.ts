/**
 * `createAcpAgent` — the composition root of the ACP host.
 *
 * It owns the pieces that belong to the PROCESS rather than to a session (the connection, the
 * handshake's capabilities, the session map) and hands them to the modules that own a subject:
 *
 * ```
 * capabilities.ts      initialize / authenticate / logout — what we claim
 * session-requests.ts  new / load / resume / close / list / delete — the disk catalog
 * session-fork.ts      fork — clone while the source stays usable
 * config-options.ts    the mode / model / depth selectors and their write paths
 * prompt-turns.ts      prompt / cancel — when a turn is over
 * session-bridge.ts    the session map: attach, close, re-key, child projectors
 * session-creation.ts  runtime + system prompt + MCP servers for one new session
 * ```
 *
 * The order below is construction order, not registration order: every module is handed the same
 * {@link AcpAgentContext} and registers itself, so there is no shared mutable state beyond what
 * that context exposes.
 */

import { agent as createAgentApp, methods } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";

import { createInteractionHandlers } from "../interaction/interactions.js";
import { resolveRoot } from "../wire/paths.js";

import { registerHandshake } from "./capabilities.js";
import { createConfigSelectors, registerConfigOptionRequests } from "./config-options.js";
import { AGENT_NAME, DEFAULT_VERSION } from "./identity.js";
import { registerPromptTurns } from "./prompt-turns.js";
import { createSessionBridgeRegistry } from "./session-bridge.js";
import { createSessionCreation } from "./session-creation.js";
import { registerSessionFork } from "./session-fork.js";
import { registerSessionRequests } from "./session-requests.js";
import { TRACE_UPDATES } from "./trace.js";

import type { AcpAgentContext } from "./context.js";
import type { AcpAgentOptions } from "./options.js";
import type { SessionUpdate } from "../wire/types.js";
import type { AgentApp, AgentConnection, AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";

/** Create the ACP agent app (handlers registered; call `connect(stream)` to serve). */
export function createAcpAgent(options: AcpAgentOptions): AgentApp {
  const app = createAgentApp({ name: AGENT_NAME });
  const rootPath = resolveRoot(options.rootPath);
  const version = options.version ?? DEFAULT_VERSION;
  const sessionRoots = new Map<string, string>();
  /**
   * Child session ids announced to a client. A child never becomes a top-level session: `load`,
   * `resume`, `fork` and `prompt` must refuse it, and `delete` must not hand it to
   * `host.deleteSession` (which looks the id up as an agent and would destroy the child).
   *
   * Ids are never removed — a closed child stays screened rather than turning into "unknown", which
   * would let a late request reach the top-level path.
   */
  const knownChildIds = new Set<string>();
  let connection: AgentConnection | null = null;
  let initCaps: ClientCapabilities | undefined;

  const client = (): AgentContext => {
    const conn = connection as AgentConnection | null;
    if (!conn) throw new Error("ACP connection not established");
    return conn.client;
  };

  const emit = (acpId: string, update: SessionUpdate): void => {
    if (TRACE_UPDATES) {
      // One line per outgoing update (id + text snippet): "the client shows something we did not send"
      // is settled by reading what WAS sent.
      const key = update as { messageId?: string; toolCallId?: string; content?: { text?: string } };
      // `len` and `sha` are what make "the same text twice" decidable: two similar thoughts share a
      // 40-character prefix, identical ones share a length AND a hash. Without them a duplicated
      // reasoning block reads exactly like a repeated sentence in the model's output.
      const text =
        typeof key.content?.text === "string"
          ? ` ${JSON.stringify(key.content.text.slice(0, 40))} len=${key.content.text.length} sha=${createHash("sha1").update(key.content.text).digest("hex").slice(0, 8)}`
          : "";
      process.stderr.write(`[codent-acp] → ${update.sessionUpdate} ${key.messageId ?? key.toolCallId ?? ""}${text}\n`);
    }
    try {
      void client()
        .notify(methods.client.session.update, { sessionId: acpId, update })
        .catch(() => {});
    } catch {
      // not connected yet — drop
    }
  };

  const interactions = createInteractionHandlers({
    client,
    emit,
    ...(options.interactionTimeoutMs !== undefined ? { timeoutMs: options.interactionTimeoutMs } : {}),
    onClientOwnedApproval: () => undefined,
  });

  const bridges = createSessionBridgeRegistry({ options, emit, interactions, sessionRoots, knownChildIds });

  const ctx: AcpAgentContext = {
    app,
    options,
    rootPath,
    version,
    sessionRoots,
    emit,
    client,
    capabilities: () => initCaps,
    setCapabilities: (next) => {
      initCaps = next;
    },
    bridges,
    interactions,
    creation: createSessionCreation({
      options,
      processRoot: rootPath,
      client,
      getClientCapabilities: () => initCaps,
    }),
    config: createConfigSelectors({ options, emit }),
  };

  app.onConnect((conn) => {
    connection = conn;
    // The client is gone: no pending dialog can be answered. Settle them, end the turns and
    // release the per-session runtimes rather than leaving sessions parked on an approval nobody
    // will ever send.
    void conn.closed.then(() => bridges.closeAll()).catch(() => undefined);
  });

  registerHandshake(ctx);
  const sessions = registerSessionRequests(ctx);
  registerSessionFork(ctx, sessions);
  registerConfigOptionRequests(ctx);
  registerPromptTurns(ctx);

  return app;
}
