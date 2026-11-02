/**
 * Primitives shared by more than one payload family.
 *
 * Kept out of the family files so no two families import each other, and re-exported by the
 * aggregate (`agent-event-payloads.ts`) so `from "./runtime-types/agent-event-payloads.js"` remains
 * the one import site for consumers.
 */

/** Explicit empty object for events with no fields. */
export type EmptyAgentEventPayload = Record<string, never>;

export type PlanPhase = "off" | "planning" | "ready" | "executing" | "retro";

/**
 * Why the active session changed (`/resume`, `/fork`, `/clone`).
 *
 * A closed union because "how did we get here" is the question the row exists to answer, and it used
 * to be hardcoded to `resume` for all three — a forked session claimed to be a resumed one.
 */
export type SessionSwitchReason = "resume" | "fork" | "clone";

/**
 * Subsystem a {@link SessionDiagnosticArea} note came from.
 *
 * A closed list, not a free string: the area decides the log category, so an unlisted area would
 * silently bucket into `system`. Adding a subsystem is a one-word edit here.
 */
export type SessionDiagnosticArea =
  | "doc"
  | "skill"
  | "memory"
  | "extension"
  | "middleware"
  | "capability"
  | "stream"
  | "context"
  | "session"
  | "jobs"
  | "model"
  | "tool"
  | "compaction";

/**
 * Who answered a tool approval.
 *
 * The log needs this to separate a human decision from machinery: the same `resolved` row shape is
 * produced by a y/n answer, by auto/plan mode, and by the command-safety policy.
 */
export type ToolApprovalSource = "user" | "auto" | "policy";

/** The mode field that changed (see `mode:change`). */
export type ModeChangeField = "auto" | "effort";
