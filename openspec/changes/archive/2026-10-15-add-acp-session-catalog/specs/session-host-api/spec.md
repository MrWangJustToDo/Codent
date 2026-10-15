## MODIFIED Requirements

### Requirement: AgentSessionHost catalog
The system SHALL provide an `AgentSessionHost` API with `create`, `connect`, `list`, and `destroy` so apps can manage sessions without `agentManager` or `SessionStore` imports. `list` SHALL report the live agents currently owned by the host. The host SHALL additionally support a persisted-session catalog through optional members `listPersistedSessions?` (enumerate the workspace's persisted sessions) and `deleteSession?` (remove one), which a host SHALL omit when its backing plane cannot serve them — mirroring the existing optional `getModelProvider?` / `getEnv?` convention. Because these two are optional, adding them SHALL NOT break existing host implementations, and a consumer SHALL treat their absence as "this host cannot enumerate/delete persisted sessions" rather than as an error to be papered over. Naming: this is deliberately NOT `listSessions` — `CodentAgent.listSessions()` already exists and returns the LIVE agents of a runtime, while `Host.list` returns the live agents of a host; both answer "what is running". `listPersistedSessions` answers "what is stored".

#### Scenario: Create and list
- **WHEN** the host creates a session and later calls `list()`
- **THEN** the new session metadata SHALL appear in the list result

#### Scenario: Connect to child session
- **WHEN** a root snapshot lists a subagent id
- **THEN** `host.connect(childId)` SHALL return an AgentSession for that id with the same interface as the root

#### Scenario: List persisted sessions without a live agent
- **WHEN** the host provides `listPersistedSessions` and the workspace holds persisted sessions created by an earlier process
- **THEN** it SHALL return them, MUST NOT return an empty list solely because nothing is live
- **AND** each entry SHALL carry the disk session id used by resume and delete

#### Scenario: Delete a persisted session directly
- **WHEN** `deleteSession(id)` is called for a persisted session that is not live
- **THEN** it SHALL remove the session's persisted data and report success
- **AND** it MUST NOT create an agent to do so

#### Scenario: Delete reports absence
- **WHEN** `deleteSession(id)` is called for a session that is neither live nor persisted
- **THEN** it SHALL report failure (not-found) rather than throwing or silently succeeding

#### Scenario: A host without the catalog compiles and reports absence
- **WHEN** a host implementation (e.g. a remote-session host backed only by the agent HTTP plane) does not provide `listPersistedSessions` / `deleteSession`
- **THEN** it SHALL still satisfy the `AgentSessionHost` contract
- **AND** a consumer SHALL detect the absence and degrade explicitly rather than calling a member that does not exist
