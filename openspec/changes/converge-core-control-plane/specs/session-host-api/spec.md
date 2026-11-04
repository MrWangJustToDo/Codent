## ADDED Requirements

### Requirement: Snapshot may expose additive state-axis projections

The session snapshot MAY expose optional, serializable projections of the agent state axes (`lifecyclePhase`, `runPhase`, `wait`) alongside the existing `status`. Adding them is additive: existing fields (`status`, `error`, `mode`, `pendingApprovalCount`, `interactions`, …) SHALL keep their current meaning, and a host that ignores the new fields SHALL behave exactly as before. When present, the fields SHALL be consistent with `status` at every observation, including over the remote session transport.

#### Scenario: Host ignores the new fields

- **WHEN** a host reads only the pre-existing snapshot fields
- **THEN** its rendering and command handling are unchanged

#### Scenario: Projection agrees with status

- **WHEN** a snapshot carries all four values
- **THEN** projecting the three axes yields the reported `status` and error text, with no contradictory combination

#### Scenario: Remote parity

- **WHEN** the snapshot is delivered over the HTTP/SSE session transport
- **THEN** the additive fields are present with the same values as the local snapshot, or consistently absent together
