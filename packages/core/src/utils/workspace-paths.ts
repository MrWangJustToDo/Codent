/**
 * Workspace-relative names for the agent's own runtime data.
 *
 * `.agents/` holds sessions, agent logs, media, cache, job logs, memory, plans and config — state
 * the agent produces, never source it should read as code. It is gitignored in every workspace, but
 * a search must not *depend* on that (a non-git workspace has no ignore file), so the name is
 * spelled once here and derived from everywhere: the persistence/media/memory/jobs/config path
 * constants, the search exclusion policy, and the model-facing text that names one of those paths.
 *
 * Lives under `utils/` because every layer owns a piece of that directory — `managers` (skills),
 * `models` (`config/models.json`), `provider` (models.dev cache), `agent` (the rest) — and `utils`
 * is the one layer all of them may import.
 */

/** Runtime data root, relative to the workspace root. */
export const AGENT_DATA_DIR = ".agents";

/** Generated/derived cache root under {@link AGENT_DATA_DIR} (safe to delete). */
export const AGENT_CACHE_DIR = `${AGENT_DATA_DIR}/cache`;
