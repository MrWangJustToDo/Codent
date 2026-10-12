## ADDED Requirements

### Requirement: The layer graph is acyclic and every allowed edge is exercised

The layer-boundary gate SHALL treat the top-level layers as a DAG: it SHALL reject an import cycle
between two layers, SHALL reject a declared edge that no import exercises, and SHALL declare an edge
`type-only` when every import across it is a type import. Every allowlisted edge SHALL carry a reason
that states the real import it permits (not a stale or generic one).

#### Scenario: A cycle is rejected

- **WHEN** two layers import each other (e.g. `models ↔ provider`)
- **THEN** the gate fails and the change makes the edge one-directional

#### Scenario: A dead edge is rejected

- **WHEN** `ALLOWED_EDGES` declares an edge that no source file exercises
- **THEN** the gate fails and the unused grant is deleted

#### Scenario: A type-only edge is declared type-only

- **WHEN** every import across an edge is `import type`
- **THEN** the edge is registered with `mode: "type-only"` rather than `allow`

### Requirement: The module-organization gate covers every top-level layer

The module-organization gate's set of known top-level core layers SHALL include every directory that
exists under `packages/core/src`, so its documentation-path rule validates paths inside each layer.
Adding a top-level layer SHALL require updating that set in the same change.

#### Scenario: A path inside a new layer is validated

- **WHEN** `provider/` and `runtime/` are added under `packages/core/src`
- **THEN** the gate's known-layer set includes them, and a documentation path inside either is checked for existence
