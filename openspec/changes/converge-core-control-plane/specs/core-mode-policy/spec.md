## ADDED Requirements

### Requirement: One read API for plan and auto mode

Plan and auto mode SHALL be read through a single `ModeState` surface (`planPhase`, `auto`, `approvalPolicy(tool)`, `toolAvailability()`), owned by the mode domain. Code outside the mode domain SHALL NOT read `planMode.*` or call `isAutoModeEnabled()` directly; turn context, persistence, tools, authorization and status SHALL consume `ModeState` or policy facts derived from it.

#### Scenario: Turn context reads mode facts

- **WHEN** the per-turn context is built
- **THEN** it reads the mode snapshot from `ModeState` rather than inspecting controllers

#### Scenario: Direct reads are rejected

- **WHEN** a module outside `agent/mode/` calls `planMode.getPhase()` or `isAutoModeEnabled()`
- **THEN** the mode read gate fails with the offending file

### Requirement: Plan-execution auto-approval is a policy fact

Whether tools are auto-approved during plan execution SHALL be expressed as `todosSeeded` (and the plan phase) inside `AgentPolicyFacts`, computed once per decision. It SHALL NOT be re-derived from multiple ad-hoc flags in the approval path. Entering or leaving a plan phase SHALL update `ModeState`, and the authorization pipeline SHALL observe the change on the next decision.

#### Scenario: Executing with seeded todos

- **WHEN** the plan phase is `executing` and todos were seeded
- **THEN** the authorization pipeline auto-approves eligible tools from `AgentPolicyFacts`

#### Scenario: Review phase

- **WHEN** the plan phase is `ready`
- **THEN** no plan-execution auto-approval applies, even if a previous executing phase seeded todos

### Requirement: Mutual exclusivity is preserved at the mode boundary

Plan mode and auto mode SHALL remain mutually exclusive. A mode transition SHALL update `ModeState`, persistence and the projection atomically; entering one mode SHALL clear the other. Consumers SHALL observe a single persisted mode snapshot.

#### Scenario: Enter plan from auto

- **WHEN** auto mode is on and the user enters plan mode
- **THEN** `ModeState.auto` is false, the persisted session records plan-only state, and the next authorization decision uses plan facts

#### Scenario: Restore

- **WHEN** a session is restored with both flags set by an older build
- **THEN** plan wins, `ModeState` reports plan-only, and the persisted record is corrected

### Requirement: Tool availability is a mode projection

The tool list offered to the model SHALL be derived from `ModeState.toolAvailability()` and the same policy facts used by authorization. Adding a mode-specific restriction SHALL require one edit in the mode policy, not a separate filter in the runner.

#### Scenario: Retro hides plan authoring tools

- **WHEN** the plan phase is `retro`
- **THEN** the offered tool list excludes plan-authoring tools, and a direct call to one is denied by the pipeline
