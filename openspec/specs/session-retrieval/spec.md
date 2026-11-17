# session-retrieval Specification

## Purpose

Define what the agent is told about reaching past conversations: that earlier sessions exist on disk in ONE authoritative shape (`.agents/sessions/<id>.session.jsonl`, the complete conversation), how it is read, and where that guidance lives. It is the single owner of usage guidance — compaction only appends a summary and never drops messages, so this stays one place that is always current and never needs revising for artifacts already written. (The former `.agents/transcripts/<id>/compact-<N>.md` archive is removed; a `Compact archives MUST NOT be searched` requirement remains as a regression guard.)
## Requirements
### Requirement: Retrieval guidance has a single home

The system SHALL state how to search past conversation in exactly one place — a turn-context section — and SHALL NOT also state it in the compaction summary or in shipped project instructions.

#### Scenario: Guidance is emitted as its own section

- **WHEN** a session runs in a workspace that has conversation history
- **THEN** the dynamic turn context includes a `session_retrieval` section, injected like any other turn-context kind

#### Scenario: Other sites carry no usage guidance

- **WHEN** a compaction summary is produced
- **THEN** it contains no instructions for searching past conversation

### Requirement: Guidance is emitted only when history exists

The system SHALL omit the retrieval section when the workspace has no conversation history, and SHALL NOT probe for history on every turn.

#### Scenario: Fresh workspace

- **WHEN** the workspace has no session logs
- **THEN** no `session_retrieval` section is emitted, and the other turn-context sections are unaffected

#### Scenario: Existence is evaluated once per agent

- **WHEN** the section has been admitted for an agent
- **THEN** it is not recomputed per turn, so creating or removing a session does not change the section's content

#### Scenario: An empty sessions directory is not history

- **WHEN** the sessions directory exists but contains nothing
- **THEN** no section is emitted

### Requirement: Guidance is stable across turns

The section content SHALL NOT vary with volatile or per-session state, so that a single admission settles it and it does not invalidate the prompt cache or re-inject repeatedly.

#### Scenario: No volatile figures

- **WHEN** the section is rendered
- **THEN** it contains no counts, timestamps, or other values that change as sessions are created or pruned

#### Scenario: No per-session content

- **WHEN** another session is created or removed
- **THEN** the rendered section is unchanged, because the section depends only on whether workspace history exists

#### Scenario: Repeated evaluation is byte-identical

- **WHEN** the section is computed twice in the same workspace
- **THEN** both renderings are byte-identical

### Requirement: Subagents do not receive the guidance

The retrieval section SHALL NOT be injected for subagents.

#### Scenario: Subagent turn context

- **WHEN** a subagent assembles its turn context
- **THEN** the `session_retrieval` kind is filtered out, because cross-session recall is a root-agent decision

### Requirement: Guidance states how past conversation is read

The retrieval section SHALL state that past conversations are complete session logs on disk, SHALL name the `session_search` / `session_read` tools as the way to search and read them, and SHALL explain that the current session's own earlier turns (compacted out of context) are reachable by searching with the current session id.

#### Scenario: Session logs are the complete record

- **WHEN** the section is rendered
- **THEN** it states that a session log is `.agents/sessions/<id>.session.jsonl`, one message per
  line, and holds the whole conversation — including parts the current context has compacted away

#### Scenario: The tool is the primary path

- **WHEN** the section is rendered
- **THEN** it tells the agent to use `session_search` (and `session_read` to read a session) rather
  than grepping the raw session logs by hand

#### Scenario: The current session's earlier turns are reachable

- **WHEN** the section is rendered
- **THEN** it tells the agent that the current session's own earlier turns are on disk and can be
  reached by calling `session_search` with the current session id, and that `session_search`
  otherwise covers other sessions

### Requirement: The current session id is provided to the model

The system SHALL emit the current session's id as a `<session_id>` turn-context section for the root agent, so the model can address its own history with `session_search` / `session_read`. The section SHALL be absent for subagents and SHALL be re-admitted when the active session changes.

#### Scenario: The id is provided

- **WHEN** the root agent assembles its turn context
- **THEN** a `<session_id>` section carries the current session id

#### Scenario: Re-admitted when the session changes

- **WHEN** the active session changes (a different session is resumed, or a new session starts)
- **THEN** the `<session_id>` section's content changes and it is re-admitted like any changed kind

#### Scenario: Subagents do not receive it

- **WHEN** a subagent assembles its turn context
- **THEN** the `session_id` kind is filtered out

