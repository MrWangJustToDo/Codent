# app-command-menu Specification

## Purpose
TBD - created by archiving change merge-model-effort-switch. Update Purpose after archive.
## Requirements
### Requirement: Slash-command option menus may nest

A command's option list SHALL be able to open a further level instead of executing, so a single
command can express a decision made of more than one choice (which model, then how hard it thinks)
without inventing a second command.

- An option carrying a level resolver SHALL be a **submenu row**: accepting it SHALL open that level
  and SHALL NOT execute the command.
- An option without one SHALL be a **leaf**: accepting it SHALL execute the command with the full
  chain of chosen values as arguments (`/cmd <value…> <leaf>`).
- A command SHALL receive the current chain when asked for a level's rows, so one resolver can serve
  every level without the host knowing how many levels exist.
- The level stack SHALL be owned by the menu, and each level's rows SHALL be retained, so retreating
  restores what the user saw rather than re-resolving it (metadata may have changed underneath).

#### Scenario: Descending into a level

- **WHEN** the user accepts a row that declares a level resolver
- **THEN** the menu shows that level's rows and the input is rewritten to that level's prefix
- **AND** the command is NOT executed

#### Scenario: Retreating one level

- **WHEN** the user presses Esc while a nested level is open
- **THEN** the menu returns to the parent level's rows and the input is rewritten to the parent's prefix
- **AND** the menu is NOT closed

#### Scenario: Closing from the root

- **WHEN** the user presses Esc at the root level (or with no menu open beyond it)
- **THEN** the menu closes
- **AND** nothing is executed

#### Scenario: An empty level is a leaf

- **WHEN** a row declares a level resolver that answers with no rows
- **THEN** accepting that row executes the command instead of opening an empty level
- **AND** the user is never left inside a level with nothing to choose

#### Scenario: Typing past the level leaves the menu

- **WHEN** the user types arguments that no longer sit inside the current level's prefix
- **THEN** the menu closes and the text is left as typed
- **AND** a partial prefix still filters the level's rows, with the prefix itself stripped before matching

### Requirement: A nested selection commits only at the leaf

A command whose menu nests SHALL NOT apply any effect at an intermediate level. The effect SHALL be
applied once, when a leaf is accepted, so retreating through the menu is indistinguishable from never
having opened it.

#### Scenario: Retreating commits nothing

- **WHEN** the user descends into a level and then presses Esc back to the root
- **THEN** the command has applied no change to the session

#### Scenario: The whole chain travels in the arguments

- **WHEN** a leaf is accepted at depth
- **THEN** the command is executed through the ordinary argument string with every chosen value, so it
  re-parses the same way as if the user had typed the chain

