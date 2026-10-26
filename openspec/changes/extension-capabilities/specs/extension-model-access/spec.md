## ADDED Requirements

### Requirement: One-shot completions from an extension

`ctx.llm` SHALL provide a one-shot completion that takes a **message list** (a single `prompt` is
allowed as a shorthand for one user message) plus optional `system`, and returns text. It MUST run
outside the agent loop: no tools, no transcript entry, no session channel.

A structured form SHALL accept a Zod schema and return the schema-validated value. It SHALL reuse
the internal one-shot query port (structured request, capability fallback, text-mode contract
rendering) instead of re-implementing them; a reply that fails validation SHALL reject the call,
never be repaired.

#### Scenario: Text completion

- **WHEN** an extension completes `{ prompt: "summarize: …" }`
- **THEN** it receives text
- **AND** no message, tool call, or transcript entry is produced

#### Scenario: Multi-message request

- **WHEN** an extension passes a `messages` list
- **THEN** the request is sent as that conversation, preserving roles and order

#### Scenario: Structured completion

- **WHEN** the schema form is called
- **THEN** the resolved value satisfies the schema
- **AND** an invalid reply rejects the call

#### Scenario: No transcript side effects

- **WHEN** any completion runs during a run
- **THEN** the run's wire, UI channel and session log are unchanged by it

### Requirement: Model selection stays inside the session connection

The completion MAY name a `model`. The name SHALL be resolved against the catalog of the session's
own runtime (one connection, one credential set); an unknown name SHALL reject with a typed error
rather than falling back silently. An extension MUST NOT be able to introduce a provider, a base
URL, or an API key through this API.

The default model is the one the session is using.

#### Scenario: Same model by default

- **WHEN** the caller omits `model`
- **THEN** the session's current model is used, via the same connection as the run

#### Scenario: Another catalog entry

- **WHEN** the caller names a model the session catalog offers
- **THEN** that model is used over the same connection
- **AND** its capability metadata still selects structured vs. text mode

#### Scenario: Unknown or unreachable model

- **WHEN** the caller names a model the catalog does not offer, the catalog offers it only on another
  connection (style, base URL, or a different key), or the runtime carries no catalog
- **THEN** the call rejects with a typed error
- **AND** no request is issued

#### Scenario: Model listed by several entries

- **WHEN** two catalog entries offer the model and one of them is the session's connection
- **THEN** that entry is used, regardless of catalog order

#### Scenario: No credential smuggling

- **WHEN** an extension supplies URL, style, or key fields
- **THEN** the API rejects them (the shape does not accept them)

### Requirement: Usage attribution is automatic

Every completion SHALL add its token usage to the owning session's usage tracker — no tracker,
total, or flag is passed by the caller, and no API exists through which a caller can opt out.
A call that fails after the provider reported usage SHALL still be accounted for.

Attribution SHALL use the same per-sample accounting as core-side side queries, so an extension
completion, a memory selection, and a session title are indistinguishable in the session totals.

#### Scenario: Tokens reach the totals

- **WHEN** a completion reports N prompt / M completion tokens
- **THEN** the session's usage total increases by N and M
- **AND** the per-call usage record is written as for any other side query

#### Scenario: Failed-but-billed

- **WHEN** a structured call fails validation after the provider reported usage
- **THEN** the usage is still recorded

### Requirement: Completions are abortable and typed

A completion SHALL accept an `AbortSignal`; when omitted it SHALL use the run's signal from the
context. Aborting SHALL reject with the runtime's abort error, and MUST NOT tear down the extension
or the run.

When no text adapter can be resolved — including a host whose connection is not configured — the call
SHALL reject with a typed error the caller can catch and degrade from; the run SHALL be unaffected.
A signal that is already aborted SHALL reject before any request is issued.

#### Scenario: Abort mid-flight

- **WHEN** the run is aborted while a completion is in flight
- **THEN** the completion rejects as aborted
- **AND** the extension stays active and its other handlers keep working

#### Scenario: No adapter

- **WHEN** the session has no resolvable connection
- **THEN** the call rejects with a typed "no adapter" error
- **AND** the run continues normally

### Requirement: Spend guardrails

The runtime SHALL bound extension spend: a default `maxOutputTokens` cap when the caller omits one,
and a per-run completion budget that fails closed with a typed error once exhausted. The budget is
keyed to the **user turn** (a tool phase does not reset it) and applies only while a run is in
flight; an idle completion (a command, an observer) is bounded by the output-token cap alone. Every
completion SHALL be recorded as a side query in the agent log with the calling extension id.

The budget SHALL be configurable per agent, and its refusal SHALL be reported as an extension
error so it is visible in the session log.

#### Scenario: Budget exhausted

- **WHEN** an extension exceeds the per-run completion budget
- **THEN** further calls reject with a typed budget error
- **AND** the refusal is reported once as an extension error with the extension id

#### Scenario: Default token cap

- **WHEN** the caller omits `maxOutputTokens`
- **THEN** the runtime's default cap applies to the request

#### Scenario: Attribution in the log

- **WHEN** any completion runs
- **THEN** the agent log records a side query carrying the extension id, model and token usage
