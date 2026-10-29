## MODIFIED Requirements

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
