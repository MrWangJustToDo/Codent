## ADDED Requirements

### Requirement: Agent ids are core-minted, not host-supplied

Core SHALL mint a `ManagedAgent`'s id when the agent is created, and `ManagedAgentConfig` SHALL NOT
accept an `id` — a host cannot choose one. The only override SHALL be an internal creation path
(`AgentManager.spawnSubagent` → `createManagedAgent` → `init.id`), which core uses to give a `task`
subagent the `subagent_…` id it was spawned under.

The id SHALL be treated as process-scoped: it is re-minted when the process restarts, so it MUST NOT be
used as a correlation key across processes or sessions. The persisted disk session is that key
(`AgentSessionSnapshot.activeSessionId`).

#### Scenario: A host cannot choose the agent id

- **WHEN** a host builds a configuration object for `AgentManager.createManagedAgent()`
- **THEN** the type accepts no `id` field, and the created agent's id was minted by core

#### Scenario: A subagent keeps the id it was spawned under

- **WHEN** the `task` tool spawns a subagent and hands core the `subagent_…` id it assigned
- **THEN** the subagent is registered under exactly that id, and no id is minted over it

#### Scenario: The agent id is not a correlation key

- **WHEN** a process restarts and resumes a persisted session
- **THEN** the agent id is newly minted, while `activeSessionId` identifies the conversation
