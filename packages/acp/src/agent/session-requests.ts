/**
 * The session-request plane: `session/new`, `load`, `resume`, `close`, and the disk catalog
 * (`list` / `delete`).
 *
 * One function is exported besides the registration: {@link SessionRequests.resume}. A fork of a
 * session this process has not opened is restored exactly like a `load` (and its source re-attached
 * the same way afterwards), so the restore path exists once rather than once per request type.
 *
 * Three ordering facts are load-bearing here, each a shipped bug before it was a rule:
 * - **An already-live session is reused, never re-created** (a second `host.create` over the same
 *   disk log means two writers and two projectors racing under one id);
 * - **the response frame must carry the id before any update keyed by it arrives**, which is what
 *   `deferEmits` + the `setImmediate` flush are for;
 * - **a failed create releases the per-session runtime** — only `close` disposes, and there is no
 *   bridge yet.
 */

import { methods, RequestError } from "@agentclientprotocol/sdk";

import { mapAcpMcpServers } from "../session/mcp.js";
import { diskSessionId, sessionSelectors, sessionSelectorsFor } from "../session/session-status.js";
import { createSessionCatalog } from "../session/sessions.js";

import { mcpKeyOf, rejectAdditionalDirectories, resolveSessionRoot } from "./session-creation.js";

import type { AcpAgentContext } from "./context.js";
import type { SessionBridge } from "./session-bridge.js";
import type { ClientCapabilities, McpServer } from "@agentclientprotocol/sdk";
import type { AgentSession } from "@codent/core";

export interface SessionRequests {
  /**
   * Restore (or reuse) a session.
   *
   * `acpId` is the id the CLIENT addresses this session by. It defaults to `sessionId`
   * (`load`/`resume` pass the id they were given). A fork's restored source passes its stable
   * handle, which can differ from the disk id after `/new`; the bridge must emit under that handle
   * from the FIRST seed frame on.
   */
  resume: (
    sessionId: string,
    replay: boolean,
    clientCaps: ClientCapabilities | undefined,
    mcpServers: McpServer[] | undefined,
    additionalDirectories: string[] | undefined,
    cwd: string | undefined,
    acpId?: string
  ) => Promise<SessionBridge>;
}

export function registerSessionRequests(ctx: AcpAgentContext): SessionRequests {
  const { app, options, rootPath, bridges, creation, config, sessionRoots } = ctx;

  app.onRequest(methods.agent.session.new, async (request) => {
    const params = request.params;
    // Checked FIRST, so a refused request creates nothing (same ordering as the malformed-MCP
    // check below).
    rejectAdditionalDirectories(params.additionalDirectories);
    // ACP: `cwd` is the session's workspace root, not a hint. Every relative path, `.agents/**`
    // and `session/list` for this session follow it.
    const sessionRoot = resolveSessionRoot(params.cwd, rootPath);
    creation.assertRoot(sessionRoot);
    // Mapped (and validated) BEFORE the session exists: a malformed entry must not leave a
    // half-configured session behind, and a client cannot retract one it was never told about.
    const mapped = mapAcpMcpServers(params.mcpServers);
    if (mapped.error) {
      throw new Error(mapped.error);
    }
    // The runtime owns this session's env (client-backed under `--client-env`), so it is built here
    // rather than borrowed from the process-wide host.
    const runtime = await creation.createRuntime(sessionRoot);
    let session: AgentSession;
    // Built BEFORE the session: MCP servers connect inside `host.create`, and supplying the hook is
    // what makes core advertise `elicitation` at that handshake. Bound after it, when the bridge exists.
    const elicit = creation.mcpElicitationFor(ctx.capabilities(), runtime.host);
    try {
      // Built inside the try: a prompt-build failure would otherwise discard the per-session
      // runtime (`--client-env` env / a foreign root's agent) with nothing left to release it.
      const systemPrompt = await creation.systemPrompt(sessionRoot, runtime);
      ({ session } = await runtime.host.create(creation.createOptions(mapped.servers, systemPrompt, elicit?.hook)));
    } catch (error) {
      // The runtime owns a per-session env; if the session never came to exist, nothing else will
      // ever release it (only `close` disposes, and there is no bridge yet).
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
    const acpId = diskSessionId(session);
    runtime.bind(acpId);
    sessionRoots.set(acpId, sessionRoot);
    const bridge = bridges.attach(session, ctx.capabilities(), acpId, runtime, {
      rootPath: sessionRoot,
      diskSessionId: acpId,
      mcpKey: mcpKeyOf(mapped.servers),
      ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
      ...(elicit ? { mcpElicitation: elicit } : {}),
      // The response frame must carry the id before ANY update keyed by it arrives. `start()` queues
      // the retained values and the seed, and the tick below flushes them after the response.
      deferEmits: true,
    });
    const snapshot = session.getSnapshot();
    config.seed(bridge);
    setImmediate(() => {
      // The client may have closed the session between the response and this tick; do not emit
      // seed notifications for an id nobody owns any more.
      if (bridges.get(acpId) !== bridge) return;
      bridge.projector.flushDeferred();
    });
    return {
      sessionId: acpId,
      ...sessionSelectors(snapshot, options.models, bridge.selectedModelEntryIndex),
    };
  });

  const resume: SessionRequests["resume"] = async (
    sessionId,
    replay,
    clientCaps,
    mcpServers,
    additionalDirectories,
    cwd,
    acpId
  ) => {
    // A child is not a top-level session: load/resume/fork must not adopt it as one.
    if (await bridges.isChild(sessionId)) {
      throw RequestError.invalidParams(undefined, `Unknown session: ${sessionId}`);
    }
    // `additionalDirectories` is not a declared capability; see `rejectAdditionalDirectories`.
    rejectAdditionalDirectories(additionalDirectories);
    // Restoring a session runs the same `Host.create` as `session/new` (with `resumeSessionId`),
    // so a client-supplied list is carried exactly the same way: it replaces the workspace
    // config for this session, and an empty list falls back to the file.
    //
    // Rejecting it instead would be a hard block on every client that sends its configured
    // servers here — which is the normal case, and `load` cannot even omit the field (it is
    // required by `LoadSessionRequest`).
    const mapped = mapAcpMcpServers(mcpServers);
    if (mapped.error) {
      throw new Error(mapped.error);
    }
    // Already live in this process: REUSE it. Going on would build a second session over the same
    // disk log (two writers) and attach a second projector over the same channels — and the first one
    // would never be stopped, so every update (both tagged with this session id) arrives twice, with
    // two sets of cursors racing each other.
    //
    // The id may be the stable handle or the disk id: a client can hand back either after a
    // `/new`-style replacement, when the two deliberately diverge.
    const live = bridges.find(sessionId);
    if (live) {
      if (cwd && resolveSessionRoot(cwd, live.rootPath) !== live.rootPath) {
        throw RequestError.invalidParams(
          undefined,
          `cwd ${cwd} does not match the live session's workspace root ${live.rootPath}`
        );
      }
      // A live session's MCP servers are fixed at creation. Silently ignoring a different list
      // would let the client believe it is connected to servers it never reached. `load`/`resume`
      // always carry the field; an empty list is a real value (the file fallback), not "unspecified".
      if (mcpServers !== undefined && mcpKeyOf(mapped.servers) !== live.mcpKey) {
        throw RequestError.invalidParams(
          undefined,
          "mcpServers cannot change for a session that is already live in this process"
        );
      }
      // `load` owes the client the transcript once. A repeat on the live session must not replay it
      // again — the client would render the whole conversation a second time.
      if (replay && !live.replayed) {
        live.replayed = true;
        live.projector.replayFrom(live.session.getSnapshot());
      }
      // A load/resume on a LIVE parent must re-establish its child associations for the client
      // (RFD: invalidate cached child state on reconnect). Announcements are sent after the
      // response frame; the child projectors stay subscribed, so no history is replayed twice.
      setImmediate(() => {
        if (live.closed) return;
        live.projector.resetSubagents();
        live.projector.resyncSubagents();
      });
      // A live session can be addressed by its stable handle or its disk id; both must carry the
      // root that a later `session/delete` needs (the request itself has no cwd).
      sessionRoots.set(sessionId, live.rootPath);
      sessionRoots.set(live.diskSessionId, live.rootPath);
      return live;
    }
    // `cwd` is the session's workspace root (ACP requires it on load/resume). The client told us
    // the id here, so the per-session env can carry both from the start.
    const sessionRoot = resolveSessionRoot(cwd, rootPath);
    creation.assertRoot(sessionRoot);
    const runtime = await creation.createRuntime(sessionRoot);
    runtime.bind(sessionId);
    let session: AgentSession;
    // Same ordering as `session/new`: the hook must exist before `host.create` (MCP connects there),
    // and each resumed session gets its own channel, bound to its own bridge.
    const elicit = creation.mcpElicitationFor(clientCaps, runtime.host);
    try {
      // Built inside the try for the same reason as `session/new`: a prompt-build failure must not
      // orphan the per-session runtime.
      const systemPrompt = await creation.systemPrompt(sessionRoot, runtime);
      ({ session } = await runtime.host.create({
        ...creation.createOptions(mapped.servers, systemPrompt, elicit?.hook),
        resumeSessionId: sessionId,
      }));
    } catch (error) {
      // A failed restore is the common case here (unknown or unreadable id), and the runtime owns a
      // per-session env that nothing else would ever release — same reason as `session/new`.
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
    // The requested disk id is authoritative here (it is what the client will keep using);
    // `diskSessionId` is the same value after the restore, so assert rather than diverge.
    const handleId = acpId ?? sessionId;
    const restored = bridges.attach(session, clientCaps, handleId, runtime, {
      rootPath: sessionRoot,
      diskSessionId: diskSessionId(session),
      mcpKey: mcpKeyOf(mapped.servers),
      ...(mcpServers ? { mcpServers } : {}),
      ...(elicit ? { mcpElicitation: elicit } : {}),
      replay,
      // Both `load` and `resume` are reconnects: an already-announced child must not replay its
      // history. A child created after this attach is new and does replay.
      skipChildReplay: true,
    });
    sessionRoots.set(sessionId, sessionRoot);
    sessionRoots.set(handleId, sessionRoot);
    sessionRoots.set(restored.diskSessionId, sessionRoot);
    return restored;
  };

  app.onRequest(methods.agent.session.load, async (request) => {
    const bridge = await resume(
      request.params.sessionId,
      true,
      ctx.capabilities(),
      request.params.mcpServers,
      request.params.additionalDirectories,
      request.params.cwd
    );
    config.seed(bridge);
    return {
      ...sessionSelectorsFor(bridge, options.models),
      // The request may have named a disk id while the live bridge uses a stable handle; tell the
      // client which id its updates will carry (ACP has no other place to say it).
      _meta: { sessionId: bridge.acpId },
    };
  });

  app.onRequest(methods.agent.session.resume, async (request) => {
    const bridge = await resume(
      request.params.sessionId,
      false,
      ctx.capabilities(),
      request.params.mcpServers,
      request.params.additionalDirectories,
      request.params.cwd
    );
    config.seed(bridge);
    return {
      ...sessionSelectorsFor(bridge, options.models),
      _meta: { sessionId: bridge.acpId },
    };
  });

  app.onRequest(methods.agent.session.close, async (request) => {
    // A child has no top-level bridge; closing it is not a way to destroy a subagent.
    if (await bridges.isChild(request.params.sessionId, false)) return {};
    const bridge = bridges.find(request.params.sessionId);
    if (bridge) await bridges.close(bridge);
    return {};
  });

  // --------------------------------------------------------------------------
  // Session catalog (list / delete)
  // --------------------------------------------------------------------------

  const catalog = createSessionCatalog({
    ...(options.host.listPersistedSessions
      ? { listPersistedSessions: options.host.listPersistedSessions.bind(options.host) }
      : {}),
    ...(options.listPersistedSessionsAt ? { listPersistedSessionsAt: options.listPersistedSessionsAt } : {}),
    ...(options.host.deleteSession ? { deleteSession: options.host.deleteSession.bind(options.host) } : {}),
    ...(options.deleteSessionAt ? { deleteSessionAt: options.deleteSessionAt } : {}),
    noteListed: (root, sessions) => {
      for (const session of sessions) sessionRoots.set(session.id, root);
    },
    rootForSession: (id) => sessionRoots.get(id),
    // A live session is deleted through ITS runtime (which knows the workspace, and under
    // `--client-env` the client's own fs) — then the bridge is released. Deleting through the
    // process-root host destroyed the agent but left the file in the session's root.
    deleteLive: async (sessionId) => {
      const live = bridges.find(sessionId);
      if (!live?.runtime.host.deleteSession) return false;
      await live.runtime.host.deleteSession(sessionId);
      await bridges.close(live);
      return true;
    },
    lookupLive: (id) => {
      const bridge = bridges.lookup(id);
      return bridge ? { handle: bridge.acpId, diskId: bridge.diskSessionId } : undefined;
    },
    rootPath,
    closeLive: async (sessionId) => {
      const live = bridges.find(sessionId);
      if (!live) return false;
      await bridges.close(live);
      return true;
    },
    note: (text) => process.stderr.write(text),
  });
  app.onRequest(methods.agent.session.list, (request) => catalog.list(request.params));
  app.onRequest(methods.agent.session.delete, async (request) => {
    // `deleteSession` looks the id up as an agent; on a child that would destroy a live subagent.
    // Idempotent no-op keeps ACP's delete contract for an id the client does not own.
    if (await bridges.isChild(request.params.sessionId)) return {};
    return catalog.remove(request.params);
  });

  return { resume };
}
