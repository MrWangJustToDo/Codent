/**
 * Why a `task` subagent ended, and what its summary says about it.
 *
 * Two terminal classes, kept deliberately disjoint: a run that STOPPED (an abort — user Esc, the
 * parent's run moving on, the parent agent stopping) and one that FAILED (provider fault, context
 * overflow). `isProgressSummaryEligible` treats an output that is only a stop notice as "nothing
 * usable", so a failure notice overlapping one of those would silently change whether the
 * progress-summary fallback fires.
 *
 * A subagent's run can end through several different aborts and the task summary has to
 * be honest about which one it was, because the text reaches both the transcript UI and
 * the parent model's context:
 *
 * | Reason | What happened | Summary notice |
 * |---|---|---|
 * | `user` | the user cancelled (Esc) | `[Task cancelled by user.]` |
 * | `parent-run` | the parent's run moved on: a stream restart / force-submit discarded it, or the `chat()` invocation the subagent was streaming under ended while it streamed — an approval or client-tool wait ends the invocation that way, and the run then continues as a new pump | `[Task stopped with its parent run.]` |
 * | `parent-stop` | the parent agent was aborted or destroyed, taking its children with it | `[Task stopped with its parent agent.]` |
 * | `unknown` | aborted, but nothing recorded why | `[Task cancelled.]` |
 *
 * The reason is read from the abort signal, which is the one channel every path
 * already flows through: `AbortController.abort(reason)` reaches the subagent as
 * `signal.reason`, so the producers are wired at once —
 *
 * - the user stop path passes `"user-cancelled"` (`AgentChatController` / local session
 *   dispatch) and it lands on the parent run's controller,
 * - `abortManagedAgentRun` passes the run-lifecycle reason (the run-lifecycle reset has
 *   none, landing as `"(no reason)"` — the stream restart behind the pre-fork orphan),
 * - `ManagedAgent.cascadeAbortToChildren` → `child.abort(reason ?? "parent-aborted")`,
 *   inheriting the parent's own reason when it has one, and
 * - `AgentManager.destroyAgent` → `abort("Agent destroyed")`.
 *
 * Reading the reason requires care about WHICH signal: the child's own
 * `run.currentAbortController.signal.reason` is where the abort/cascade paths land, while
 * the caller's `abortSignal` only carries it on the pre-fork route. Both are consulted at
 * the call site.
 *
 * `unknown` is reachable in exactly one way: an abort whose string matches nothing here
 * (an unlabelled caller). It is **not** the ".aborted but no reason recorded" slot the
 * table's wording suggests — a bare abort is classified `parent-run`, because that is the
 * lifecycle reset, and claiming "we know nothing" there would lose the distinction the
 * reason exists for. `unknown` is never returned for a non-aborted run: the caller must
 * not ask for a notice in that case at all.
 *
 * **Before this, every abort was reported as `[Task cancelled by user.]`** — the
 * constant was applied unconditionally. An orphan created by a stream restart was
 * therefore recorded as a user cancellation that never happened, in the log and in the
 * parent model's context, which is the single most expensive way this can be wrong:
 * the one artefact a reader uses to tell "the model stopped this" from "the operator
 * stopped this" asserted the wrong one.
 */

/** Raw abort reason as it travels on the signal. */
export interface SubagentAbortReason {
  /** The abort reason when it was a string (e.g. `user-cancelled`, `parent-aborted`). */
  reason?: unknown;
  /** Whether the subagent's own run was aborted at all. */
  aborted: boolean;
}

/**
 * Reason strings the producers actually emit, as a list the classifier is checked against.
 *
 * Kept as data (not just an `if` chain) because the failure mode here is a string that
 * *looks* handled but never matches: `"Agent destroyed"` (the destroy path, and by far the
 * most common abort in real logs — 171 vs 29) was classified against `"agent-destroyed"`,
 * which no producer emits, so the majority case silently fell through.
 */
export const SUBAGENT_ABORT_REASONS = {
  /** `Esc` / a host's user stop — the only reason that means "the operator did this". */
  userCancelled: "user-cancelled",
  /** `ManagedAgent.cascadeAbortToChildren` when the parent has no reason of its own. */
  parentAborted: "parent-aborted",
  /** `AgentManager.destroyAgent` — the session/host tearing the agent down. */
  agentDestroyed: "Agent destroyed",
  /**
   * `AgentChatController.forceSubmit` — Option/Ctrl+Enter, replacing the in-flight turn.
   *
   * A user gesture, but NOT a user cancel: the run is discarded and a new one starts
   * immediately, so it classifies as `parent-run` ("stopped with its parent run") rather
   * than `user` ("cancelled by user"). It is listed here so that outcome is a stated
   * decision rather than an unhandled string — which is the entire lesson of
   * `agentDestroyed` above.
   */
  forceSubmit: "force-submit",
} as const;

/**
 * Every reason that deliberately falls through to `parent-run`.
 *
 * The classifier's fallback exists for caller labels it does not recognize, and for these
 * that fallback is the *intended* answer, not a gap. Kept separate from
 * {@link SUBAGENT_ABORT_REASONS} so a reader (and the validator) can tell "handled" from
 * "handled by accident": a reason in this list has a stated verdict, and anything neither
 * classified nor listed here is the drift the `agentDestroyed` bug was.
 */
export const SUBAGENT_RUN_RESTART_REASONS: readonly string[] = [SUBAGENT_ABORT_REASONS.forceSubmit];

export type SubagentStopReason = "user" | "parent-run" | "parent-stop" | "unknown";

/** Every stop reason, in a runtime list — the payload/tool schemas derive their enum from it. */
export const SUBAGENT_STOP_REASONS: readonly SubagentStopReason[] = ["user", "parent-run", "parent-stop", "unknown"];

/** Notices, exported so consumers match on them instead of on a copied literal. */
export const SUBAGENT_CANCELLED_NOTICE = "[Task cancelled by user.]";
export const SUBAGENT_PARENT_RUN_NOTICE = "[Task stopped with its parent run.]";
export const SUBAGENT_PARENT_STOP_NOTICE = "[Task stopped with its parent agent.]";
export const SUBAGENT_ABORTED_NOTICE = "[Task cancelled.]";

/** Every notice `applySubagentStopNotice` can append — for "already noticed" checks. */
export const SUBAGENT_STOP_NOTICES: readonly string[] = [
  SUBAGENT_CANCELLED_NOTICE,
  SUBAGENT_PARENT_RUN_NOTICE,
  SUBAGENT_PARENT_STOP_NOTICE,
  SUBAGENT_ABORTED_NOTICE,
];

/**
 * Prefix for a FAILED run's summary — the sibling vocabulary to {@link SUBAGENT_STOP_NOTICES},
 * and never one of them (see the module header for what the overlap would break).
 */
export const SUBAGENT_FAILURE_NOTICE_PREFIX = "⚠️ Task failed:";

/**
 * Classify an abort reason.
 *
 * Ordering matters: the parent cascade runs *after* the agent's own stop, so a parent
 * stop whose own run was already aborted passes `"user-cancelled"` down to the child
 * while the parent agent's own stop reason is `"parent-aborted"`. A child aborted by
 * that cascade carries the parent's reason, which is what distinguishes "the parent
 * agent stopped" from "the run restarted" — the two reasons that produce orphans.
 */
export function resolveSubagentStopReason(info: SubagentAbortReason): SubagentStopReason {
  // Not aborted ⇒ no stop to explain. (The caller must not ask for a notice in this case —
  // a finished run's summary is its output, verbatim.)
  if (!info.aborted) return "unknown";
  const reason = typeof info.reason === "string" ? info.reason : "";
  if (reason === SUBAGENT_ABORT_REASONS.userCancelled) return "user";
  if (reason === SUBAGENT_ABORT_REASONS.parentAborted) return "parent-stop";
  // Case-insensitive on the destroy label so the spelling the producer chose ("Agent
  // destroyed") cannot drift away from the classifier again.
  if (/agent[\s_-]?destroyed/i.test(reason)) return "parent-stop";
  // A bare `abort()` is the run-lifecycle reset/restart path, which is where the
  // pre-fork orphan comes from. Any *other* string is a caller's own label; it is not
  // strong enough to claim the user did it, but it is stronger than "we know nothing",
  // so it reads as "the parent's run moved on" rather than "unknown". Reasons that are
  // SUPPOSED to land here (e.g. `force-submit`) are listed in
  // `SUBAGENT_RUN_RESTART_REASONS` and asserted against this return.
  return "parent-run";
}

/** The notice that belongs to a stop reason. */
export function subagentStopNotice(reason: SubagentStopReason): string {
  switch (reason) {
    case "user":
      return SUBAGENT_CANCELLED_NOTICE;
    case "parent-run":
      return SUBAGENT_PARENT_RUN_NOTICE;
    case "parent-stop":
      return SUBAGENT_PARENT_STOP_NOTICE;
    default:
      return SUBAGENT_ABORTED_NOTICE;
  }
}

/** The sentinel `extractAssistantText` yields for a run that produced no final answer. */
const EMPTY_SUMMARY = "(no summary)";

/**
 * Ensure a stopped run surfaces a clear notice in the summary text returned to the parent (UI +
 * `toModelOutput`), not only an `aborted` flag.
 *
 * The notice names the *reason* instead of assuming the user did it, so a run the parent restarted
 * is not recorded as a cancellation nobody made.
 */
export function applySubagentStopNotice(summary: string, reason: SubagentStopReason): string {
  const noticed = subagentStopNotice(reason);
  const trimmed = summary.trim();
  if (!trimmed || trimmed === EMPTY_SUMMARY) {
    return noticed;
  }
  // Any stop notice already in the text is the same class of message; do not stack them.
  if (SUBAGENT_STOP_NOTICES.some((notice) => trimmed.includes(notice))) return summary;
  return `${trimmed}\n\n${noticed}`;
}

/**
 * Prefix a FAILED run's summary with the fault, keeping whatever partial work exists.
 *
 * The sibling of {@link applySubagentStopNotice}: a stop names *who* ended the run, a failure names
 * *why* it died. Both exist because the text reaches the parent model's context, so it must not be
 * mistakable for a finished result — which matters most when the partial work is ordinary narration
 * ("let me check…"), where the prefix is the only thing that stops it reading as a conclusion.
 */
export function applySubagentFailureNotice(summary: string, errorMessage?: string): string {
  const notice = `${SUBAGENT_FAILURE_NOTICE_PREFIX} ${errorMessage ?? "unknown error"}`;
  const trimmed = summary.trim();
  if (!trimmed || trimmed === EMPTY_SUMMARY) return notice;
  return `${notice}\n\n${trimmed}`;
}
