/**
 * Session-retrieval guidance: where past conversation lives and how to read it.
 *
 * This is the **single source of truth** for how to search conversation history. It used to be
 * spread across the compaction summary, the compact-archive file header, `AGENTS.md`, and
 * `ARCHITECTURE.md` — two of which were frozen or near-frozen, so a wording change reached only
 * some of them. The guidance therefore lives here only.
 *
 * Discovery is deliberately **static text behind a one-time existence gate**: no counts and no
 * per-turn directory walks. A count would change the section hash whenever a session was created
 * or pruned, re-injecting the whole block and invalidating the prompt-cache prefix after it — for
 * a figure that does not change what the model should do.
 */

import { getEnv, type ResolvedCoreEnv } from "../../env";
import { SESSION_DIR, SESSION_LOG_SUFFIX } from "../persistence/types.js";

import { TURN_CONTEXT_KINDS, type TurnContextKind } from "./turn-context-message.js";

/** Semantic tag for the retrieval section. */
export const SESSION_RETRIEVAL_OPEN = "<session_retrieval>";
export const SESSION_RETRIEVAL_CLOSE = "</session_retrieval>";

/**
 * Section kind for the retrieval section.
 *
 * Typed against the shared catalog so a rename that misses one site fails to
 * compile instead of silently splitting the kind into two independently-admitted
 * ones.
 */
export const SESSION_RETRIEVAL_KIND: TurnContextKind = TURN_CONTEXT_KINDS.sessionRetrieval;

/** Rendered retrieval section, or the empty string when there is no history. */
export type SessionRetrievalSection = string;

/**
 * Whether this workspace has any conversation history at all.
 *
 * Evaluated once per agent, not per turn. A workspace with nothing on disk (a
 * fresh clone, a project that never ran an agent) gets no section rather than
 * guidance pointing at a directory that does not exist.
 */
export async function hasSessionHistory(
  env?: ResolvedCoreEnv,
  options?: {
    /**
     * The live session, which is NOT history: `session_search` excludes it by default (its content is
     * the conversation already in context), so counting its file advertised retrieval for a
     * conversation that had nothing else to find — every workspace's first session, and every resume.
     */
    excludeSessionId?: string;
  }
): Promise<boolean> {
  const resolvedEnv = env ?? getEnv();

  try {
    const sessionsDir = resolvedEnv.path.join(resolvedEnv.rootPath, SESSION_DIR);
    if (!(await resolvedEnv.fs.exists(sessionsDir))) return false;
    const entries = await resolvedEnv.fs.readdir(sessionsDir);
    const excluded = options?.excludeSessionId ? `${options.excludeSessionId}.session.jsonl` : undefined;
    return entries.some((entry) => entry.name !== excluded);
  } catch {
    return false;
  }
}

/**
 * The constant guidance body.
 *
 * Exposed so the drift guard can assert the single source of truth directly, and so the section
 * renderer and any future consumer share one definition rather than re-describing the file shape.
 */
export function renderStaticRetrievalBody(): string {
  return [
    "Past conversations with this workspace are on disk as complete session logs. Search them " +
      "when the task depends on something discussed in an earlier session — a decision, a reason, " +
      "or a detail no longer in this context.",
    "",
    "Use the `session_search` tool to find matches by text, and `session_read` to read a session " +
      `in full. Each log at \`${SESSION_DIR}/<id>${SESSION_LOG_SUFFIX}\` holds the whole ` +
      "conversation (one message per line).",
    "",
    "Your context only shows messages since the last summary, so this session's own earlier turns " +
      "are not visible. To reach them, call `session_search` with `sessionId` set to the id in the " +
      "`<session_id>` context block; by default `session_search` covers other sessions only.",
  ].join("\n");
}

/**
 * Render the `<session_retrieval>` section.
 *
 * Returns `undefined` when the workspace has no history, so the section is absent
 * rather than empty. The body is **entirely static** — no counts, no paths — so a
 * single admission settles the section for the session.
 */
export function formatSessionRetrievalSection(options: { hasHistory: boolean }): SessionRetrievalSection | undefined {
  if (!options.hasHistory) return undefined;

  return [SESSION_RETRIEVAL_OPEN, renderStaticRetrievalBody(), SESSION_RETRIEVAL_CLOSE].join("\n");
}
