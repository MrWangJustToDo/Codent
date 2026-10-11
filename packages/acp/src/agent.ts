/**
 * CodentAcpAgent — the agent side of ACP.
 *
 * Serves an {@link AgentSessionHost} over stdio: each ACP session maps to one
 * in-process `AgentSession` under a stable external id, and an
 * {@link AcpProjector} turns its channels into `session/update` notifications.
 * Prompt turns dispatch through the session and resolve to an ACP `StopReason`;
 * approvals / `ask_user` become `session/request_permission` /
 * `elicitation/create` round-trips.
 */

import { agent as createAgentApp, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import { commandsFromSnapshot, dispatchSlashCommand, parseSlashCommand } from "./commands.js";
import { promptBlocksToContent, type PromptCaps } from "./content.js";
import {
  buildElicitationRequest,
  mapElicitationResponse,
  mapPermissionOutcome,
  permissionOptions,
} from "./permissions.js";
import { AcpProjector } from "./projector.js";
import { toolKindFor } from "./tools.js";

import type { SessionUpdate } from "./types.js";
import type {
  AgentApp,
  AgentConnection,
  AgentContext,
  ClientCapabilities,
  PromptRequest,
  SessionMode,
  SessionModeState,
  StopReason,
} from "@agentclientprotocol/sdk";
import type {
  AgentSession,
  AgentSessionHost,
  AgentSessionSnapshot,
  ModelInfo,
  ModelStyle,
  AgentMode,
} from "@codent/core";

/** Per-session bookkeeping. */
interface SessionBridge {
  session: AgentSession;
  /** The external ACP session id all updates/requests are tagged with. */
  acpId: string;
  projector: AcpProjector;
  /** Serializes prompt turns: one in-flight prompt per session. */
  chain: Promise<unknown>;
  cancelled: boolean;
  lastFinishReason: string | undefined;
  seenApprovals: Set<string>;
  seenAskUser: Set<string>;
  /** In-flight permission/elicitation request controllers (cancelled on cancel/close). */
  pending: Set<AbortController>;
  elicitation: boolean;
  promptCaps: PromptCaps;
}

export interface AcpAgentDefaults {
  model: string;
  modelStyle?: ModelStyle;
  modelBaseURL?: string;
  modelApiKey?: string;
  modelInfo?: ModelInfo;
  systemPrompt?: string;
}

export interface AcpAgentOptions {
  host: AgentSessionHost;
  defaults: AcpAgentDefaults;
  rootPath?: string;
  version?: string;
}

const AGENT_NAME = "codent";
const MODE_IDS: AgentMode[] = ["normal", "auto", "plan"];
const MODE_META: Record<AgentMode, { name: string; description: string }> = {
  normal: { name: "Normal", description: "Ask before risky actions" },
  auto: { name: "Auto", description: "Skip tool approvals (YOLO)" },
  plan: { name: "Plan", description: "Explore read-only, then build a plan" },
};

function sessionModes(current: AgentMode): SessionModeState {
  const availableModes: SessionMode[] = MODE_IDS.map((id) => ({ id, ...MODE_META[id] }));
  return { currentModeId: current, availableModes };
}

/** Create the ACP agent app (handlers registered; call `connect(stream)` to serve). */
export function createAcpAgent(options: AcpAgentOptions): AgentApp {
  const app = createAgentApp({ name: AGENT_NAME });
  const rootPath = options.rootPath ?? process.cwd();
  const version = options.version ?? "0.0.1";
  const bridges = new Map<string, SessionBridge>();
  let connection: AgentConnection | null = null;
  let initCaps: ClientCapabilities | undefined;

  app.onConnect((conn) => {
    connection = conn;
  });

  const client = (): AgentContext => {
    const conn = connection as AgentConnection | null;
    if (!conn) throw new Error("ACP connection not established");
    return conn.client;
  };

  const emit = (acpId: string, update: SessionUpdate): void => {
    try {
      void client()
        .notify(methods.client.session.update, { sessionId: acpId, update })
        .catch(() => {});
    } catch {
      // not connected yet — drop
    }
  };

  const attach = (session: AgentSession, clientCaps: ClientCapabilities | undefined, acpId: string): SessionBridge => {
    const bridge: SessionBridge = {
      session,
      acpId,
      chain: Promise.resolve(),
      cancelled: false,
      lastFinishReason: undefined,
      seenApprovals: new Set(),
      seenAskUser: new Set(),
      pending: new Set(),
      elicitation: Boolean(clientCaps?.elicitation?.form),
      promptCaps: { image: true, audio: true, embeddedContext: true },
      projector: undefined as unknown as AcpProjector,
    };
    bridge.projector = new AcpProjector(session, {
      rootPath,
      emit: (update) => emit(bridge.acpId, update),
      commands: () => commandsFromSnapshot(session.getSnapshot()),
      client: {
        compaction: Boolean(clientCaps?.session?.compaction),
        notices: Boolean(clientCaps?.session?.notices),
      },
      onInteraction: (payload) => void handleInteractions(bridge, payload),
    });
    bridge.projector.start();
    bridges.set(acpId, bridge);
    return bridge;
  };

  const closeBridge = async (bridge: SessionBridge): Promise<void> => {
    for (const controller of bridge.pending) controller.abort();
    bridge.pending.clear();
    await bridge.session.dispatch({ type: "stop" }).catch(() => undefined);
    bridge.projector.stop();
    for (const [id, b] of bridges) if (b === bridge) bridges.delete(id);
    await options.host.destroy(bridge.session.id);
  };

  const handleInteractions = async (bridge: SessionBridge, payload: unknown): Promise<void> => {
    const snapshot = payload as {
      approvals?: Array<{ approvalId: string; toolName: string; toolCallId: string }>;
      askUser?: Array<{ toolCallId: string; question: string; options?: string[]; multiSelect?: boolean }>;
    };
    for (const approval of snapshot.approvals ?? []) {
      if (bridge.seenApprovals.has(approval.approvalId)) continue;
      bridge.seenApprovals.add(approval.approvalId);
      void requestApproval(bridge, approval);
    }
    for (const ask of snapshot.askUser ?? []) {
      if (bridge.seenAskUser.has(ask.toolCallId)) continue;
      bridge.seenAskUser.add(ask.toolCallId);
      void requestElicitation(bridge, ask);
    }
  };

  const requestApproval = async (
    bridge: SessionBridge,
    approval: { approvalId: string; toolName: string; toolCallId: string }
  ): Promise<void> => {
    const controller = new AbortController();
    bridge.pending.add(controller);
    try {
      const response = await client().request(
        methods.client.session.requestPermission,
        {
          sessionId: bridge.acpId,
          toolCall: {
            toolCallId: approval.toolCallId,
            title: approval.toolName,
            kind: toolKindFor(approval.toolName),
            status: "pending",
          },
          options: permissionOptions(),
        },
        { cancellationSignal: controller.signal }
      );
      const decision = mapPermissionOutcome(response);
      if (!decision) return;
      await bridge.session.dispatch({
        type: "respondApproval",
        approvalId: approval.approvalId,
        approved: decision.approved,
      });
    } catch {
      // connection closed / cancelled — the session's own approval timeout settles it
    } finally {
      bridge.pending.delete(controller);
    }
  };

  const requestElicitation = async (
    bridge: SessionBridge,
    ask: { toolCallId: string; question: string; options?: string[]; multiSelect?: boolean }
  ): Promise<void> => {
    const controller = new AbortController();
    bridge.pending.add(controller);
    try {
      if (!bridge.elicitation) {
        emit(bridge.acpId, {
          sessionUpdate: "agent_message_chunk",
          messageId: `${bridge.acpId}-ask-${ask.toolCallId}`,
          content: { type: "text", text: `The agent asked: ${ask.question}` },
        });
        await bridge.session.dispatch({
          type: "addToolResult",
          toolCallId: ask.toolCallId,
          output: askUserOutput(ask, null, true),
        });
        return;
      }
      const response = await client().request(
        methods.client.elicitation.create,
        buildElicitationRequest(bridge.acpId, ask),
        { cancellationSignal: controller.signal }
      );
      await bridge.session.dispatch({
        type: "addToolResult",
        toolCallId: ask.toolCallId,
        output: askUserOutput(ask, mapElicitationResponse(response), false),
      });
    } catch {
      // connection closed / cancelled — leave the interaction to time out
    } finally {
      bridge.pending.delete(controller);
    }
  };

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  app.onRequest(methods.agent.initialize, (ctx) => {
    initCaps = ctx.params.clientCapabilities;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        // Per-session MCP servers are not wired yet — do not over-claim.
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: { resume: {}, close: {} },
        auth: { logout: {} },
      },
      agentInfo: { name: AGENT_NAME, title: "Codent", version },
      authMethods: [],
    };
  });

  app.onRequest(methods.agent.authenticate, () => ({}));
  app.onRequest(methods.agent.logout, () => ({}));

  const createOptions = (): Parameters<AgentSessionHost["create"]>[0] => ({
    name: `${AGENT_NAME}-${bridges.size + 1}`,
    model: options.defaults.model,
    ...(options.defaults.modelStyle ? { modelStyle: options.defaults.modelStyle } : {}),
    ...(options.defaults.modelBaseURL ? { modelBaseURL: options.defaults.modelBaseURL } : {}),
    ...(options.defaults.modelApiKey ? { modelApiKey: options.defaults.modelApiKey } : {}),
    ...(options.defaults.modelInfo ? { modelInfo: options.defaults.modelInfo } : {}),
    ...(options.defaults.systemPrompt ? { systemPrompt: options.defaults.systemPrompt } : {}),
  });

  app.onRequest(methods.agent.session.new, async (ctx) => {
    if (ctx.params.cwd && ctx.params.cwd !== rootPath) {
      process.stderr.write(
        `[codent-acp] note: session cwd ${ctx.params.cwd} differs from workspace root ${rootPath}\n`
      );
    }
    const { session } = await options.host.create(createOptions());
    const bridge = attach(session, initCaps, session.id);
    return { sessionId: bridge.acpId, modes: sessionModes(session.getSnapshot().mode) };
  });

  const resumeSession = async (
    sessionId: string,
    replay: boolean,
    clientCaps: ClientCapabilities | undefined
  ): Promise<void> => {
    const { session } = await options.host.create({ ...createOptions(), resumeSessionId: sessionId });
    const bridge = attach(session, clientCaps, sessionId);
    if (replay) bridge.projector.replayFrom(session.getSnapshot());
  };

  app.onRequest(methods.agent.session.load, async (ctx) => {
    await resumeSession(ctx.params.sessionId, true, initCaps);
    return {};
  });

  app.onRequest(methods.agent.session.resume, async (ctx) => {
    await resumeSession(ctx.params.sessionId, false, initCaps);
    return {};
  });

  app.onRequest(methods.agent.session.close, async (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (bridge) await closeBridge(bridge);
    return {};
  });

  app.onRequest(methods.agent.session.setMode, async (ctx) => {
    const mode = ctx.params.modeId as AgentMode;
    if (!MODE_IDS.includes(mode)) throw new Error(`Unknown mode: ${ctx.params.modeId}`);
    const bridge = bridges.get(ctx.params.sessionId);
    if (bridge) await bridge.session.dispatch({ type: "mode.set", mode });
    return {};
  });

  app.onRequest(methods.agent.session.prompt, async (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (!bridge) throw new Error(`Unknown session: ${ctx.params.sessionId}`);
    const run = bridge.chain.then(() => runPrompt(bridge, ctx.params));
    bridge.chain = run.catch(() => undefined);
    return run;
  });

  app.onNotification(methods.agent.session.cancel, (ctx) => {
    const bridge = bridges.get(ctx.params.sessionId);
    if (!bridge) return;
    bridge.cancelled = true;
    for (const controller of bridge.pending) controller.abort();
    bridge.pending.clear();
    void bridge.session.dispatch({ type: "stop" }).catch(() => undefined);
  });

  const runPrompt = async (bridge: SessionBridge, params: PromptRequest): Promise<{ stopReason: StopReason }> => {
    bridge.cancelled = false;
    const mapping = promptBlocksToContent(params.prompt, bridge.promptCaps);
    if (mapping.error) throw new Error(mapping.error);

    const text = typeof mapping.content === "string" ? mapping.content : undefined;
    const parsed = text ? parseSlashCommand(text) : null;
    if (parsed && text) {
      const result = await dispatchSlashCommand(bridge.session, bridge.session.getSnapshot(), parsed);
      if (result.handled) {
        if (result.message) {
          emit(bridge.acpId, {
            sessionUpdate: "agent_message_chunk",
            messageId: `${bridge.acpId}-command-${Date.now()}`,
            content: { type: "text", text: result.message },
          });
        }
        return { stopReason: "end_turn" };
      }
    }

    try {
      await bridge.session.dispatch({ type: "send", content: mapping.content });
    } catch (error) {
      if (bridge.cancelled) return { stopReason: "cancelled" };
      throw error;
    }
    return { stopReason: stopReasonFor(bridge) };
  };

  return app;
}

/** `ask_user` result shaped for `askUserOutputSchema` (the client tool's contract). */
function askUserOutput(
  ask: { question: string; options?: string[] },
  answer: { answer: string; selected?: string[]; draft?: string } | null,
  cancelled: boolean
): Record<string, unknown> {
  return {
    question: ask.question,
    answer: answer?.answer ?? "",
    hasOptions: Boolean(ask.options?.length),
    durationMs: 0,
    cachedOutputPath: null,
    success: true,
    tool: "ask_user",
    ...(answer?.selected ? { selected: answer.selected, multiSelect: true } : {}),
    ...(answer?.draft !== undefined ? { draft: answer.draft } : {}),
    ...(cancelled ? { cancelled: true } : {}),
  };
}

function stopReasonFor(bridge: SessionBridge): StopReason {
  const snapshot = bridge.session.getSnapshot();
  if (bridge.cancelled || snapshot.status === "aborted") return "cancelled";
  if (snapshot.status === "error") return "end_turn";
  const { iteration } = snapshot;
  if (iteration.max > 0 && iteration.current >= iteration.max) return "max_turn_requests";
  if (bridge.lastFinishReason === "length") return "max_tokens";
  return "end_turn";
}

/**
 * Serve an ACP agent over stdio. Returns the live connection.
 *
 * The caller (a bin entry) owns process teardown; this only wires the transport.
 */
export function runAcpAgentStdio(options: AcpAgentOptions): AgentConnection {
  const app = createAcpAgent(options);
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      process.stdin.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      process.stdin.on("end", () => controller.close());
      process.stdin.on("error", (err) => controller.error(err));
    },
  });
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve) => {
        if ((process.stdout as unknown as { destroyed?: boolean }).destroyed) return resolve();
        process.stdout.write(chunk, () => resolve());
      });
    },
  });
  return app.connect(ndJsonStream(output, input));
}

/** Re-exported for tests / callers that need the snapshot type. */
export type { AgentSessionSnapshot };
