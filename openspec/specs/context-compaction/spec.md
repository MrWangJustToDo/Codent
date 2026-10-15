# context-compaction Specification

## Purpose

Context compaction: how the token budget is measured, when compaction triggers and how segments are chosen, what the summary preserves, and how the compacted view is projected back onto the wire.

## Requirements
### Requirement: Token-budget keep window

The system SHALL determine the compaction keep window by accumulated estimated token budget (`keepRecentTokens`) instead of a fixed count of user turns. When `keepRecentTokens` is not explicitly configured and the model's context window is known, the system SHALL derive it from the context window (a bounded fraction). When no context window is known, the system SHALL derive it from the shared default window (`DEFAULT_SUMMARIZATION_CONTEXT_WINDOW`) so the keep policy is always token-budget based — legacy `keepRecentFlows` turn counting is removed.

#### Scenario: Single turn fills the context window

- **WHEN** the kept window is dominated by few (but large) real user turns and the latest turn exceeds the keep token budget
- **THEN** auto-compaction SHALL still find a cut point inside that turn and produce a summary instead of bailing out with `compacted: false`

#### Scenario: Context window unknown

- **WHEN** the model has no known context window and no explicit `keepRecentTokens` is configured
- **THEN** the system SHALL derive the keep budget from the shared default window (`DEFAULT_SUMMARIZATION_CONTEXT_WINDOW`) — never legacy turn counting — so a few-but-large-turn conversation can still be cut

#### Scenario: Derived from model window

- **WHEN** the model reports a context window of 128k tokens and no explicit `keepRecentTokens` is configured
- **THEN** the derived keep budget SHALL be a bounded fraction of that window (not an absolute constant), scaling down for smaller windows

### Requirement: Pairing-safe cut points

The cut-point selection SHALL never place a cut such that a tool result (`role: "tool"`) is kept while its tool call falls into the summarized region, or vice versa. Valid cut points are user or assistant message boundaries; in-chain compaction summaries and synthetic `<turn_context>` messages remain excluded from cut counting.

#### Scenario: Cut candidate lands on a tool result

- **WHEN** the backward token walk reaches the budget at a `role: "tool"` message
- **THEN** the cut point SHALL move to the nearest valid non-tool boundary such that tool call and result stay on the same side

#### Scenario: Wire contains only paired tools after split-turn compact

- **WHEN** compaction cuts inside a turn
- **THEN** every `toolCallId` present on the projected wire SHALL have its call and result both within the kept region

### Requirement: Split-turn compaction with turn-prefix summary

When the chosen cut point falls inside a turn (not at the turn's user message), the system SHALL identify the turn start, summarize the discarded turn prefix separately (original request, early progress, context needed by the kept suffix), merge it into the appended SUMMARY checkpoint, and keep the suffix intact on the wire. The summarizer input SHALL label segments distinctly: pre-history to compress, split-turn prefix, and still-in-context suffix.

#### Scenario: Mid-turn cut produces merged summary

- **WHEN** auto-compaction cuts inside the latest turn
- **THEN** the appended SUMMARY SHALL contain both the history summary and a turn-context section covering the discarded prefix, and the kept suffix messages SHALL remain unchanged on the wire

#### Scenario: Oversized single turn input

- **WHEN** the combined summarizer input for one turn exceeds the summarization input budget
- **THEN** the system SHALL batch the input via the existing token-budget splitting and merge partial summaries

### Requirement: Deterministic wire projection consistency

Wire recovery SHALL re-derive the kept window using the same deterministic cut function and the same compaction configuration used at compact time, applied to the frozen pre-summary slice of the chronological channel. Repeated projections over unchanged channel content SHALL yield identical wire output.

#### Scenario: Repeated LLM calls between compactions

- **WHEN** multiple LLM calls occur without any new SUMMARY checkpoint or channel mutation before the latest summary
- **THEN** the projected wire SHALL be byte-identical across those calls

#### Scenario: Session resume after compaction

- **WHEN** a session with an in-chain SUMMARY checkpoint is resumed
- **THEN** the restored wire SHALL match the pre-resume projection without requiring stored cut indices

### Requirement: Window-relative auto-compact trigger

When real usage tokens and the model context window are available, auto-compaction SHALL trigger based on usage against `contextWindow - reserveTokens` scaled by `compactAtPercent`, rather than the absolute default `tokenThreshold`. The absolute threshold remains the fallback when usage or the window is unknown.

#### Scenario: Small-window model approaches limit

- **WHEN** a model with a 32k window reaches ~80% of `(window - reserveTokens)` used tokens mid-run
- **THEN** auto-compaction SHALL trigger even though absolute default `tokenThreshold` (100k) was never reached

### Requirement: Reactive compaction tail respects token budget

Reactive (emergency) compaction SHALL select its retained tail by token budget using the same pairing-safe boundary rules as auto-compaction, replacing the fixed message-count tail.

#### Scenario: Emergency compact with huge trailing messages

- **WHEN** reactive compaction runs on a conversation whose last few messages alone exceed the keep budget
- **THEN** the retained tail SHALL be reduced to fit the budget without splitting any tool pair, and the session SHALL be retryable instead of repeatedly failing with a context-overflow error

