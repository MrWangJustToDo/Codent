# tool-presentation Specification

## Purpose
TBD - created by archiving change unify-tool-presentation-in-core. Update Purpose after archive.
## Requirements
### Requirement: Per-tool presentation descriptors live in core

Every tool SHALL declare its presentation metadata in core, either at definition time or through a registration API. Hosts SHALL NOT maintain tool-name tables of their own.

#### Scenario: Built-in tool declares its presentation

- **WHEN** a built-in tool is defined
- **THEN** it declares its own category, keep-row/detailed flags, summary, label, result text, and input text alongside its name, schema, and execute function

#### Scenario: Runtime tool registers its presentation

- **WHEN** a tool registers after startup (extension or custom tool)
- **THEN** its presentation metadata is registered in the same registry as built-ins, without touching host code

#### Scenario: Single declaration surface

- **WHEN** any tool declares how it is displayed
- **THEN** it uses one `present` descriptor, and no second display surface exists for tools or hosts (the former `toUI` / `display` fields are gone)

#### Scenario: Resolution order

- **WHEN** no presentation metadata is registered for a tool name
- **THEN** core falls back to its built-in table, and then to generic defaults (`category: "other"`, no summary/label/text)

### Requirement: Fold and row-visibility rules are owned by core

Core SHALL decide which completed tool rows stay visible in compact display and which fold into an activity summary. Error and denial states SHALL fold (counted as errors) rather than remain rows.

#### Scenario: Structured tool row stays visible

- **WHEN** a tool whose descriptor keeps its row completes successfully
- **THEN** its row remains in compact display

#### Scenario: Result renderer alone does not keep the row

- **WHEN** a completed **built-in** tool has a result-text renderer but does not declare keep-row
- **THEN** its row folds into the activity summary, and its text is rendered only in full display

A built-in declares `text` so full display shows a readable body (a session page, a tree, LSP
results). Treating that as a row policy made every such tool permanently unfoldable in compact
display — the mode whose purpose is density.

#### Scenario: Extension tool with a result renderer keeps its row

- **WHEN** a completed tool that is **not** a built-in has a result-text renderer
- **THEN** its row remains visible in compact display and its text is rendered by the host

For a tool the host does not own, that string is its whole result; folding would hide the output.
Such a tool (or any tool) can also declare keep-row explicitly.

#### Scenario: Errored row folds

- **WHEN** a tool call failed or was denied
- **THEN** it folds into the activity summary as an error count instead of remaining a row

#### Scenario: Unbucketed tools are named

- **WHEN** a folded run contains tools with no specific category
- **THEN** the summary names them by tool name instead of printing an opaque generic count

### Requirement: Tool presentation metadata ships to hosts as data

Core SHALL publish a serializable projection of the descriptor registry (no functions) as part of the session snapshot, so hosts can render rows before any per-call payload exists.

#### Scenario: Catalog contents

- **WHEN** a host reads the session snapshot
- **THEN** it receives one entry per known tool with category, keep-row/detailed/client-side flags, and whether summary/text renderers exist

#### Scenario: Extension tools are attributed

- **WHEN** an extension registers tools
- **THEN** the catalog and the extension snapshot entry both expose those tool names and their metadata

#### Scenario: Disabled extension drops out

- **WHEN** an extension is disabled
- **THEN** its tools disappear from the catalog

#### Scenario: Cross-process hosts

- **WHEN** the session runs against a remote core (server snapshot route / remote session client)
- **THEN** the catalog is transported intact

### Requirement: Core computes a per-call display payload

On tool completion, core SHALL compute the tool's display payload (result text, header summary, activity label) from the stored output and attach it to that tool-call part.

#### Scenario: Payload attached at completion

- **WHEN** a tool with a result renderer completes
- **THEN** its tool-call part carries the rendered text (and summary/label when available) without any host-side registry lookup

#### Scenario: Deterministic

- **WHEN** the same tool result is rendered twice
- **THEN** the payload is identical

#### Scenario: No renderer, no payload

- **WHEN** a tool has no result renderer
- **THEN** no payload is attached and hosts fall back to the catalog for row/block treatment

#### Scenario: Payload survives part rebuilds

- **WHEN** hosts dedupe, merge, or re-project messages
- **THEN** the payload is preserved (including when only the duplicate part carried it)

#### Scenario: Host caches invalidate on payload change

- **WHEN** a part's payload changes while identity, state, and output stay the same
- **THEN** host render caches and list signatures treat the row as changed

### Requirement: Display payload never reaches the model

The display payload SHALL be a host-facing projection only; model-facing tool content SHALL continue to be produced by the model-output transform.

#### Scenario: Model messages exclude it

- **WHEN** UI messages are converted to model messages
- **THEN** the display payload is absent from the produced content

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

