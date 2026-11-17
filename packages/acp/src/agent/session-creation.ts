/**
 * Session construction: everything that turns one ACP request into a core session.
 *
 * Four decisions live together because they must agree: which runtime/host the session runs on (its
 * `cwd` IS the workspace root), which system prompt it starts with (the one built from *that*
 * workspace), which MCP servers it runs with (a client-supplied list replaces the workspace file),
 * and whether an MCP server may ask the client a question (it may only while a hook exists, and
 * that has to be decided before `host.create`, because MCP connects inside it).
 */

import { RequestError } from "@agentclientprotocol/sdk";
import { buildDefaultSystemPrompt, defaultPath } from "@codent/core";

import { createMcpElicitation, type McpElicitation } from "../interaction/mcp-elicitation.js";
import { buildSessionRuntime, type SessionRuntime } from "../session/session-runtime.js";
import { resolveRoot } from "../wire/paths.js";

import { AGENT_NAME } from "./identity.js";

import type { AcpAgentOptions } from "./options.js";
import type { AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AgentSessionHost, McpElicitHook, McpServerConfig } from "@codent/core";

/** What session construction needs from the app that owns it. */
export interface SessionCreationDeps {
  options: AcpAgentOptions;
  /** The process root — the one root a `--system` override applies to. */
  processRoot: string;
  /** The agent-side connection handle (read lazily: it may not be up yet). */
  client: () => AgentContext;
  /** Client capabilities observed during `initialize` (read lazily: they arrive before any session). */
  getClientCapabilities: () => ClientCapabilities | undefined;
}

export interface SessionCreation {
  /** Build this session's runtime (see `session-runtime.ts`). */
  createRuntime: (sessionRoot: string) => Promise<SessionRuntime>;
  /** The system prompt a session in this root starts with. */
  systemPrompt: (sessionRoot: string, runtime: SessionRuntime) => Promise<string | undefined>;
  /** Refuse a `cwd` this host cannot serve (a host without a per-session runtime has one root). */
  assertRoot: (sessionRoot: string) => void;
  /**
   * This session's MCP elicitation channel, or `undefined` when nothing can answer one.
   *
   * Two independent reasons to withhold the hook, and both must hold for one to exist: the client
   * advertised form elicitation, and the host accepts a hook at all (a remote session host refuses
   * it, because a hook is executable code that cannot cross the wire).
   */
  mcpElicitationFor: (caps: ClientCapabilities | undefined, host: AgentSessionHost) => McpElicitation | undefined;
  /** The `host.create` options every session-request path shares. */
  createOptions: (
    mcpServers?: Record<string, McpServerConfig>,
    systemPrompt?: string,
    mcpElicit?: McpElicitHook
  ) => Parameters<AgentSessionHost["create"]>[0];
}

/**
 * A `cwd` from an ACP request, normalized; `fallback` when the request omitted it.
 *
 * It must be absolute: a relative `cwd` belongs to no root, and re-basing it silently would run the
 * session in a workspace the client did not name.
 */
export function resolveSessionRoot(cwd: string | undefined, fallback: string): string {
  if (!cwd) return fallback;
  if (!defaultPath.isAbsolute(cwd)) {
    throw RequestError.invalidParams(undefined, `cwd must be an absolute path: ${cwd}`);
  }
  return resolveRoot(cwd);
}

/**
 * Refuse a request that asks for `additionalDirectories`.
 *
 * The capability is deliberately undeclared (the agent serves exactly the workspace root it was
 * handed at handshake), and the base requirement is that a request for an undeclared capability is
 * refused rather than quietly ignored: `openspec/specs/acp-agent-host/spec.md` — "对应的 client 请求
 * MUST NOT 被接受（返回 JSON-RPC 错误）". Ignoring the field would let a client keep talking to an
 * agent that cannot see the roots it asked for, with nothing anywhere saying so.
 *
 * EVERY request type that can carry the field must call this — `session/new`, `session/load`,
 * `session/resume`, `session/fork`. `session/new` was the one that used to ignore it, which was the
 * worst of the four: it is the entry point a client reaches for by default.
 */
export function rejectAdditionalDirectories(directories: readonly string[] | undefined | null): void {
  if (directories?.length) {
    throw new Error(
      "additionalDirectories is not supported: this agent serves exactly the workspace root it " + "was started with"
    );
  }
}

/**
 * The MCP list a session was created with, as a stable comparison key.
 *
 * A live session's servers are fixed at creation, so `load`/`resume` compare this key against the
 * bridge's to tell "the same list" from "a list that cannot take effect".
 */
export function mcpKeyOf(servers: Record<string, McpServerConfig> | undefined): string {
  return JSON.stringify(Object.entries(servers ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function createSessionCreation(deps: SessionCreationDeps): SessionCreation {
  const { options, processRoot, client, getClientCapabilities } = deps;
  let sessionSeq = 0;

  const systemPrompt = async (sessionRoot: string, runtime: SessionRuntime): Promise<string | undefined> => {
    // A `--system` override is a per-ROOT decision: a session whose `cwd` differs rebuilds the
    // built-in prompt from that workspace, so only the process root keeps the override. Carrying a
    // customised prompt across roots would need a template/builder on `AcpAgentDefaults`.
    if (sessionRoot === processRoot) return options.defaults.systemPrompt;
    const env = runtime.host.getEnv?.();
    // A host that cannot expose its env (an embedder) cannot rebuild the prompt; the boot prompt is
    // the only honest fallback. The real bootstrap host always exposes it.
    if (!env) return options.defaults.systemPrompt;
    try {
      return await buildDefaultSystemPrompt(undefined, env);
    } catch {
      return options.defaults.systemPrompt;
    }
  };

  const createOptions: SessionCreation["createOptions"] = (
    mcpServers?: Record<string, McpServerConfig>,
    systemPromptValue = options.defaults.systemPrompt,
    mcpElicit?: McpElicitHook
  ) => {
    sessionSeq += 1;
    return {
      name: `${AGENT_NAME}-${sessionSeq}`,
      model: options.defaults.model,
      ...(options.defaults.modelStyle ? { modelStyle: options.defaults.modelStyle } : {}),
      ...(options.defaults.modelBaseURL ? { modelBaseURL: options.defaults.modelBaseURL } : {}),
      ...(options.defaults.modelApiKey ? { modelApiKey: options.defaults.modelApiKey } : {}),
      ...(options.defaults.modelInfo ? { modelInfo: options.defaults.modelInfo } : {}),
      ...(options.defaults.maxIterations !== undefined ? { maxIterations: options.defaults.maxIterations } : {}),
      ...(options.defaults.maxConcurrentTasks !== undefined
        ? { maxConcurrentTasks: options.defaults.maxConcurrentTasks }
        : {}),
      ...(options.defaults.toolConfig ? { toolConfig: options.defaults.toolConfig } : {}),
      ...(options.defaults.extensionDirs?.length ? { extensionDirs: options.defaults.extensionDirs } : {}),
      ...(options.defaults.mcpConfigPath ? { mcpConfigPath: options.defaults.mcpConfigPath } : {}),
      // A different `cwd` gets the default prompt built from ITS workspace (the boot prompt was
      // built from the process root, so reusing it would embed the wrong project instructions).
      ...(systemPromptValue ? { systemPrompt: systemPromptValue } : {}),
      // Session-supplied servers REPLACE the workspace `.agents/mcp.json` (see
      // `AgentSessionCreateOptions.mcpServers`); absent ⇒ the file is the source, as before.
      ...(mcpServers ? { mcpServers } : {}),
      // An MCP server's question is answered through the client, so the capability exists exactly
      // when the client advertised form elicitation — see `mcp-elicitation.ts` for why the decision
      // belongs here (MCP connects inside `host.create`, after the ACP handshake).
      ...(mcpElicit ? { mcpElicit } : {}),
    };
  };

  const mcpElicitationFor: SessionCreation["mcpElicitationFor"] = (caps, host) =>
    host.acceptMcpElicit === false
      ? undefined
      : createMcpElicitation(caps, {
          client,
          ...(options.interactionTimeoutMs !== undefined ? { timeoutMs: options.interactionTimeoutMs } : {}),
        });

  return {
    createRuntime: (sessionRoot) =>
      buildSessionRuntime({ options, client, getClientCapabilities, rootPath: sessionRoot }),
    systemPrompt,
    assertRoot: (sessionRoot) => {
      if (sessionRoot !== processRoot && !options.createSessionHost) {
        throw RequestError.invalidParams(
          undefined,
          `This host cannot serve session cwd ${sessionRoot}: it was built for ${processRoot} and has no per-session runtime`
        );
      }
    },
    mcpElicitationFor,
    createOptions,
  };
}
