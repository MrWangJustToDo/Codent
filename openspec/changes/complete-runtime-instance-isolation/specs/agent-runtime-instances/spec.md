## MODIFIED Requirements

### Requirement: CodentAgent owns session lifecycle

`CodentAgent` SHALL expose `createSession`, `getSession`, `listSessions`, `destroySession`, and
`dispose`. `createSession` SHALL delegate to the runtime's `AgentSessionHost` and apply the runtime's
default options. `dispose` SHALL destroy every live session owned by the runtime, release the provider,
and release the environment only when the runtime owns it (`ownsEnv`); a borrowed environment (a
remote `CoreEnv` for `--remote-env` / `--remote-session`, or a host-supplied env) SHALL NOT be
destroyed, because a remote `destroy()` posts a destructive teardown to the server. `dispose` SHALL be
idempotent.

#### Scenario: Creating a session

- **WHEN** `createSession(options)` is called on a `CodentAgent`
- **THEN** it returns an `AgentSession` (plus any restored messages) created in that runtime's manager, with the runtime defaults merged in

#### Scenario: Disposing a runtime

- **WHEN** `dispose()` is called on a runtime that owns its environment
- **THEN** every agent the runtime created is destroyed, `ModelProvider.destroy()` (if present) runs, the environment is destroyed, and the runtime no longer appears in any list

#### Scenario: Disposing a borrowed environment

- **WHEN** `dispose()` is called on a runtime whose `ownsEnv` is false (a remote or host-supplied env)
- **THEN** the sessions and provider are released but the environment is left intact

#### Scenario: Dispose is idempotent

- **WHEN** `dispose()` is called more than once
- **THEN** the second call performs no additional teardown

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

- **WHEN** core's run path is searched for a direct `getEnv()` / `getModelProvider()` read — as guarded by `validate:runtime-env-guard`, which scans the whole run path (tools, media, persistence, MCP, managers, prompt, turn-context, plan, log, extension, skills, memory, subagent, runner, compaction, UI) and accepts only an explicit fallback (`?? getEnv()` / a default parameter), never a bare assignment
- **THEN** none is found; every such read resolves from the runtime carried into the call

#### Scenario: Ambient fallback

- **WHEN** code reads `getEnv()` with no runtime active (a bare script or a validator that registered only the ambient environment)
- **THEN** it receives the ambient environment and behaves as before

### Requirement: Workspace-scoped state is owned by the runtime

State that belongs to a workspace SHALL be owned by the runtime (shared by that runtime's agents,
isolated from other runtimes): the session store, media store, websearch provider manager and its API
keys, usage history, git info cache, file-mutation queues, command-job registry and its durable job-log
files, project-instruction/plan/log paths, and extension + skill discovery. State that is not
workspace data SHALL remain process-global.

#### Scenario: Usage history and git cache do not leak across runtimes

- **WHEN** an agent in runtime A records usage and reads git info, and runtime B has its own workspace
- **THEN** runtime B's usage history and git info are its own, and neither observes the other's

#### Scenario: Websearch keys do not leak across runtimes

- **WHEN** two runtimes configure different websearch API keys
- **THEN** each agent's websearch selections use its own runtime's keys, and neither observes the other's

#### Scenario: Job logs and discovery use the runtime root

- **WHEN** an agent in runtime B starts a background job, reads extensions, or resolves default skills
- **THEN** the job's durable log is written under B's root (so the advertised `cachedOutputPath` is readable through B's env) and B's own extension/skill directories are used

#### Scenario: Non-workspace state stays global

- **WHEN** a tool's presentation or `toModelOutput` handler is registered
- **THEN** it is visible process-wide (a code registry, not workspace data), independent of the runtime

## ADDED Requirements

### Requirement: A managed agent resolves its project data from its runtime

Running a managed agent SHALL resolve all workspace-scoped project data from that runtime's env: its
project-instruction files (`AGENTS.md` / `CLAUDE.md` and `@` imports), its plan files, its session log
files, and its extension/skill discovery roots SHALL be read and written under the runtime's
`rootPath`, not the process-global env.

#### Scenario: A second runtime loads its own project instructions

- **WHEN** a managed agent runs on runtime B whose `rootPath` differs from the ambient env
- **THEN** its system prompt contains runtime B's project instructions, and none of runtime A's

#### Scenario: A second runtime writes its plan and log under its own root

- **WHEN** an agent on runtime B saves a plan or writes its session log
- **THEN** the files are created under runtime B's `rootPath`, and runtime A's workspace is untouched
