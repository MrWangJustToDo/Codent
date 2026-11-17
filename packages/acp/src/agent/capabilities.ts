/**
 * The `initialize` handshake: what this agent claims, and what it deliberately does not.
 *
 * The rule the advertisement follows is "capabilities are truthful" — every entry below is served
 * by a handler in this package, and anything not served is absent rather than optimistic. The one
 * line this prints on stderr is shape-only (booleans): a tool path that looks wrong — a picker that
 * never appears, a question that degrades to plain text — is almost always a capability the client
 * never declared, and there was no way to see that from the outside.
 */

import { methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import { AGENT_NAME } from "./identity.js";

import type { AcpAgentContext } from "./context.js";

export function registerHandshake(ctx: AcpAgentContext): void {
  const { app, options, version } = ctx;

  app.onRequest(methods.agent.initialize, (request) => {
    ctx.setCapabilities(request.params.clientCapabilities);
    const caps = request.params.clientCapabilities;
    process.stderr.write(
      `[codent-acp] client capabilities: elicitation.form=${Boolean(caps?.elicitation?.form)} ` +
        `notices=${Boolean(caps?.session?.notices)} compaction=${Boolean(caps?.session?.compaction)} ` +
        `subagents=${Boolean(caps?.subagents)}\n`
    );
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        // Per-session MCP servers are wired through `session/new` (`mcp.ts` maps and
        // validates them). stdio / http / sse are all connectable by core; `acp` is the one
        // form with no core entry point, so it is neither declared here nor accepted there.
        mcpCapabilities: { http: true, sse: true },
        // `list` / `delete` are host-dependent: a host that cannot enumerate or remove
        // persisted sessions must not have us advertise them (the remote-session host has no
        // local store). Declaring a capability we cannot serve is exactly what the
        // "capabilities are truthful" rule forbids.
        sessionCapabilities: {
          ...(options.host.listPersistedSessions || options.listPersistedSessionsAt ? { list: {} } : {}),
          ...(options.host.deleteSession || options.deleteSessionAt ? { delete: {} } : {}),
          resume: {},
          close: {},
          // UNSTABLE in the SDK. Declared because we cover the WHOLE request, which the base spec
          // makes a precondition of declaring `fork`: `mcpServers` is refused loudly (a fork
          // reuses the source's live agent, so its servers genuinely cannot change − unlike
          // `session/new`/`load`/`resume`, which each build a fresh agent and therefore obey it),
          // `additionalDirectories` is refused too, and for a live source `cwd` must match its
          // workspace root (a cold source has no persisted root, so the request's `cwd` is the root
          // it is restored into). Nothing here is silently dropped.
          fork: {},
        },
        auth: { logout: {} },
      },
      agentInfo: { name: AGENT_NAME, title: "Codent", version },
      authMethods: [],
    };
  });

  // No interactive auth: credentials are resolved locally by the process that owns the workspace,
  // so both methods accept as no-ops rather than pretending to authenticate anything.
  app.onRequest(methods.agent.authenticate, () => ({}));
  app.onRequest(methods.agent.logout, () => ({}));
}
