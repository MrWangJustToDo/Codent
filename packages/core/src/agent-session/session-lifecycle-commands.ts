/**
 * Session-side helpers for rename / new-session commands (Host process only).
 */

import { dehydrateUIMessages } from "../agent/media/media-utils.js";
import { partTextContent } from "../agent/stream/message-parts.js";
import { isContextUIMessage } from "../agent/turn-context";
import { resolveTextAdapterForManaged } from "../managers/run-agent.js";
import { runSideTextQuery } from "../models/adapter/side-text-query.js";
import { errorMessage, toError } from "../utils/errors.js";
import { extractTextFromContent } from "../utils/message-content.js";

import { TITLE_SYSTEM_PROMPT } from "./session-summary-prompt.js";

import type { ManagedAgent } from "../managers/managed-agent.js";
import type { UIMessage } from "@tanstack/ai";

export async function generateAndApplySessionTitle(
  managed: ManagedAgent
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const session = managed.getSessionData();
  const store = managed.getSessionStore();
  if (!session || !store) {
    return { ok: false, error: "No active session" };
  }

  const textAdapter = await resolveTextAdapterForManaged(managed);
  if (!textAdapter) {
    return { ok: false, error: "No text adapter available for title generation" };
  }

  const messages = managed.getCanonicalFromUI();
  const recentText = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-4)
    .map((m) => extractTextFromContent(m.content))
    .filter(Boolean)
    .join("\n")
    .slice(-1000);

  if (!recentText) {
    return { ok: false, error: "No conversation content to generate title from" };
  }

  try {
    managed.getLog()?.info("chat", "Generating title...", { recentText });
    const { text, usage } = await runSideTextQuery(textAdapter, {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      userPrompt: recentText,
      maxOutputTokens: 60,
    });
    if (usage) {
      managed.usage.addTotal(usage);
    }
    const generated = text.trim().slice(0, 80);
    if (!generated) {
      return { ok: false, error: "Failed to generate title" };
    }
    session.name = generated;
    // Route through `setDisplayName` so the state channel broadcasts the new
    // title (a raw `managed.name = …` write never notified subscribers).
    managed.setDisplayName(generated);
    await store.save(session);
    managed.getLog()?.info("chat", "Title generated", { text: generated });
    return { ok: true, name: generated };
  } catch (error) {
    const err = toError(error);
    return { ok: false, error: `Title generation failed: ${err.message}` };
  }
}

export async function applySessionRename(
  managed: ManagedAgent,
  name: string
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: "Name is required" };
  }
  const session = managed.getSessionData();
  const store = managed.getSessionStore();
  managed.setDisplayName(trimmed);
  if (session && store) {
    session.name = trimmed;
    await store.save(session);
  }
  return { ok: true, name: trimmed };
}

export async function startNewDiskSession(
  managed: ManagedAgent
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  try {
    const session = await managed.sessionLifecycle.newSession("session-new");
    return { ok: true, sessionId: session.id };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

/** Plain text of a UI message's text parts (used to hand a fork point back to the editor). */
function uiMessageText(message: UIMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .map((part) => partTextContent(part as { type?: string; content?: unknown }))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * Resolve a fork selector to a message index: either a message id, or a 1-based index
 * into the genuine user messages (the list the `/fork` picker shows, synthetic `<ctx>`
 * messages excluded). Returns -1 when it matches nothing.
 */
function resolveForkIndex(messages: UIMessage[], raw: string | undefined): number {
  if (!raw) return -1;
  if (/^\d+$/.test(raw)) {
    const nth = Number(raw);
    if (nth < 1) return -1;
    let seen = 0;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role === "user" && !isContextUIMessage(message)) {
        seen += 1;
        if (seen === nth) return i;
      }
    }
    return -1;
  }
  return messages.findIndex((message) => message.id === raw);
}

/**
 * Clone (`mode: "clone"`) or fork (`mode: "fork"`) the current session into a new one
 * and switch to it. `/clone` copies the whole transcript; `/fork` copies the messages
 * strictly before the chosen user message and returns that message's text for the caller
 * to put back in the editor. The fork point is selected by message id, or by a 1-based
 * index into the session's (genuine) user messages. The source session is left untouched.
 *
 * Refused while a run is active (the channel would be a half-finished turn). The new
 * session is written to disk and then adopted through {@link ManagedAgent.restoreSession},
 * the same switch path as `session.resume`.
 */
export async function branchSession(
  managed: ManagedAgent,
  options: { mode: "clone" | "fork"; upToMessageId?: string; name?: string }
): Promise<
  | { ok: true; sessionId: string; name: string; model: string; uiMessages: UIMessage[]; forkText?: string }
  | { ok: false; error: string }
> {
  const store = managed.getSessionStore();
  const current = managed.getSessionData();
  if (!store || !current) {
    return { ok: false, error: "No active session" };
  }

  if (managed.isSessionSwitching?.()) {
    return { ok: false, error: `Session is switching — try again when it finishes.` };
  }

  if (managed.getChatController()?.isRunActive?.()) {
    return { ok: false, error: `Cannot ${options.mode} while the agent is running — stop it first (Esc).` };
  }

  // A queued persist still targets the source session. Drain it before branching so the
  // new session cannot observe or race a late source write.
  await managed.session.awaitPersistIdle();

  // Branch from the live channel so unsaved turns are included. Dehydrate first: the
  // channel holds hydrated media (inline base64 / data URLs), but the session log
  // stores `media://` refs — writing it raw would bake base64 into the append-only log
  // and leave it there forever (later saves only append). The canonical persist path
  // (`SessionService.persistSession`) dehydrates for exactly this reason.
  const liveMessages = (managed.getUI()?.getMessages() ?? current.uiMessages) as UIMessage[];
  const messages = (await dehydrateUIMessages(liveMessages, { env: store.getEnv() })) as UIMessage[];

  let upToIndex: number | undefined;
  let forkText: string | undefined;
  if (options.mode === "fork") {
    const index = resolveForkIndex(messages, options.upToMessageId?.trim());
    if (index <= 0) {
      return { ok: false, error: "Fork point must be an earlier user message with messages before it" };
    }
    // The picker only offers user messages, but a hand-typed id (or an out-of-range
    // index) could name an assistant/tool message — reject it rather than forking there.
    if (messages[index]?.role !== "user" || isContextUIMessage(messages[index]!)) {
      return { ok: false, error: "Fork point must be a user message" };
    }
    upToIndex = index;
    forkText = uiMessageText(messages[index]!);
  }

  const newSession = store.branchFrom(current, {
    ...(upToIndex !== undefined ? { upToIndex } : {}),
    ...(options.name ? { name: options.name } : {}),
    messages: messages as never,
  });

  await store.save(newSession);
  // `restoreSession` acquires the new id and releases the session being left only after a
  // successful restore, so a branch needs no compensating release here.
  const restored = await managed.restoreSession(newSession.id);

  return {
    ok: true,
    sessionId: newSession.id,
    name: restored.name,
    model: restored.model,
    uiMessages: restored.uiMessages,
    ...(forkText ? { forkText } : {}),
  };
}
