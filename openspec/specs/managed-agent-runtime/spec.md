# managed-agent-runtime Specification

## Purpose

One runtime object per agent: `ManagedAgent` owns config, context, services and run orchestration, and services take explicit dependencies instead of reaching back through a host object.
## Requirements
### Requirement: ManagedAgent is the only agent runtime object

`AgentManager` SHALL hold exactly one runtime object per agent, a `ManagedAgent`, and SHALL NOT
construct a second agent object to represent the same agent. `createManagedAgent()` SHALL build the
`ManagedAgent` directly (via `buildManagedAgent`) and register it; there SHALL be no `Agent`, `Base`,
or `AgentLoopHost` class in core, and no `ManagedAgent.agent` field pointing at one. Host-facing
code SHALL therefore type an agent handle as `ManagedAgent` (or a structural subset of it), not as a
separate "agent" interface.

This is the invariant, not a file layout: the predecessor design had `Agent` + `Base` holding
session / memory / compaction / hooks / MCP / skills / abort logic while `ManagedAgent` duplicated
`context`, `status` and service access for the same agent, and `AgentLoopHost` existed only to wire
`MemoryService` / `SessionService` back to `Agent`. Restoring any of those returns core to two
objects that both claim to be "the agent".

#### Scenario: Building an agent

- **WHEN** `AgentManager.createManagedAgent()` is called
- **THEN** the returned value is a `ManagedAgent`, registered under its own id, and no second agent instance is created or attached

#### Scenario: Auditing for the removed classes

- **WHEN** core is searched for `class Agent`, `class Base`, `interface AgentLoopHost`, `extends Base`, `attachManagedState`, or a `ManagedAgent.agent` field
- **THEN** there are zero matches

#### Scenario: Host code types an agent

- **WHEN** `packages/app`, `packages/cli`, or `packages/extension` refers to an agent instance
- **THEN** it uses `ManagedAgent` (directly or via a structural subset), with no `Agent` type alias exported from core

### Requirement: Services receive an explicit dependency surface

`MemoryService` and `SessionService` SHALL be constructed with explicit dependencies, and SHALL NOT
receive a host object whose only purpose is to reach back to the owning agent (the former
`AgentLoopHost` indirection: a `getAgent()`-shaped back-reference used to call back into the agent
that owns the service). A service SHALL read what it needs from its constructor argument rather than
traversing an agent to find it.

#### Scenario: Constructing a service

- **WHEN** `MemoryService` or `SessionService` is constructed
- **THEN** its dependencies arrive as an explicit object, and no `AgentLoopHost` interface exists for it to consume

#### Scenario: Auditing for the back-reference

- **WHEN** core is searched for `AgentLoopHost`
- **THEN** there are zero matches

### Requirement: ManagedAgent reads its environment and model connection from its runtime

`AgentManager.createManagedAgent` SHALL bind each agent to the runtime that owns the manager, and
`ManagedAgent` (and the services it composes) SHALL obtain the environment (filesystem, shell, fetch,
platform) and the model connection from that runtime rather than from process-global registries. This
SHALL NOT reintroduce a second agent object: `ManagedAgent` remains the single runtime object per agent.

#### Scenario: Two agents in two runtimes

- **WHEN** an agent is created in runtime A (`rootPath` "/a") and another in runtime B (`rootPath` "/b")
- **THEN** a tool run by the first agent resolves files under "/a" and a tool run by the second resolves files under "/b"

#### Scenario: Auditing for direct global reads on the run path

- **WHEN** core's run path (agent creation, run, session persistence, media, websearch) is searched for a direct module-level environment or provider singleton read that bypasses the runtime resolution seam
- **THEN** none is found: every such read resolves through the active runtime

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

