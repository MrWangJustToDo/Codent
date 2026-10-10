# session-search Specification

## Purpose
TBD - created by archiving change add-session-search. Update Purpose after archive.
## Requirements
### Requirement: The agent can search past conversation

The system SHALL provide a `session_search` server tool that searches past conversation in the
session logs — the complete, authoritative record — and returns bounded, readable matches. Each
match MUST identify the originating session, the message role and time when known, a text snippet,
the message index, and the match's **surface** relative to that session's own latest compaction
summary: `current` (still in that session's model context) or `shadowed` (compacted out of context,
present only in the log). The tool SHALL accept an optional time window (`since` / `until`) and
filter matches by message timestamp.

The session log is the only search source: compaction appends a summary checkpoint to the channel
without removing the pre-cut messages, and the session is persisted from that channel, so the log
holds the whole conversation. The derived `compact-<N>.md` archives MUST NOT be searched — they are
a lower-fidelity duplicate of content already in the log.

#### Scenario: A query matches messages in a session

- **WHEN** `session_search` runs with a text query
- **THEN** results identify the matching session, the message role, the message index, and a text snippet

#### Scenario: A match is parsed, not raw JSON

- **WHEN** a match is found in a `.session.jsonl` line
- **THEN** the reported match carries the session id, the message role, and a text snippet extracted
  from the message parts — never the raw JSON line

#### Scenario: Match surface is reported

- **WHEN** a session has compacted and `session_search` returns a match from before its latest
  summary alongside one from after it
- **THEN** the earlier match is `shadowed` and the later is `current`

#### Scenario: A session that never compacted is all-current

- **WHEN** `session_search` returns matches from a session with no compaction summary
- **THEN** every match is `current`

#### Scenario: A time window narrows results

- **WHEN** `session_search` is given `since` or `until`
- **THEN** only messages whose timestamp falls in the inclusive window are returned

#### Scenario: Compact archives are not a search source

- **WHEN** a token appears only in a `compact-<N>.md` archive and not in any session log
- **THEN** `session_search` does not return it

#### Scenario: Results are bounded

- **WHEN** a query matches more lines than the requested limit
- **THEN** the tool returns at most the limit and states how many matches were withheld, so the
  result cannot overflow the model context

#### Scenario: The current session is excluded by default

- **WHEN** `session_search` runs without an explicit `sessionId`
- **THEN** the current session's files are excluded, because its content is already the live
  conversation

#### Scenario: An explicit session id overrides the exclusion

- **WHEN** `session_search` runs with `sessionId` set to the current session
- **THEN** the current session is searched like any other

#### Scenario: Role filtering

- **WHEN** `session_search` is given a `role`
- **THEN** only messages of that role are returned

#### Scenario: No history

- **WHEN** the workspace has no session logs
- **THEN** the tool returns an empty result, not an error

### Requirement: The agent can read one session as text

The system SHALL provide a `session_read` server tool that renders one session's messages as readable
text, paginated so the model can walk a long conversation without loading all of it at once. Each
message MUST carry its `surface` (`current` / `shadowed`, relative to that session's latest
compaction summary). This is the read path the append-only JSONL log otherwise lacks, and its output
MUST be bounded — per message and per page — spilling to the tool-output cache when a page is large.

#### Scenario: Read a session

- **WHEN** `session_read` runs with a known session id
- **THEN** it returns that session's messages in order, each rendered with its role, text (tool
  calls summarized), and surface, bounded to the requested window

#### Scenario: Pagination

- **WHEN** a session has more messages than the requested window
- **THEN** the result states that more messages remain and how to request the next window

#### Scenario: A large page is bounded and spilled

- **WHEN** the requested window would exceed the content ceiling
- **THEN** messages are truncated individually, the page stops at the ceiling, and the rendered text
  is written to the tool-output cache with a bounded preview and a `cachedOutputPath`

#### Scenario: Unknown session

- **WHEN** `session_read` is given a session id with no log on disk
- **THEN** it fails with a clear error naming the missing session

### Requirement: Session retrieval tools are read-only and root-only

The `session_search` and `session_read` tools SHALL be read-only, and SHALL be registered for the
root agent only. Exploration subagents MUST NOT receive them, consistent with the rule that
cross-session recall is a root-agent decision.

#### Scenario: Subagent tool set

- **WHEN** a subagent's tool set is assembled
- **THEN** neither `session_search` nor `session_read` is present

#### Scenario: No writes

- **WHEN** either tool runs
- **THEN** it performs no filesystem write outside the tool-output cache and mutates no session state

### Requirement: Retrieval reads only the existing session-log format

The tools SHALL read the session logs that already exist, through `CoreEnv`, and SHALL NOT introduce
a new storage format, event-sourced log, or native dependency — so they work unchanged in local and
remote (`@codent/server`) hosts.

#### Scenario: Remote host

- **WHEN** the tools run against a remote `CoreEnv`
- **THEN** they succeed using the filesystem operations available through that environment

#### Scenario: Format constants are shared

- **WHEN** the session log location or suffix changes
- **THEN** the tools follow it through the persistence module's constants rather than a private copy

