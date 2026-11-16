# Proposal

## Why

Under `--client-env`, MCP was not supported — not partially, entirely:

```
MCP servers (0/1 connected; elicitation unavailable (no elicit hook)):
✗ browsermcp stdio 0 tools approval=annotations npx @browsermcp/mcp@latest
└─ failed: Stdio MCP transport is not available in this environment.
```

Two independent causes, both in the client-backed env / session wiring rather than in core:

1. **No stdio transport.** `createAcpClientEnv` omitted `createMCPStdioTransport`, and core refuses
   a stdio transport outright when the member is missing (`agent/mcp/manager.ts`). The omission was
   deliberate — "needs a local process runtime that the client cannot provide" — but the conclusion
   does not follow: the *local fallback* is that runtime, and it was already being used for
   everything else the client cannot serve (free-text commands, background jobs, `.agents/**`).
2. **No elicitation.** `mcpElicit` was never passed to `Host.create`, so core advertised no
   `elicitation` capability to any MCP server. A server asking a question got a protocol error; `/mcp`
   said `elicitation unavailable (no elicit hook)`.

Neither is a degraded feature: the first removes MCP entirely, the second removes every server *tool*
that needs user input. And neither is fixed by the client, which is why the wiring belongs here.

## What Changes

- `createAcpClientEnv` forwards `createMCPStdioTransport` from the local fallback when the fallback
  has it (feature-detected, so a fallback with no process runtime keeps the previous absence).
  `getMCPTransportProcess` was already forwarded and stays the matching handle.
- `agent.ts` supplies a session's `mcpElicit` hook (`createMcpElicitation`) when the client advertised
  `elicitation.form` **and** the host accepts a hook at all, for every path that builds an agent —
  `session/new`, `load`, `resume`, and a fork's restored source. The host half is a new optional
  `AgentSessionHost.acceptMcpElicit`, declared `false` by the remote session host (a hook is
  executable code, so it cannot cross the wire); without it, any client advertising form elicitation
  made every `session/new` / `load` / `resume` throw on that plane.
- The hook is bound to the session bridge and reads its handle per question: ACP ids do not exist
  while `host.create` runs (where MCP connects), `/new` keeps the handle while the disk id changes, and
  a fork re-keys the same bridge — reading live covers all three without a re-bind to forget.
- Every path ends locally. A deadline or a cancel canNOT be trusted to end the request: the ACP SDK
  turns a `cancellationSignal` abort into a `$/cancel_request` notification and leaves the promise
  pending, so the request is raced against the abort (as `ask_user` already does). A question that
  arrives with no live session is declined without a request; one already in flight ends as `cancel`,
  and an `accept` submitted after the session closed is not treated as consent.
- New pure mapping (`buildMcpElicitationRequest` / `mapMcpElicitResult`) keeps the protocol
  translation testable without a transport. It rewrites the two fields ACP validates more strictly
  than MCP (an unknown string `format` is dropped, `enumNames` becomes `oneOf` const/title) because a
  rejected request means the user sees no form at all, and declines MCP's URL mode instead of
  rendering it as an empty form. `McpElicitResult` becomes part of core's public entry so a host
  implementing the hook can name its return type.
- LSP and the code-mode isolate driver stay absent, and the comment now says why plainly: they need
  a local *view of the workspace*, not merely a local process.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `acp-client-env`: "client 未声明的能力回退而非失败" gains the rule that an optional member the
  client can never provide — and whose omission *removes* a capability rather than degrading it — is
  forwarded from the local fallback (MCP stdio is that member; `readFileRange` / `rename` /
  `imageToText` keep their existing treatment, and LSP / isolate remain absent).
- `acp-session-mcp` (**ADDED requirement**): an MCP server's `elicitation/create` is routed to the
  client's elicitation surface — gated on the client's declared capability *and* the host accepting a
  hook — and always answered, with the fork/handle rule stated as read-per-call.

## Impact

- `packages/acp/src/client-env.ts` — stdio transport delegation + corrected rationale.
- `packages/acp/src/mcp-elicitation.ts` (new) / `permissions.ts` / `agent.ts` / `index.ts` — the
  hook, its two mappings, the schema/URL-mode normalization, and the create sites that supply it.
- `packages/core/src/agent-session/host-types.ts` — `AgentSessionHost.acceptMcpElicit` (optional;
  absent means yes). `packages/server/src/remote-session-host.ts` declares it `false` next to the
  guard that already refused the hook.
- `packages/core/src/index.ts` + `agent/mcp/index.ts` — export `McpElicitResult` (its own type was
  already the hook's return type; it simply was not nameable from outside).
- Validators: `validate-acp-client-env` (forwarded / absent pairs, transport identity),
  `validate-acp-client-env-bootstrap` (a REAL stdio MCP server connects; the hook reaches the
  manager), `validate-acp-elicitation` (mapping, schema normalization, and every driver path — the
  timeout case now simulates a client that IGNORES the abort, which is what the SDK does),
  `validate-acp-mcp` (the hook reaches `host.create` only when the client can answer *and* the host
  accepts one; it round-trips with the session id on `new`/`load`/`resume`; after a fork the question
  carries the clone's id), plus the new `scripts/mcp-stdio-fixture.mjs` (a real stdio MCP server, so
  the bootstrap run proves a connection rather than a non-refusal).
- `packages/acp/README.md` — what `--client-env` does and does not move, the elicitation rule, the
  deployment caveat for a client whose workspace lives elsewhere.
- Unchanged: the core guard stays the honest answer for a host with no process runtime (browser,
  WebContainer).

## Open Decisions

- **A client whose workspace is on another machine.** `codent acp` runs on the machine that launched
  it (over SSH or in a dev container, not necessarily the editor's), so "local" is that machine and
  the spawn is right for it. With a genuinely remote client the server runs here and sees this disk.
  Nothing in the env can detect that, and withholding the member everywhere (the previous behaviour)
  did not serve that case either — it removed the capability from every deployment. Recorded in the
  README instead of guessed at in code.
- **Elicitation during the MCP handshake.** A server that asks before the session exists is answered
  `decline` (there is no id to scope the form to). Servers ask from tool calls in practice; the
  alternative — parking the connect until an id exists — would deadlock `session/new`.
