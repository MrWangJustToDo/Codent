## ADDED Requirements

### Requirement: Plan mode withholds the tools that write, by declaration

While plan mode restricts tools, the set it withholds SHALL be derived from each tool's own
declaration — every tool whose presentation `category` is `edits` is withheld — rather than from a name
list, so that a tool which writes the workspace cannot become available by arriving under a new name.
A tool withheld for a different reason SHALL be named with that reason where it is declared.

The restriction SHALL hold at both ends: the withheld tools are absent from the tool record the model
receives, and a call that arrives anyway is refused before it executes.

#### Scenario: An editing tool that is on no list is withheld

- **WHEN** plan mode restricts tools and a turn would otherwise offer `code_rewrite` (declared
  `category: "edits"`, and able to write in place with `dry_run: false`)
- **THEN** `code_rewrite` is absent from the tool record the model receives
- **AND** a `code_rewrite` call that arrives anyway is refused with the plan-mode reason

#### Scenario: A tool withheld for another reason carries that reason

- **WHEN** the withheld set includes a tool that does not write the workspace (background-job control)
- **THEN** it is named at its declaration with the reason it is withheld
- **AND** every tool declaring `edits` is still withheld by the derived rule
