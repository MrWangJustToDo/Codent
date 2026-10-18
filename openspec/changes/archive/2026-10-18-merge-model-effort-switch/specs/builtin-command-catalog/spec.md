## MODIFIED Requirements

### Requirement: Built-in slash-command catalog is the single source

Core SHALL own the built-in slash-command catalog: each entry's `name`, `aliases`, `description`,
`usage`, `scope`, and the `AgentSessionCommand` it dispatches. Hosts SHALL NOT restate a built-in
command's metadata. A host registers or advertises a built-in command by sourcing its metadata from
the catalog and supplying only host-local behavior (an executable handler) or nothing (a headless host
dispatches through the session).

The catalog SHALL carry **one** command for choosing the model and its thinking depth: `/models`.
A separate thinking-depth command SHALL NOT be advertised, because the depth is a property of the
chosen model — advertising it twice lets a host offer a depth the model being switched to cannot
honour, and forces a user to visit two menus for one decision. `/models`' usage SHALL therefore
document the depth argument, and every level that usage advertises SHALL parse.

#### Scenario: App registers a built-in command

- **WHEN** the terminal app registers a built-in command
- **THEN** `name` / `description` / `usage` / `aliases` come from `BUILTIN_COMMAND_CATALOG`, and the command file supplies only the handler and host-local options
- **AND** registering a command with no catalog entry fails loudly

#### Scenario: Headless host advertises and dispatches

- **WHEN** a headless host (ACP) advertises or dispatches a built-in command
- **THEN** it reads the command set from the catalog and does not keep a private name switch

#### Scenario: Adding a built-in command touches core only

- **WHEN** a built-in command is added to the catalog in core
- **THEN** the app and any headless host surface it without a second metadata declaration

#### Scenario: Parity is enforced by construction

- **WHEN** the host parity check runs
- **THEN** it asserts every catalog command is registered by the app and that app commands carry no catalog-owned metadata of their own, rather than comparing two restated strings

#### Scenario: Thinking depth has no command of its own

- **WHEN** a host enumerates the advertised commands
- **THEN** the set contains `/models` and NOT a separate thinking-depth command
- **AND** `/models`' advertised usage names the depth argument, and every level it names parses into a `set` intent

#### Scenario: The model command's argument grammar is core's

- **WHEN** a host parses `/models <args>`
- **THEN** it uses core's `parseModelsCommand`: no argument is `list`, `"<entryIndex>:<model>"` is a
  `set` naming that entry, a bare token is a `set` the host resolves against its own entries, and a
  second token is an effort level or `off`
- **AND** an unrecognised second token is `invalid` rather than being forwarded to the model
- **AND** the host applies the model switch BEFORE the depth, so the depth is validated against the
  model it switched to
