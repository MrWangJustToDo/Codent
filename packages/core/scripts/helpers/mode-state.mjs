/**
 * A minimal `ModeState` for validators that only need the read surface.
 *
 * Scripts should not have to construct the real controllers to exercise a consumer: pass this in
 * place of `getModeState()` and override the facts under test.
 */

const EMPTY_PLAN = {
  planMarkdown: null,
  steps: [],
  enabledAt: null,
  preservedExistingTodos: false,
  planFilePath: null,
};

export function fakeModeState({ planPhase = "off", auto = false, todosSeeded = false, plan } = {}) {
  const planState = plan ?? { phase: planPhase, todosSeeded, ...EMPTY_PLAN };
  return {
    snapshot: () => ({ plan: planState, planPhase, auto, todosSeeded }),
    approvalPolicy: () => (auto ? "auto" : "ask"),
    toolAvailability: () => ({ phase: planPhase, restrictsMutations: false, hiddenTools: new Set() }),
  };
}

export function fakePolicyFacts({ profile = "root", isSubagent = false, unavailableTools = [], ...modeInput } = {}) {
  const mode = fakeModeState(modeInput);
  const snapshot = mode.snapshot();
  const availability = mode.toolAvailability();
  return {
    planPhase: snapshot.planPhase,
    auto: snapshot.auto,
    todosSeeded: snapshot.todosSeeded,
    planExecutionAutoApprove:
      (snapshot.planPhase === "executing" || snapshot.planPhase === "retro") && snapshot.todosSeeded,
    toolAvailability: availability,
    profile,
    isSubagent,
    capabilities: null,
    unavailableTools: new Set([...availability.hiddenTools, ...unavailableTools]),
    env: {},
  };
}
