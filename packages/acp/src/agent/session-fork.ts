/**
 * `session/fork`: clone a conversation into a new session while the client's original thread stays
 * usable.
 *
 * A fork is the one request that REUSES a live agent instead of building one (`session.clone`
 * switches the only live agent to the clone), which forces three things this file exists for:
 *
 * - the **source is restored as its own bridge** afterwards — otherwise the client's original
 *   thread answers `Unknown session` on its next prompt, against ACP's "the source is unaffected";
 * - the **same bridge is re-keyed**, never duplicated (a second bridge would double-subscribe and
 *   double-send every update);
 * - projection is **stopped across the clone dispatch** — the session switches ids mid-call, and a
 *   frame emitted in that window is tagged with the SOURCE handle, so the client renders it twice.
 */

import { methods, RequestError } from "@agentclientprotocol/sdk";
import { errorMessage } from "@codent/core";

import { diskSessionId, sessionSelectors } from "../session/session-status.js";

import { rejectAdditionalDirectories, resolveSessionRoot } from "./session-creation.js";

import type { AcpAgentContext } from "./context.js";
import type { SessionRequests } from "./session-requests.js";

export function registerSessionFork(ctx: AcpAgentContext, sessions: SessionRequests): void {
  const { app, options, bridges, config, sessionRoots } = ctx;

  app.onRequest(methods.agent.session.fork, async (request) => {
    const params = request.params;
    const sourceId = params.sessionId;

    // Same refusal as every other request type: a fork is exactly as unable to widen the workspace
    // root as a fresh session is.
    rejectAdditionalDirectories(params.additionalDirectories);

    // A fork of a session this process has not opened is NORMAL for a client forking from
    // `session/list`: restore it first, exactly like `load`, then clone (no replay — the client
    // watches the NEW id from here on).
    const wasLive = Boolean(bridges.find(sourceId));
    let bridge = bridges.find(sourceId);
    if (!bridge) {
      bridge = await sessions.resume(sourceId, false, ctx.capabilities(), params.mcpServers, undefined, params.cwd);
    }
    if (!bridge) throw RequestError.invalidParams(undefined, `Unknown session: ${sourceId}`);

    // `cwd` must match the source for a LIVE source (the conversation continues in that workspace).
    // A cold source was just restored at the request's `cwd` (SessionMeta carries no root), so this
    // is an equality check of the root we restored it into.
    const forkRoot = resolveSessionRoot(params.cwd, bridge.rootPath);
    if (forkRoot !== bridge.rootPath) {
      throw RequestError.invalidParams(
        undefined,
        `fork cwd ${forkRoot} does not match the source session's workspace root ${bridge.rootPath}`
      );
    }

    // Fork-only rule: this path REUSES the source's live agent (no `Host.create`), so it cannot swap
    // MCP servers — `load`/`resume` do obey them, because each builds a fresh agent.
    if (params.mcpServers?.length && wasLive) {
      throw RequestError.invalidParams(
        undefined,
        "session/fork does not accept mcpServers for a live source (they are fixed at creation)"
      );
    }

    // Captured BEFORE the dispatch: a successful clone re-points the session to a NEW disk id,
    // so reading `activeSessionId` afterwards (or inside the re-key below) would key the map by
    // the new id twice and leave the source key behind — a second key for one bridge.
    const sourceDiskId = bridge.diskSessionId;
    const sourceHandle = bridge.acpId;
    const projectBridge = bridge;

    // Pause projection while the clone runs: the session switches ids mid-dispatch, and an update
    // emitted during that window would still be tagged with the SOURCE id (the client would see
    // it twice — once on the source, once after the rebind).
    projectBridge.projector.stop();
    // `session.clone` copies the whole transcript (ACP's fork request carries no fork point).
    // The source session is left intact on disk; core also refuses while a run is active.
    let result: { ok: boolean; error?: string; data?: { sessionId?: string } };
    try {
      result = (await projectBridge.session.dispatch({ type: "session.clone" })) as typeof result;
    } catch (error) {
      // Never leave the source bridge without a subscription just because the clone threw.
      projectBridge.projector.start({ primeOnly: true });
      throw error;
    }
    if (!result?.ok) {
      projectBridge.projector.start({ primeOnly: true });
      throw new Error(result?.error ?? "session/fork failed");
    }
    const newId = result.data?.sessionId ?? diskSessionId(projectBridge.session);

    // Re-key the SAME bridge: `branchSession` already switched the underlying agent to the new
    // session, so a second bridge would double-subscribe and double-send every update. Set the
    // new key before dropping the old one so no frame lands in a gap, and refresh `acpId`
    // because `emit` closes over `bridge.acpId`.
    projectBridge.acpId = newId;
    projectBridge.diskSessionId = newId;
    projectBridge.runtime.bind(newId);
    // No elicitation re-binding: the channel reads `bridge.acpId` on every question, so the clone
    // answers on `newId` by construction (a re-bind here would be the second place to remember).
    projectBridge.replayed = false;
    sessionRoots.set(newId, projectBridge.rootPath);
    // A fork is a new conversation: approvals/answers from the source do not carry over.
    projectBridge.seenApprovals.clear();
    projectBridge.seenAskUser.clear();
    projectBridge.approvalPolicy.clear();
    // Drop every id that pointed at the SOURCE conversation: the handle (which may differ from the
    // disk id after an earlier rebind), the requested source id, and its disk id.
    bridges.rekey(projectBridge, newId, [sourceHandle, sourceId, sourceDiskId]);

    // The SOURCE thread must stay usable. `session.clone` leaves it intact ON DISK but switches the
    // only live agent to the clone, so the client's original thread answered `Unknown session` on
    // its next prompt (ACP's fork contract says the source is unaffected). Restore it as its own
    // bridge: a second agent over the same root, with no transcript replay (the client has it).
    const sourceMcpServers = projectBridge.mcpServers;
    const restoredSource = await sessions
      .resume(
        sourceDiskId,
        false,
        ctx.capabilities(),
        sourceMcpServers,
        undefined,
        projectBridge.rootPath,
        sourceHandle
      )
      .catch((error: unknown) => {
        process.stderr.write(
          `[codent-acp] fork: could not re-attach source session ${sourceDiskId}: ${errorMessage(error)}\n`
        );
        return undefined;
      });
    if (restoredSource) {
      // The client may still address the source by its stable handle, the id it sent, or the disk
      // id; all of them must resolve to the restored bridge. `acpId` was already passed as the
      // handle to the attach above, so every seed/frame from it used the client's id.
      bridges.set(sourceId, restoredSource);
      if (sourceHandle !== sourceId) bridges.set(sourceHandle, restoredSource);
      if (sourceDiskId !== sourceId && sourceDiskId !== sourceHandle) {
        bridges.set(sourceDiskId, restoredSource);
      }
      sessionRoots.set(sourceDiskId, projectBridge.rootPath);
      sessionRoots.set(sourceId, projectBridge.rootPath);
      sessionRoots.set(sourceHandle, projectBridge.rootPath);
    }
    // The child projectors captured the SOURCE parent id, and their announcements were sent under
    // it. The cloned conversation is a new parent: stop them and re-announce under `newId` after
    // the response (a child has one immediate parent; it cannot stay announced under a retired id).
    bridges.resetChildren(projectBridge);
    // Prime + subscribe on the SAME handle: the cloned messages are already in the snapshot, so a
    // plain replay would duplicate the source transcript under the new id. The fork response carries
    // the new id, so queue its seed until the frame has gone out.
    projectBridge.projector.start({ primeOnly: true, deferEmits: true });
    setImmediate(() => {
      if (bridges.get(newId) !== projectBridge) return;
      projectBridge.projector.flushDeferred();
      // The client already has the child transcripts from the source conversation: re-announce the
      // association, but do not replay the child history.
      projectBridge.skipChildReplay = true;
      projectBridge.projector.resyncSubagents();
    });

    const snapshot = projectBridge.session.getSnapshot();
    config.seed(projectBridge);
    return {
      sessionId: newId,
      ...sessionSelectors(snapshot, options.models, projectBridge.selectedModelEntryIndex),
    };
  });
}
