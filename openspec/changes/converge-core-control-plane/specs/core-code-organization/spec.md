## MODIFIED Requirements

### Requirement: Source files respect the 400-line guideline

Core source files SHALL stay within the workspace's 400-line guideline (`.cursor/rules/040`)
where a cohesive responsibility boundary exists. The control-plane composition root SHALL be
split into a thin facade plus facet modules rather than relying on the former
"`managed-agent.ts` as composition root" exception: `ManagedAgent` SHALL keep the facade and
delegate cohesive state clusters (model, session, run, mode, tool, extension) to facet modules.
A file above the 800-line lint ceiling SHALL still require a written justification naming what
was extracted instead.

#### Scenario: Oversized validation entry

- **WHEN** `src/dev.ts` grows past 400 lines of re-exports
- **THEN** it is split into domain-scoped parts under the limit with `dev.ts` as the aggregating entry

#### Scenario: Facade delegates state clusters

- **WHEN** `ManagedAgent` exposes model, session, run or mode state
- **THEN** the implementation lives in the corresponding facet module and the facade delegates, so no single file owns several unrelated clusters

#### Scenario: Composition root no longer exempt

- **WHEN** `managed-agent.ts` approaches the guideline again
- **THEN** the change extracts a facet or documents the cohesive boundary instead of citing the composition-root exception

## ADDED Requirements

### Requirement: Control-plane code is organised by domain

Control-plane code SHALL be grouped by domain under `agent/`: `state` (three axes and projection), `run` (coordinator, pump, finalizer, span), `session` (lease, ports, switch, persistence, ownership), `mode` (plan, auto, `ModeState`), `approval` (table, decisions, authorization pipeline). `managers/` SHALL hold only the agent registry, lifecycle coordinator and telemetry wiring; it SHALL NOT remain the home for domain controllers and services.

#### Scenario: New control-plane module

- **WHEN** a new control-plane module is added
- **THEN** it lands in its domain directory, and the layer/module gates accept it without adding a new top-level layer

#### Scenario: Managers scope audit

- **WHEN** `managers/` is listed after the migration
- **THEN** it contains the registry, lifecycle coordinator and telemetry only, and no plan/approval/session/compaction controller
