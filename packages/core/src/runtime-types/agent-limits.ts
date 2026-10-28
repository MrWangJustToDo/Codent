/**
 * Shared agent runtime limit constants.
 *
 * Lives in runtime-types (not managers/) so domain modules (agent/, models/)
 * can import them without violating the `agent→managers` / `models→managers`
 * boundary gates.
 */

/**
 * The ONE agent-loop iteration budget.
 *
 * Every layer reads this number instead of restating it: `AgentConfigSchema`'s default, the
 * session host's fallback, the CLI/app defaults and the help text. A host passes `maxIterations`
 * only when the user actually set one.
 */
export const DEFAULT_AGENT_MAX_ITERATIONS = 50;

/**
 * Hard ceiling for `maxIterations`.
 *
 * Declared once so the schema, the HTTP create contract and the CLI validator agree. A value
 * outside `1..MAX_AGENT_ITERATIONS` is rejected (with the bound in the message), never clamped.
 */
export const MAX_AGENT_ITERATIONS = 100;
