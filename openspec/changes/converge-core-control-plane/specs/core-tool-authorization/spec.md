## ADDED Requirements

### Requirement: One authorization pipeline produces every tool decision

Whether a tool call may run SHALL be decided by one `authorizeToolCall()` pipeline with a fixed stage order: availability → hard policy → auto modes → declarative approval requirement → command analysis → extension hooks → persisted decision. Each stage SHALL receive the same `AgentPolicyFacts` snapshot and SHALL return `allow`, `ask` or `deny` with a reason and a source. No other module SHALL independently decide that a call is allowed or needs approval.

#### Scenario: Single decision

- **WHEN** a tool call reaches the execution boundary
- **THEN** exactly one `authorizeToolCall()` result decides its outcome, and no second gate re-evaluates the same question

#### Scenario: Stage precedence

- **WHEN** one stage denies and a later stage would allow
- **THEN** the earlier stage's deny wins and is recorded as the decision source

#### Scenario: Auto mode does not bypass hard denies

- **WHEN** auto mode or plan execution is active and the call violates a hard policy (subagent external path, env override, destructive rule)
- **THEN** the pipeline still denies instead of auto-approving

### Requirement: One decision record with a source

Every tool-call decision SHALL be recorded once with `{ action, source, reason? }`, where `source` names the stage that produced it (availability, policy, auto, declarative, command-analysis, extension, persisted). The session approval table SHALL be the source of truth; the transcript tool part and the persisted JSONL entry SHALL be projections of that record. A decision event SHALL carry the same `source`.

#### Scenario: Deny from an extension hook

- **WHEN** a `tool:before:*` interceptor sets `event.skip`
- **THEN** the decision is `deny` with source `extension`, and the transcript row and log entry both identify that source

#### Scenario: Approval required

- **WHEN** a call requires approval
- **THEN** exactly one `pending` record exists, and the UI interaction and resume map are derived from it rather than adding a second record

### Requirement: Availability and approval share one policy

Tool availability (plan mode's hidden/available sets, subagent profile restrictions, code-mode exclusions) SHALL be expressed in the same `AgentPolicyFacts` that drives approval. The tool list offered to the model SHALL be a projection of that policy; the execution gate SHALL read the same facts. A tool that is unavailable MUST NOT be offered as merely "needs approval".

#### Scenario: Plan mode hides an edits tool

- **WHEN** plan mode is active and a mutating tool is not available
- **THEN** the tool is absent from the model's tool list and the pipeline denies it if called anyway, both from the same facts

#### Scenario: Subagent restriction

- **WHEN** a subagent attempts a command that the subagent profile forbids
- **THEN** the pipeline denies it regardless of annotations, rules or auto mode

### Requirement: Declarative requirement is read from the registry

A tool's approval requirement SHALL be a single descriptor on its registered definition, composed from its static declaration and any MCP server annotations. Call sites SHALL NOT read a raw `needsApproval` flag to decide policy; the pipeline SHALL read the descriptor. Missing annotations SHALL be treated as "requires approval" (fail closed).

#### Scenario: MCP annotation

- **WHEN** an MCP tool is registered with `readOnlyHint: true`
- **THEN** its descriptor marks it free to run, and the pipeline allows it without a prompt

#### Scenario: No annotation

- **WHEN** an MCP tool has no annotations and no per-server override
- **THEN** its descriptor requires approval and the call prompts

### Requirement: Answered decisions are the only resumable ones

The pipeline's pending decision SHALL be resumable only after a recorded answer. An unanswered call SHALL keep interrupting; an answered call SHALL execute exactly once without re-prompting. A terminal turn with an unanswered client question SHALL project a waiting state rather than a contradictory terminal state.

#### Scenario: Pending still interrupts

- **WHEN** a session is restored with a pending approval record
- **THEN** the call is omitted from the resume map and the run waits

#### Scenario: Answered executes once

- **WHEN** an approval is recorded as approved
- **THEN** the call executes once on resume and no further prompt is produced for that call
