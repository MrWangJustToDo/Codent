# core-tool-layout

## Purpose

Ownership rules for where tool factories and tool helpers live under `@codent/core`.

## Requirements

### Requirement: Domain modules own their tool factories
Domain feature modules MUST own the model-callable tool factories that primarily mutate or query that domain's state. Universal workspace tools (filesystem, shell, web, ask_user) MUST remain under `agent/tools/`.

#### Scenario: Plan tools live with plan domain
- **WHEN** a developer looks for `create_plan`, `update_plan`, or `complete_plan` factories
- **THEN** those factories MUST be defined under `agent/plan/` (not `agent/tools/`)

#### Scenario: Skill tools live with skills domain
- **WHEN** a developer looks for `list_skills` or `load_skill` factories
- **THEN** those factories MUST be defined under `agent/skills/`

#### Scenario: Task tool lives with subagent domain
- **WHEN** a developer looks for the `task` tool factory
- **THEN** that factory MUST be defined under `agent/subagent/`

#### Scenario: Todo tool lives with todo domain
- **WHEN** a developer looks for the `todo` tool factory
- **THEN** that factory MUST be defined under `agent/todo/`

### Requirement: Universal tools directory stays tool-focused
`agent/tools/` MUST contain universal tool factories, the `createTools` assembler (`catalog/`), `tool-config`, tool runtime glue (`runtime/`), shared cross-tool helpers (`shared/`), presentation descriptors and formatting (`presentation/`), built-in implementations grouped by domain (`builtin/`), and websearch providers (`builtin/web/search/`). Non-factory helpers that only support a single tool MUST NOT sit as peer files of `*-tool.ts` at the `tools/` root when they can live under `shared/` or a feature subdirectory.

#### Scenario: Webfetch HTML helper is not a root tool peer
- **WHEN** HTML conversion helpers for webfetch are stored
- **THEN** they MUST live under the webfetch feature directory (`agent/tools/builtin/web/fetch/`) or `agent/tools/shared/` when the helper is cross-tool, not as `agent/tools/webfetch-html.ts` beside tool factories

#### Scenario: createTools only builds universal tools
- **WHEN** `createTools()` runs without a `processTools` hook
- **THEN** the returned record MUST include only universal tools and MUST NOT register plan, skill, task, or todo tools

### Requirement: Relocation preserves tool contracts
Moving tool factory modules MUST NOT change tool names, input/output schemas, or execution semantics.

#### Scenario: Plan authoring tools keep the same wire names
- **WHEN** the agent registers plan tools after the relocation
- **THEN** the tools MUST still be exposed as `create_plan`, `update_plan`, and `complete_plan` with the same schemas as before the move
