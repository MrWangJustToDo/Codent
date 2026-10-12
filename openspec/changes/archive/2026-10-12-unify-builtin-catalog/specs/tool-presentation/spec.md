## ADDED Requirements

### Requirement: Canonical built-in tool identifiers live in core

Core SHALL export the canonical identifier for every built-in tool (`BUILTIN_TOOL_NAMES`) and the
`begin_summary` marker name, so hosts reference a tool by identity instead of restating its name.
Core SHALL validate the exported registry against the tools it actually builds, so the registry
cannot drift from the tool definitions.

#### Scenario: Host references a built-in by identifier

- **WHEN** a host needs to compare, route, or label a built-in tool (e.g. render a `todo` result, mark a `run_command` failure, map an ACP kind)
- **THEN** it imports the identifier from core and does not write the tool name as a literal

#### Scenario: Registry matches the built set

- **WHEN** the core validator runs
- **THEN** every name in `BUILTIN_TOOL_NAMES` corresponds to a tool core builds, and every tool core builds is present in the registry

#### Scenario: Renaming or adding a built-in touches core only

- **WHEN** a built-in tool is renamed or added in core
- **THEN** no host-side name list, table, or switch needs editing for hosts to keep working

## MODIFIED Requirements

### Requirement: Hosts render presentation only

Hosts SHALL own colors, layout, and interactive views; tool-specific text and row decisions SHALL come from core. A host SHALL NOT keep a private table mapping built-in tool names to classification or display policy: tool classification SHALL be read from core's presentation descriptors (including the static built-in fallback), and the only tool names a host may name are core-exported identifiers used to select a host-owned view.

#### Scenario: Adding a built-in tool

- **WHEN** a new built-in tool is added
- **THEN** no host-side table or switch needs to change for it to render correctly

#### Scenario: Host derives row treatment

- **WHEN** a host decides whether a completed tool row keeps its block or folds
- **THEN** it reads the decision from core's presentation descriptor (or built-in fallback table) and does not maintain its own keep-row / detailed name sets

#### Scenario: Host classifies a built-in

- **WHEN** a host maps a built-in tool to its own classification vocabulary (e.g. an editor's tool kind)
- **THEN** it derives from core's presentation category and, for the few categories that do not map one-to-one, uses an override keyed by core's exported identifiers — not a second name list
