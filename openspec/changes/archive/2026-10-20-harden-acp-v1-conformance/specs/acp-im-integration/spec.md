## MODIFIED Requirements

### Requirement: The IM client depends only on the existing ACP contract

An ACP IM client SHALL depend only on the contract already specified by `acp-agent-host`,
`acp-session-catalog`, `acp-user-interaction` and `acp-prompt-content`; IM integration SHALL NOT
require a Codent-specific ACP extension. The ACP process SHALL resolve its model locally from the
flags / `.agents/config/models.json` / `.env` planes or its configured `--remote-provider` plane.
Each ACP session's `cwd` SHALL be that session's workspace root; when a request omits `cwd`, the
process `cwd` SHALL be the fallback. The process `cwd` also remains the default for `session/list`
without `cwd` and for reads that happen before a session exists.

#### Scenario: Session workspace root comes from the request cwd

- **WHEN** the gateway spawns `codent acp` with `work_dir` set to a project and creates a session whose `session/new` / `load` / `resume` / `fork` request carries that `cwd`
- **THEN** that directory SHALL be that session's workspace root
- **AND** a session created with a different `cwd` SHALL use its own root, MUST NOT share the process root

#### Scenario: Process cwd is the fallback

- **WHEN** a session request omits `cwd`
- **THEN** the session SHALL use the process `cwd` (the gateway's `work_dir`) as its workspace root

#### Scenario: Model configuration includes the remote-provider plane

- **WHEN** the ACP process is started with `--remote-provider`
- **THEN** the provider server supplies the connection and its model list, exactly as the local `models.json` plane would

#### Scenario: Interaction behaviour is the existing ACP specification

- **WHEN** an IM client needs to know how selectors, permissions, `ask_user` or prompt content behave
- **THEN** the answer is the requirement already stated in `acp-session-catalog`, `acp-user-interaction` or `acp-prompt-content`, and this change introduces no second copy of it
