## ADDED Requirements

### Requirement: Provider registry defines providers as data

The websearch layer MUST define every search provider through a single ordered registry that
carries the provider name and a factory for the configured transport, and `ProviderManager` MUST
be populated from that registry. Which configuration field holds a provider's API key MUST live
in one key-wiring map consumed by `ProviderManager.configure` (not duplicated across selection
and transport code). Adding a provider MUST require adding one provider module plus one registry
entry (and, when it accepts a key, one key-wiring entry), and MUST NOT require editing selection
or fallback logic.

#### Scenario: Registry is the single source of registration order

- **WHEN** the websearch providers are initialized
- **THEN** `ProviderManager` registers exactly the providers declared by the registry, in the registry's order

#### Scenario: Key wiring is a single map

- **WHEN** a provider accepts an API key
- **THEN** its config field is declared once in the key-wiring map, and `ProviderManager.configure` reads a key from that field without a per-provider switch

#### Scenario: A keyed and a free provider coexist

- **WHEN** the registry declares a provider that is free (no key) and a provider that requires a key
- **THEN** both are registered, and the key-requiring provider reports unavailable until its key is configured

### Requirement: Provider transport is selected by API key presence

A provider that supports both an official API and a free public endpoint MUST expose a single
`SearchProvider` whose `search` uses the official API when its API key is configured and the
free public endpoint otherwise. `isAvailable` MUST be true when either transport exists, and
MUST be false when the provider requires a key and none is configured.

#### Scenario: Keyed transport is used when a key is present

- **WHEN** a provider with a configured API key performs a search
- **THEN** the request targets the provider's official API endpoint and carries the key

#### Scenario: Free transport is used without a key

- **WHEN** the same provider performs a search with no API key configured
- **THEN** the request targets the provider's free public endpoint and carries no key

#### Scenario: Key-only provider is unavailable without a key

- **WHEN** a provider that has no free transport has no API key configured
- **THEN** it reports unavailable and is never selected

### Requirement: Selection order and free-provider spreading

Provider selection MUST resolve in this order: an explicit `provider` preference when that
provider is available; otherwise a provider whose API key is configured (a configured key is a
deliberate choice of the official, higher-quality transport, so it MUST win over the free pool
and MUST NOT be swallowed by spreading); otherwise, when more than one free (no-key) provider is
available, a provider chosen deterministically from the session id (so different sessions spread
across the free providers while one session stays on a single provider); otherwise the first
available provider; otherwise the last registered provider. Explicit and automatic selection MUST
NOT pick a provider that reports unavailable.

#### Scenario: Explicit preference wins

- **WHEN** `provider` names an available provider
- **THEN** that provider is selected regardless of registration order

#### Scenario: Configured key wins over the free pool

- **WHEN** a provider's API key is configured and a session id is set so the free-provider spread would pick a different provider
- **THEN** the keyed provider is selected (the configured key is not ignored)

#### Scenario: Free providers are spread deterministically by session

- **WHEN** two different session ids select with at least two free providers available, no explicit preference, and no configured keys
- **THEN** the selection is a pure function of the session id, and repeated selection for the same session id yields the same provider

#### Scenario: Unavailable provider is skipped

- **WHEN** a provider reports unavailable
- **THEN** it is never chosen by explicit or automatic selection

### Requirement: Failure fallback across providers

When the selected provider throws during a search, the manager MUST try the remaining
available providers in registration order and return the first success, reporting the provider
that actually produced the results. A user abort MUST NOT trigger fallback: the abort MUST
propagate to the caller unchanged and MUST NOT be masked as an all-providers-failed error.

#### Scenario: Fallback returns the working provider

- **WHEN** the selected provider throws and a later available provider succeeds
- **THEN** the search result is returned with the succeeding provider's name

#### Scenario: All providers failing surfaces one error

- **WHEN** every available provider throws
- **THEN** the manager throws a single error naming the last failure

#### Scenario: User abort is not a fallback

- **WHEN** the run's abort signal is aborted while a provider search is in flight
- **THEN** the abort is rethrown and no other provider is tried

### Requirement: Provider API keys are honored from configuration

The tool configuration MUST accept per-provider API keys — at minimum `braveApiKey` (Brave,
existing), `EXA_API_KEY`, `PARALLEL_API_KEY`, and `TAVILY_API_KEY` — supplied by the host, and
MUST NOT read them from `CoreEnv` environment maps inside core.

#### Scenario: Per-provider key enables its official API

- **WHEN** the host supplies an Exa API key in the tool configuration
- **THEN** the Exa provider uses its official API transport for searches

#### Scenario: Core does not read keys from the environment

- **WHEN** a provider key exists only as a `CoreEnv` environment variable and not in the tool configuration
- **THEN** the provider treats itself as having no key

### Requirement: `models.json` tool configuration is applied

The agent host MUST apply the websearch `toolConfig` from `.agents/config/models.json`'s
`global.toolConfig` to the agent's tool configuration, using a single field name `provider`
for the preferred provider. The host/CLI-provided `toolConfig` MUST take precedence over the
file per field, and a legacy `websearchProvider` key in the file MUST still be read and mapped
to `provider`.

#### Scenario: File provider preference is applied

- **WHEN** `models.json` sets `global.toolConfig.provider` and the host supplies no provider
- **THEN** the agent's tool configuration carries that provider

#### Scenario: Host value overrides the file

- **WHEN** both the host and `models.json` set the provider
- **THEN** the host value is used

#### Scenario: Legacy key is still read

- **WHEN** `models.json` uses the legacy `websearchProvider` key
- **THEN** it is read as the preferred provider and rewritten as `provider` on the next save

### Requirement: Remote-session create carries tool configuration

The agent-session server's `POST /api/agent` create request MUST accept an optional
`toolConfig` field and forward it to `host.create`, so a remote-session client can supply
websearch keys and provider preference to the server-side agent loop.

#### Scenario: Remote-session create forwards tool config

- **WHEN** a client creates a remote agent session with a `toolConfig` body field
- **THEN** the created server-side agent receives that tool configuration

#### Scenario: Absent tool config keeps server default

- **WHEN** a client creates a remote agent session without a `toolConfig` field
- **THEN** the server-side agent uses its own default websearch configuration
