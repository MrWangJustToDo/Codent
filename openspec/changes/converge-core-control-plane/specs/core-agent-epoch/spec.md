## ADDED Requirements

### Requirement: Async continuations capture one epoch

Any operation that crosses an `await` and may later write observable state (session persistence, usage/cost totals, title generation, memory extraction, background-completion wake, subagent usage/part write-back, tool-result injection) SHALL capture an `Epoch` before its first await and MUST verify the appropriate predicate immediately before the write. An `Epoch` SHALL combine the current session generation, the current run token and the current lifecycle generation; there SHALL NOT be a second ad-hoc "is the session still the same?" check for such a write.

The predicates SHALL match the contract they replace: `isCurrent()` asks only whether the captured session generation is still live (a switch is ADMITTED before it stops the run, and the run being stopped still owns its terminal write); `isStable()` additionally requires that no switch is in flight (for work that must not be written into either transcript); `isRunCurrent()` additionally requires the captured run token and lifecycle generation to be current (for a writer that must not outlive its run).

#### Scenario: Session switch during a side query

- **WHEN** a title or memory side query is in flight and the user runs `/new` or `/resume`
- **THEN** the captured epoch reports not-current after the switch, the query's usage/cost is not added to the new session's tracker, and no state write targets the new session

#### Scenario: Superseded run writes late

- **WHEN** a run is interrupted and a new message starts a new pump before the old pump's async callback resolves
- **THEN** the old callback observes a non-current epoch and performs no status, usage, message or persistence write

#### Scenario: Background completion after switch

- **WHEN** a background job or task completes while the session switch transaction is running or after it commits
- **THEN** the completion is delivered only to the session that owns the captured epoch, and an idle wake is not started for the target session

### Requirement: Epoch generations have single sources

The session generation, run token and lifecycle generation used by `Epoch` SHALL each have exactly one producer: the UI channel for session generation, `RunCoordinator` for the run token, and the chat controller for the lifecycle generation. `EpochSource.capture()` SHALL compose them; no module SHALL create an independent counter, timestamp or id to answer the same question.

#### Scenario: Adding a new generation is a compile-time decision

- **WHEN** a new async path needs currency
- **THEN** it takes an `Epoch` from `EpochSource`, and the source guard reports an error if the path introduces a new local counter or session-id snapshot

#### Scenario: Generations agree across producers

- **WHEN** a session is restored or a new session is adopted
- **THEN** the UI channel's session generation advances and every previously captured epoch becomes non-current without any consumer needing to compare session ids

### Requirement: No ad-hoc session-snapshot guards for writes

Code SHALL NOT decide whether to write by comparing `getSessionData()?.id` against a previously captured id (`sessionIdAtStart`, `stillOnStartSession`, `stillOnSession`) or by calling `isSessionSwitching()` in an async callback. Those checks SHALL be expressed as `epoch.isCurrent()`. `isSessionSwitching()` MAY remain for admission decisions made synchronously at an API boundary, but MUST NOT guard a post-await write.

#### Scenario: Guard audit

- **WHEN** core is searched for `sessionIdAtStart`, `stillOnStartSession` or `stillOnSession` outside the Epoch module
- **THEN** no matches remain, and the control-plane writer gate fails if one is reintroduced

#### Scenario: Equivalent decisions

- **WHEN** the old guard and the epoch are evaluated on the same scenario matrix (switch before query, during query, after commit, failed restore)
- **THEN** both produce the same allow/deny decision, so adoption is behavior-preserving
