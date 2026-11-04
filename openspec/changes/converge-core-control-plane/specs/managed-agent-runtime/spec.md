## ADDED Requirements

### Requirement: Facets are internal parts of the single runtime object

Splitting `ManagedAgent` into facet modules SHALL NOT introduce a second agent runtime object. Each facet SHALL be owned by the `ManagedAgent` instance, SHALL receive explicit dependencies, and SHALL NOT be exposed to hosts as a separate agent handle. `AgentManager` SHALL continue to hold exactly one runtime object per agent.

#### Scenario: Facet ownership

- **WHEN** a facet reads or mutates agent state
- **THEN** it does so through the owning `ManagedAgent` instance or explicit dependencies, and no facet is registered in the agent registry on its own

#### Scenario: Host handle

- **WHEN** a host obtains an agent handle
- **THEN** it receives the `ManagedAgent` (or a structural subset), never a facet or a `SessionRuntime` port as the agent identity

### Requirement: Session lifecycle depends on ports, not the agent

`SessionLifecycleService` and the session switch transaction SHALL receive narrow ports (run control, transcript, mode state, sidecars) instead of the 38-member agent-shaped host. A port SHALL be implementable by a test fake without constructing a `ManagedAgent`, and no port method SHALL return the owning agent to reach another subsystem.

#### Scenario: Fake-driven switch test

- **WHEN** a test drives `new`, `resume`, `clone` or `fork`
- **THEN** it supplies fake ports and asserts side effects without an agent instance

#### Scenario: No back-reference

- **WHEN** the session domain is searched for a method that returns `ManagedAgent` from a port
- **THEN** no such method exists
