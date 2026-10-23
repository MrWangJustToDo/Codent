## MODIFIED Requirements

### Requirement: Log policy is owned by a built-in extension

The system SHALL provide a built-in log extension (`createLogExtension`) that owns log **policy**: the event→entry rule table, per-event message formatting, payload summarizing, the JSONL file sink, size-based rotation, session-boundary markers, and JSONL validation of accepted entries. Core MUST NOT retain a second owner of that policy. Log policy MUST be reachable through one canonical `createLogExtension` factory, constructed once by core directly and unconditionally — without the extension runner.

The on-disk product contract keeps the existing `level` / `category` vocabularies, `.agents/logs/<rootSessionId>/agent.log` root path, `agent.log.{n}` rotation files, the 5 MiB / 5 file / 250 ms defaults, and the session-boundary divider. It adds the required `scope` object to every new entry and the explicit `data.indexOnly` marker for parent-log child lifecycle copies. The JSONL schema MUST validate `scope`; an unknown top-level field MUST still be rejected rather than silently stripped. Backward compatibility with pre-scope entries is not required.

#### Scenario: Policy is enforced at the extension boundary

- **WHEN** a bus event with a rule that suppresses it (for example `memory:prefetch`) is emitted
- **THEN** no entry for that event reaches the file, and the suppression is decided by the log extension rather than by the emitter

#### Scenario: Product contract is unchanged except for scope

- **WHEN** a session is run to completion after the move
- **THEN** the root log remains `.agents/logs/<rootSessionId>/agent.log`, rotation and boundary markers are unchanged, and every new entry validates with its `scope` field

#### Scenario: Entry accepted by the persisted schema

- **WHEN** the log extension admits an entry for writing
- **THEN** the entry MUST validate against the persisted log-entry schema, including `scope`, and an entry that fails validation MUST be rejected rather than written

#### Scenario: Scope is not silently stripped

- **WHEN** an entry carrying `scope.profile` and `scope.taskCallId` reaches the JSONL sink
- **THEN** both fields are present in the written line because the schema declares them rather than relying on a permissive passthrough

#### Scenario: The log extension is not a registered extension

- **WHEN** a consumer inspects the registered extensions, or disables every one of them
- **THEN** the log extension is not among them and log policy is unaffected — it needs no tools, commands or interceptors, so core constructs it directly instead of loading it through the extension runner, and it MUST NOT be disableable
