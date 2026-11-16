/**
 * MCP `elicitation/create` → ACP `elicitation/create`.
 *
 * An MCP server asking the user a question is the same interaction `ask_user` performs — a form the
 * client renders — but it differs in three ways that decide the shape of this module:
 *
 * 1. **The capability is declared at the MCP handshake.** Supplying a hook is the entire opt-in: core
 *    advertises `elicitation` to a server and registers the handler only when one exists (see
 *    `mcp/manager.ts` in core). MCP servers connect inside `host.create`, which runs *after* the ACP
 *    `initialize` handshake, so the client's `elicitation.form` capability is known before that
 *    decision is made — and a client without it gets no hook at all. Supplying one anyway would claim
 *    a capability we cannot render a form for: a server that asked would be told "the user can be
 *    asked" by an agent that has no control to ask with.
 *
 * 2. **The session does not exist yet when the hook is built.** `session/new` connects MCP servers
 *    during `host.create` and only learns the ACP handle afterwards. The hook is therefore bound LATE
 *    ({@link McpElicitation.bind}) to the session itself and reads `acpId` on every call, which is
 *    also why `session/fork` needs no re-binding: it rewrites the same bridge's `acpId`, and the next
 *    question carries the clone's handle without anyone telling the channel.
 *
 * 3. **A request that nobody answers must still end.** `AgentContext.request` does NOT reject when its
 *    `cancellationSignal` aborts — the SDK only sends a `$/cancel_request` notification and leaves the
 *    promise pending until the peer answers or the connection closes (`@agentclientprotocol/sdk`
 *    `prepareRequest` → `cancel`). Aborting alone would therefore park a server's tool call forever,
 *    so the deadline/abort is raced against the request here, exactly like `ask_user` does it.
 *
 * Every path returns one of MCP's three actions and none of them throws: no session ⇒ `decline`,
 * aborted / timed out / rejected ⇒ `cancel`. A throw would turn a server's question into an
 * unexplained tool failure.
 */

import { methods } from "@agentclientprotocol/sdk";

import { DEFAULT_INTERACTION_TIMEOUT_MS } from "./interactions.js";
import { buildMcpElicitationRequest, mapMcpElicitResult } from "./permissions.js";

import type { AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";
import type { McpElicitHook } from "@codent/core";

/**
 * The parts of a live session this hook touches.
 *
 * A structural view of the host's session bridge (`SessionBridge` in `agent.ts`), not an interface to
 * implement: `acpId` is read per call and `pending`/`closed` are owned by the host.
 */
export interface McpElicitationSession {
  /** The id the CLIENT addresses this session by (read live — a fork rewrites it). */
  acpId: string;
  /** Dialog controllers; registering here is what makes cancel/close abort our request too. */
  pending: Set<AbortController>;
  closed: boolean;
}

export interface McpElicitationOptions {
  /** The agent-side connection handle (read lazily — it may not be up yet). */
  client: () => AgentContext;
  /** How long the client has to answer. Defaults to {@link DEFAULT_INTERACTION_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface McpElicitation {
  /** The runtime's `mcpElicit` — pass it to `Host.create` / `AgentSessionCreateOptions`. */
  hook: McpElicitHook;
  /** Point the hook at the session it serves. Until this is called, questions are declined. */
  bind(session: McpElicitationSession): void;
}

/**
 * Build the MCP elicit hook for one session, or `undefined` when the client cannot answer.
 *
 * @example
 * const elicit = createMcpElicitation(initCaps, { client });
 * const { session } = await runtime.host.create({ ...options, ...(elicit ? { mcpElicit: elicit.hook } : {}) });
 * elicit?.bind(bridge); // the bridge, not an id: it is read live on every question
 */
export function createMcpElicitation(
  caps: ClientCapabilities | undefined,
  options: McpElicitationOptions
): McpElicitation | undefined {
  if (!caps?.elicitation?.form) return undefined;
  // Clamped like the other interactions: zero/negative would fire on the next tick and cancel every
  // question a server asks.
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_INTERACTION_TIMEOUT_MS);
  let bound: McpElicitationSession | undefined;

  const hook: McpElicitHook = async ({ server, params }) => {
    const session = bound;
    // No session yet (MCP connects before the handle exists) or already gone: the bare-string
    // vocabulary is core's — only `accept` needs the object form, because only it carries values.
    if (!session || session.closed) return "decline";

    const controller = new AbortController();
    session.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    // The signal still goes on the request (a cooperative client closes its dialog), but the race
    // below is what guarantees an end: the SDK turns an abort into a notification and nothing else.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("elicitation aborted")), { once: true });
    });
    try {
      // `undefined` = a request this host does not relay (MCP's URL mode); declining is the honest
      // answer, and it is still an ANSWER — a server waiting on an unanswered request would hang.
      const request = buildMcpElicitationRequest(session.acpId, server, params);
      if (!request) return "decline";
      const response = await Promise.race([
        options.client().request(methods.client.elicitation.create, request, {
          cancellationSignal: controller.signal,
        }),
        aborted,
      ]);
      // A form submitted after the session was cancelled/closed is NOT consent: the server is gone or
      // its run is over, and forwarding `accept` would credit an answer nobody is waiting for.
      if (controller.signal.aborted || session.closed) return "cancel";
      return mapMcpElicitResult(response);
    } catch {
      // Aborted (cancel / close / deadline) or rejected by the client. `cancel` is MCP's action for
      // "dismissed without an answer", and the server reports it as such instead of the tool hanging.
      return "cancel";
    } finally {
      clearTimeout(timer);
      session.pending.delete(controller);
    }
  };

  return {
    hook,
    bind(session: McpElicitationSession) {
      bound = session;
    },
  };
}
