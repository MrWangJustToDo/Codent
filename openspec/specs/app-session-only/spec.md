# app-session-only Specification

## Purpose

The app layer builds its agent control surface on AgentSession only, so a host never reaches past the session handle into manager internals. It fixes the boundary between the UI layer and core.

## Requirements
### Requirement: App holds Session not ManagedAgent
`@codent/app` runtime hooks, layout, and slash commands SHALL NOT import or hold `ManagedAgent`, `agentManager`, live `TodoManager`, or live `AgentLog` instances. Agent observation and control MUST go through `AgentSession` / `AgentSessionHost`.

#### Scenario: useAgent store
- **WHEN** an agent is initialized
- **THEN** the app store SHALL expose the active `AgentSession` (and Host if needed)
- **AND** SHALL NOT require a `ManagedAgent` field for UI operation

#### Scenario: Slash commands
- **WHEN** the user runs `/compact`, `/plan`, `/mcp`, `/new`, `/resume`, `/rename`, or `/auto`
- **THEN** the command handler SHALL use Session dispatch and/or Host catalog APIs only

### Requirement: Adapter bootstrap is Session-oriented
`AgentAdapter.initialize` / shared create helpers SHALL return `{ session, host?, initialMessages? }` (or equivalent) and MUST NOT require callers to receive a ManagedAgent.

#### Scenario: Local bootstrap
- **WHEN** the CLI starts without `--remote-session`
- **THEN** the host process SHALL create a Local AgentSessionHost, create a session, and pass that session into the app

#### Scenario: Remote bootstrap
- **WHEN** the CLI starts with `--remote-session <url>`
- **THEN** the UI process SHALL create a Remote AgentSessionHost against that URL and MUST NOT call `agentManager.createManagedAgent` in the UI process

### Requirement: Model config editor is reachable after initialization
`@codent/app` SHALL expose a slash-command entry point that opens the model-configuration editor (`ConfigEditor`) over a running local session, so provider / model settings are editable without restarting the host. Saving SHALL merge the edited connection into the existing `.agents/config/models.json` and SHALL preserve the rest of the document: other entries, the `global` block, and **every key the schema does not declare** (`$schema`, per-entry fields such as `headers`, future settings). The save SHALL reload the unified model pipeline in place. The entry point SHALL refuse to open when the connection is server-owned (`--remote-session` / `--remote-provider`).

#### Scenario: Edit config mid-session
- **WHEN** the user runs the settings command's `config` option on a local session
- **THEN** the app SHALL open `ConfigEditor` seeded from the session's active models.json entry
- **AND** saving SHALL write the merged config and reload the provider without tearing down the session

#### Scenario: Unknown keys survive a save
- **WHEN** the document being edited contains keys the schema does not declare (a `$schema`, an entry's `headers`, an unread `global` setting)
- **THEN** those keys SHALL still be present and unchanged after saving
- **AND** only the fields the editor owns (`type`, `style`, `baseURL`, `apiKey`, `models`) SHALL be rewritten on the edited entry

#### Scenario: Reload failure does not discard the edit
- **WHEN** the file is written but the pipeline cannot be reloaded (e.g. a sibling remote-provider entry is unreachable)
- **THEN** the save SHALL remain committed and be reported as saved-but-not-live, and SHALL NOT be rolled back

#### Scenario: First-run wizard is unchanged
- **WHEN** the host bootstrap finds no `.agents/config/models.json`
- **THEN** the editor SHALL still run in its first-run mode, writing the whole file

#### Scenario: Server-owned connection
- **WHEN** the session is `--remote-session` or `--remote-provider`
- **THEN** the entry point SHALL refuse with an explanation instead of opening the editor

### Requirement: Allowed residual core imports
The app MAY import serializable types and pure presentation helpers from core (or a future session-types package), and MAY use CoreEnv for workspace UI. The app MUST NOT import agent runtime control APIs (`agentManager`, `createManagedAgent`, compaction executors, side-LLM runners that need ManagedAgent).

#### Scenario: Lint or documented allowlist
- **WHEN** the change is complete
- **THEN** documentation SHALL list the allowed `@codent/core` import allowlist for app
- **AND** a validate script or lint check SHOULD fail on forbidden runtime imports

### Requirement: CoreEnv remains optional for agent control
Agent chat and session control SHALL work when the app uses only Session; CoreEnv registration in the UI process is required only for local workspace panels, not for Session dispatch.

#### Scenario: Remote agent with remote CoreEnv
- **WHEN** UI uses HTTP Session and remote CoreEnv
- **THEN** chat SHALL function via Session and file tools SHALL execute on the CoreEnv server without the UI holding ManagedAgent

