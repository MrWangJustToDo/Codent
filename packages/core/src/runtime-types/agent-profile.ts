/**
 * Shared agent-kind / UI-projection vocabulary.
 *
 * This is deliberately just ids and unions: there is no profile object or execution layer to
 * import. Toolset selection and log/task attribution share these names directly.
 */

/** Every agent run is one of these profiles. */
export const AGENT_PROFILE_IDS = ["root", "general", "explore", "internal"] as const;
export type AgentProfileId = (typeof AGENT_PROFILE_IDS)[number];

/** Toolset families the manager-side factory can assemble. */
export type AgentToolsetProfile = AgentProfileId;
