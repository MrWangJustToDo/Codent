# agent-event-envelope Specification

## Purpose

The typed envelope every AgentEventBus event carries: identity, timing, parent/session linkage, and the payload slot the per-event payload map fills in. It is the shape observers and the Event→Log bridge read from.

## Requirements

### Requirement: Shared AgentEvent envelope

Every AgentEventBus emission SHALL use a shared serializable envelope with `type`, `ts` (epoch ms), `agentId`, optional `parentId`, optional `runId`, and a typed `payload` (no open `Record<string, unknown>` bag named `data`).

`runId` SHALL be the authoritative identity of the agent run an event belongs to. The bus SHALL resolve it from the owning agent when the emitter did not supply one (absent outside a run), and an explicit envelope value SHALL win. A retained replay is a snapshot of the past and SHALL NOT inherit the agent's current run. Consumers MUST NOT maintain their own run scope, so two consumers can never disagree about which run an event belongs to.

#### Scenario: Tool start carries typed payload

- **WHEN** the runtime emits `agent:tool-start`
- **THEN** the event SHALL include `ts`, `agentId`, and a `payload` with at least tool identity fields required by Event→Log and Session lifecycle consumers

#### Scenario: JSON round-trip

- **WHEN** an AgentEvent is JSON.stringify'd and parsed
- **THEN** TypeScript consumers SHALL be able to narrow on `type` and read `payload` without casting through `unknown` bags

#### Scenario: Run-scoped event carries its run id

- **WHEN** an event is emitted while an agent run is active
- **THEN** the envelope carries `runId`, and a recording consumer stamps the same value onto every entry it derives from the event

#### Scenario: Outside a run the field is absent

- **WHEN** an event is emitted during bootstrap or while the agent is idle
- **THEN** the envelope omits `runId` and consumers must not invent one

### Requirement: Discriminated payload map
The system SHALL define a payload type per `AgentEventType` (or an explicit empty payload) so emit sites are compile-time checked.

#### Scenario: Subagent completed summary
- **WHEN** `subagent:completed` is emitted
- **THEN** `payload.summary` SHALL be a string (existing Event→Log contract preserved under `payload` instead of `data`)

### Requirement: Session lifecycle uses the same event shape
The AgentSession `lifecycle` channel payload SHALL be the typed AgentEvent (or an equivalent thin wrapper that still exposes the same envelope fields) so Local and HTTP hosts share one wire shape.

#### Scenario: HTTP lifecycle SSE
- **WHEN** a remote Session client receives a `lifecycle` event
- **THEN** it SHALL deserialize the same envelope fields as an in-process Session subscriber

### Requirement: Layers stay separated
Domain Emitters (todos/usage/state/queues/plan/messages) SHALL remain internal typed `change`/`entry` streams. AgentEventBus SHALL remain the lifecycle/telemetry bus. App hosts MUST observe UI state via Session channels, not by subscribing to AgentEventBus.

#### Scenario: App does not need AgentEventBus
- **WHEN** the app runs Session-only
- **THEN** Footer/chat/plan UI SHALL update from Session channels without importing AgentEventBus subscription APIs
