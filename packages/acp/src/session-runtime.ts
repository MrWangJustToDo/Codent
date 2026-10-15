/**
 * Per-session runtimes: the one place `--client-env` changes how a session is built.
 *
 * Without the flag there is nothing per-session — every session borrows the process-wide host. With
 * it, the session's env is client-backed, and because every client request carries a `sessionId`
 * that env can only serve one session. So the runtime (and its env) is built per session here, and
 * released when the session closes.
 *
 * The subtle part is the id. `session/load` and `session/resume` are told the id by the client, but
 * `session/new` is not: core mints it inside `host.create`, which is also the call that needs this
 * env. During that call the env is asked to read workspace files — the instruction file
 * (`AGENTS.md` / `CLAUDE.md`), `.lsp.json`, `.mcp.json` — which simply cannot be tagged with a
 * session id yet. The getter answers `undefined` for those, and the env serves them from its local
 * fallback.
 *
 * That is deliberate, and the alternative is worse: throwing here is *silent*. The instruction
 * loader catches a failed read and reports "no agent documentation file found", so refusing the
 * read costs every new session its project instructions with nothing in the transcript to say so.
 * `undefined` means "serve this locally", and the invariant becomes "this can never fail" instead
 * of "the ordering must hold".
 */

import type { AcpClientEnvFactoryContext, AcpAgentOptions, AcpSessionRuntime } from "./agent.js";
import type { AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AgentSessionHost } from "@codent/core";

/** The session's runtime plus the two things its owner needs: late binding and release. */
export interface SessionRuntime {
  host: AgentSessionHost;
  /** Bind the disk session id once `host.create` has minted it. */
  bind: (sessionId: string) => void;
  dispose: () => Promise<void>;
  /** The client-backed env, when this runtime has one (`--client-env`). */
  clientEnv?: AcpSessionRuntime["clientEnv"];
}

/** What {@link buildSessionRuntime} needs from the app it runs in. */
export interface BuildSessionRuntimeContext {
  options: Pick<AcpAgentOptions, "host" | "createSessionHost">;
  /** The agent-side connection handle the env calls back through. */
  client: () => AgentContext;
  /** Client capabilities observed during `initialize` (read lazily: they arrive before any session). */
  getClientCapabilities: () => ClientCapabilities | undefined;
}

/**
 * Build a session's runtime.
 *
 * Without `createSessionHost` this is the process-wide host and `bind` / `dispose` are no-ops, so
 * every call site reads the same whether or not `--client-env` is on.
 */
export async function buildSessionRuntime(context: BuildSessionRuntimeContext): Promise<SessionRuntime> {
  const { options, client, getClientCapabilities } = context;
  if (!options.createSessionHost) {
    return { host: options.host, bind: () => undefined, dispose: async () => undefined };
  }

  let sessionId = "";
  const factoryContext: AcpClientEnvFactoryContext = {
    client,
    // `undefined` until `host.create` has produced a session — see the module header.
    sessionId: () => (sessionId ? sessionId : undefined),
    clientCapabilities: getClientCapabilities(),
  };
  const perSession = await options.createSessionHost(factoryContext);

  return {
    host: perSession.host,
    bind: (id: string) => {
      sessionId = id;
    },
    dispose: perSession.dispose,
    ...(perSession.clientEnv ? { clientEnv: perSession.clientEnv } : {}),
  };
}
