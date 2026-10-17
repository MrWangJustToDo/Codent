/**
 * The session double the ACP validators build on.
 *
 * Extracted so a second script (the live-turn check) uses the SAME snapshot shape: a mock that
 * drifts from production's is how a validator quietly stops testing anything — see the comment it
 * carries about the agent id vs the disk id.
 */

export function baseSnapshot(id, overrides = {}) {
  return {
    agentId: id,
    name: id,
    // A root session ALWAYS has a disk session id in production (`host.create` mints one via
    // `ensureSessionData()`), and the ACP layer keys everything on it — so the default test
    // double carries one too. Sessions that need it to differ from the agent id pass both.
    activeSessionId: `ses_${id}`,
    status: "idle",
    error: "",
    pendingApprovalCount: 0,
    mode: "normal",
    lastStreamDurationMs: 0,
    messages: [],
    queues: { steer: [], followUp: [] },
    usage: {
      contextFillTokens: 0,
      tokenLimit: 200000,
      percent: 0,
      cost: 0,
      llmDurationMs: 0,
      llmOutputTokens: 0,
      total: {},
      window: {},
      billedInputTokens: 0,
    },
    todos: [],
    todosTitle: null,
    plan: {
      phase: "off",
      planMarkdown: null,
      steps: [],
      enabledAt: null,
      todosSeeded: false,
      preservedExistingTodos: false,
      planFilePath: null,
    },
    autoMode: false,
    mcp: { servers: [] },
    extensions: { extensions: [] },
    toolDescriptors: [],
    interactions: { approvals: [], askUser: [] },
    iteration: { current: 1, max: 100 },
    subagents: [],
    ...overrides,
  };
}
