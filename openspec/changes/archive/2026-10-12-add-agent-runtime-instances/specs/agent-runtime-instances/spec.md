## ADDED Requirements

### Requirement: A process can instantiate isolated agent runtimes

The system SHALL provide a `CodentAgent` runtime handle constructible via `CodentAgent.create(options)`,
each owning exactly one `CoreEnv`, one optional `ModelProvider`, one `AgentManager`, and one
`AgentSessionHost`. Two `CodentAgent` instances SHALL NOT share a workspace (`CoreEnv`), a model
connection, or an agent registry.

#### Scenario: Two runtimes with different workspaces

- **WHEN** two `CodentAgent` instances are created with different `CoreEnv` `rootPath` values
- **THEN** an agent created in the first reads and writes only the first root, and an agent created in the second reads and writes only the second root, concurrently

#### Scenario: Two runtimes with different providers

- **WHEN** two `CodentAgent` instances are created with different `ModelProvider` connections
- **THEN** each instance's agents resolve the model connection of their own runtime, and neither observes the other's base URL or key

#### Scenario: No shared agent registry

- **WHEN** a session is created in one `CodentAgent`
- **THEN** `listSessions()` on the other `CodentAgent` does not include it

### Requirement: CodentAgent owns session lifecycle

`CodentAgent` SHALL expose `createSession`, `getSession`, `listSessions`, `destroySession`, and
`dispose`. `createSession` SHALL delegate to the runtime's `AgentSessionHost` and apply the runtime's
default options. `dispose` SHALL destroy every live session owned by the runtime and release the
provider and environment.

#### Scenario: Creating a session

- **WHEN** `createSession(options)` is called on a `CodentAgent`
- **THEN** it returns an `AgentSession` (plus any restored messages) created in that runtime's manager, with the runtime defaults merged in

#### Scenario: Disposing a runtime

- **WHEN** `dispose()` is called
- **THEN** every agent the runtime created is destroyed, `ModelProvider.destroy()` (if present) runs, and the runtime no longer appears in any list

### Requirement: The runtime is passed explicitly to where it is read

`AgentManager`, `ManagedAgent`, the tool run context, and the runtime-scoped stores SHALL receive the
`AgentRuntime` (or its `env` / `modelProvider`) explicitly, and the run path SHALL NOT read the
process-global `getEnv()` / `getModelProvider()` registries. Tools and middleware SHALL read the
environment from the run context (`ToolRunContext.coreEnv`); all other runtime-owned code SHALL read
it from the `AgentRuntime` instance it was constructed with. `getEnv()` / `getModelProvider()` SHALL
remain only as the ambient fallback for code that has not been migrated.

#### Scenario: Tools read the environment from the run context

- **WHEN** a tool executes
- **THEN** it reads the environment from `ToolRunContext.coreEnv` carried on its run, not from `getEnv()`

#### Scenario: Non-tool code reads the runtime instance

- **WHEN** a store, service, or manager needs the environment or model provider
- **THEN** it reads it from the `AgentRuntime` instance it was constructed with

#### Scenario: Model config resolution uses the runtime provider

- **WHEN** model configuration is resolved for a `CodentAgent` (app-side `resolveModelConfigFromProvider` against that runtime's host)
- **THEN** the resolution uses that runtime's `ModelProvider` and not the process-global registry, so two runtimes created with different keys resolve different connections

#### Scenario: The app reads the workspace env from its provider

- **WHEN** an app component or workspace utility needs the environment (fs, rootPath, runCommand)
- **THEN** it receives the env the host supplied through `CoreEnvProvider` / `useCoreEnv` (passed explicitly into the utility) and never reads the ambient `getEnv()` registry

#### Scenario: A host exposes its runtime provider

- **WHEN** an `AgentSessionHost` created by a local runtime is asked for its model provider
- **THEN** it returns that runtime's `ModelProvider`; a remote-session host returns nothing, leaving resolution to the ambient/provider server path

#### Scenario: Concurrent runs see their own environment

- **WHEN** an agent in runtime A and an agent in runtime B run concurrently, each with its own `rootPath`
- **THEN** each run's tool context carries its own runtime's env, so a filesystem or shell call made during A's run uses A's root and one made during B's run uses B's root

#### Scenario: No direct global read on the run path

- **WHEN** core's run path (tools, media, persistence, MCP, managers) is searched for a direct `getEnv()` / `getModelProvider()` read
- **THEN** none is found; every such read resolves from the runtime carried into the call

#### Scenario: Ambient fallback

- **WHEN** code reads `getEnv()` with no runtime active (a bare script or a validator that registered only the ambient environment)
- **THEN** it receives the ambient environment and behaves as before

### Requirement: Stores bind to the runtime environment

`SessionStore` and `MediaStore` (and the other env-backed runtime state) SHALL use the `CoreEnv` of the
runtime that owns them and SHALL NOT read a process-global environment. Two runtimes in one process
SHALL persist and read independently even when their backends differ (one local, one remote).

#### Scenario: Local and remote instances coexist

- **WHEN** instance L uses a local `CoreEnv` and instance R uses a remote `CoreEnv`
- **THEN** a session created in L is written and read through L's local filesystem and one created in R through R's remote filesystem, and neither observes the other's files

#### Scenario: Sharing within a runtime, isolation across runtimes

- **WHEN** two agents are created in the same runtime and a third in a different runtime
- **THEN** the two share that runtime's `SessionStore` / `MediaStore` (they see each other's stored media), and the third runtime's agents do not

### Requirement: Workspace-scoped state is owned by the runtime

State that belongs to a workspace SHALL be owned by the runtime (shared by that runtime's agents,
isolated from other runtimes): the session store, media store, websearch provider manager, usage
history, git info cache, file-mutation queues, and command-job registry. State that is not workspace
data SHALL remain process-global.

#### Scenario: Usage history and git cache do not leak across runtimes

- **WHEN** an agent in runtime A records usage and reads git info, and runtime B has its own workspace
- **THEN** runtime B's usage history and git info are its own, and neither observes the other's

#### Scenario: Non-workspace state stays global

- **WHEN** a tool's presentation or `toModelOutput` handler is registered
- **THEN** it is visible process-wide (a code registry, not workspace data), independent of the runtime

### Requirement: A runtime carries a name

`AgentRuntime` (and the `CodentAgent` that owns it) SHALL carry a `name`, defaulting to the workspace
root's basename, that per-runtime services (usage history, command jobs, log naming) can associate with.

#### Scenario: Naming a runtime

- **WHEN** `CodentAgent.create({ env, name })` is called
- **THEN** the runtime reports `name`, and a create without a name derives one from `env.rootPath`

### Requirement: The AgentSessionHost is scoped to its runtime

An `AgentSessionHost` SHALL be produced by a runtime (local) or be a remote-client host, and a local
host's `create`, `connect`, `list`, and `destroy` SHALL operate only on agents of its own runtime.

#### Scenario: Host create is runtime-local

- **WHEN** runtime A's host creates a session
- **THEN** the manager that owns it is runtime A's manager and runtime B's host neither lists nor can connect to it

### Requirement: The ambient runtime preserves the legacy bootstrap

`registerCoreEnv` and `registerModelProvider` SHALL install the ambient runtime, and `agentManager`
SHALL remain available as the ambient runtime's manager, so a host that has not adopted `CodentAgent`
continues to function without change.

#### Scenario: Legacy host unchanged

- **WHEN** a host calls `registerCoreEnv(env)` and `registerModelProvider(provider)` and then uses `agentManager`
- **THEN** agent creation and runs behave exactly as before adoption of `CodentAgent`
