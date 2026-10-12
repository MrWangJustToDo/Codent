## ADDED Requirements

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
