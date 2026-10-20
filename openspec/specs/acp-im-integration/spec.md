# acp-im-integration Specification

## Purpose
TBD - created by archiving change replace-im-bridge-with-cc-connect. Update Purpose after archive.
## Requirements
### Requirement: IM integration is provided by an external ACP client

IM integration SHALL be provided by an external ACP client driving `codent acp` over stdio, not by
a Codent-owned chat bridge. The repository SHALL NOT ship, build, or validate an in-repo IM bridge,
and a second IM integration path SHALL NOT exist beside the ACP one.

#### Scenario: An IM gateway points at the ACP process

- **WHEN** an operator configures cc-connect with `[projects.agent] type = "acp"` and `[projects.agent.options] cmd = "codent"`, `args = ["acp"]`
- **THEN** the gateway spawns `codent acp` in the configured workspace and drives it over ACP without any Codent-specific adapter

#### Scenario: No in-repo bridge remains

- **WHEN** the repository is inspected after this change
- **THEN** there is no `im-bridge` workspace package, no `im-bridge.mjs` entry, and no `build:im-bridge` / `dev:im-bridge` / `start:im-bridge` script

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

### Requirement: The repository ships a reviewed cc-connect recipe

The repository SHALL ship a cc-connect example configuration and an integration guide, both checked
in, so the supported path is reviewable rather than external folklore. The recipe SHALL name the
agent command, the workspace mapping, the model configuration sources, at least one domestic and one
foreign platform block, and the access-control knobs that belong to the gateway.

#### Scenario: A reader can build a working config

- **WHEN** an operator follows `docs/acp-im.md` and `docs/cc-connect.example.toml`
- **THEN** the example names `codent acp`, a concrete `work_dir`, the model planes, and both a Telegram and a Feishu/Lark platform block

#### Scenario: Filtering and operations are delegated

- **WHEN** the recipe describes access control
- **THEN** it points at cc-connect's `allow_from` / `admin_from`, banned words, per-user roles and rate limits instead of re-implementing them in Codent

### Requirement: Retiring the bridge leaves no dangling build surface

Removing the in-repo bridge SHALL leave no dangling build, lint, typecheck, validation, or
documentation reference: the workspace package, its scripts, its validators, the root entry file and
its lint globs are removed together, and documentation names the ACP path instead.

#### Scenario: Repository commands stay green

- **WHEN** `pnpm typecheck`, `pnpm lint`, and the validator runner execute after the change
- **THEN** none of them references `@codent/im-bridge` or its workspace directory, and all packages still pass

#### Scenario: Documentation points at the supported path

- **WHEN** `README.md` or `AGENTS.md` describes IM integration
- **THEN** it names the external ACP client path and does not claim an in-repo bridge exists

