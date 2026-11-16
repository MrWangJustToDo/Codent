# Tasks

## 1. stdio MCP under `--client-env`

- [x] 1.1 In `packages/acp/src/client-env.ts`, delegate `createMCPStdioTransport` to `fallback` when
      it exists (`McpStdioTransportConfig` from core's public entry), passing the transport object
      through unchanged so `getMCPTransportProcess` still names the same child. Verify:
      `validate-acp-client-env` — member present, config untouched, identical object, handle
      round-trips.
- [x] 1.2 Keep absence when the fallback cannot spawn (browser / WebContainer fallbacks): core
      feature-detects on member existence, so a defined-and-throwing member would flip detection to
      "supported". Verify: the same suite's "absent when the fallback cannot spawn one" check.
- [x] 1.3 State the corrected rationale (process ownership does not move with `--client-env`; a stdio
      server needs a duplex pipe ACP's `terminal/*` cannot give) and name what stays absent for the
      other reason (LSP / isolate need a local view of the workspace).

## 2. MCP elicitation

- [x] 2.1 Add `packages/acp/src/mcp-elicitation.ts`: `createMcpElicitation(caps, { client, timeoutMs })`
      → `{ hook, bind }`, or `undefined` when `caps.elicitation.form` is absent. `bind` takes the
      session BRIDGE (the hook reads `acpId` per call, so a fork needs no re-bind), the in-flight
      controller joins `session.pending` so cancel/close aborts it, and the request is RACED against
      the abort because the SDK does not settle a request when its `cancellationSignal` fires — it
      only sends `$/cancel_request`. Every path answers: no/closed session ⇒ `decline` (nothing sent),
      deadline/abort/rejection ⇒ `cancel`, and a late `accept` after a close is not consent.
- [x] 2.2 Add `buildMcpElicitationRequest` / `mapMcpElicitResult` to `permissions.ts`: server named
      when the message is missing, no invented `toolCallId`, MCP's URL mode declined instead of
      rendered as an empty form, an unknown string `format` dropped and `enumNames` → `oneOf`
      const/title (a validating client rejects the whole request otherwise), content only on `accept`,
      custom actions refused as `decline`. Verify: `zCreateElicitationRequest` parses the derived
      request, the un-normalized shape is shown to be REJECTED, and the four action mappings.
- [x] 2.3 Gate the hook on the host too: `AgentSessionHost.acceptMcpElicit` (absent = yes), declared
      `false` by `createRemoteAgentSessionHost`. Without it, a client advertising form elicitation made
      every `session/new` / `load` / `resume` throw on a remote-session plane (its `create` refuses a
      hook). Verify: `validate-acp-mcp` — a `makeHost({ acceptMcpElicit: false })` creates the session
      and is handed no hook.
- [x] 2.4 Supply the hook from `agent.ts`: `createOptions(..., mcpElicit)` plus
      `mcpElicitationFor(caps, host)` at `session/new` and `resumeSession` (fork's cold source goes
      through the latter). Verify: `validate-acp-mcp` — the hook is on the create options only for a
      client that advertises a form, on all three of `new` / `load` / `resume`; a hook call carries the
      created session id, the server's message and schema, returning its content; after the connection
      closes it still answers; and after a fork the question carries the CLONE's id.
- [x] 2.5 Export `McpElicitResult` from `@codent/core` (the hook's own return type was not nameable),
      and re-export the new helpers from `@codent/acp` so validators can drive them.
- [x] 2.6 Prove the core half end to end: `validate-acp-client-env-bootstrap` creates a session with
      `mcpElicit` and asserts the manager reports `isElicitationAvailable()`, next to the real stdio
      fixture server connecting.
- [x] 2.7 Add `packages/acp/scripts/mcp-stdio-fixture.mjs` — a ~90-line JSON-RPC MCP server over
      stdio (one `ping` tool, protocol version echoed from `initialize`) so §2.6 exercises a real
      handshake + `tools/list` instead of a spawn that merely fails differently. Diagnostics go to
      stderr; stdout stays protocol-only.

## 3. Docs

- [x] 3.1 `packages/acp/README.md`: `--client-env` bullets for stdio spawn ownership and for the
      elicitation round-trip, the package-layout row for `mcp-elicitation.ts`, the coverage-table row
      for `elicitation/create` (now also an MCP server's question), the known-limitation caveat about
      a client whose workspace lives elsewhere, and the fixture in the Validation section.
- [x] 3.2 No change to `packages/acp/src/bin.ts` help text: the flag's meaning is unchanged, only
      what it stops disabling.

## 4. Review fixes

- [x] 4.1 Timeout/cancel must settle locally (the SDK only sends a notification); a late `accept`
      after a close is `cancel`, not consent.
- [x] 4.2 The hook is gated on `acceptMcpElicit` so a refusing host never sees one.
- [x] 4.3 URL-mode requests are declined; unknown `format` / `enumNames` are normalized for ACP.
- [x] 4.4 `createChecker().check` prints its third argument on failure (it was silently dropped), and
      the bootstrap validator disposes the runtime in `finally` so a fixture child cannot outlive a
      failing run.
- [x] 4.5 README/spec statements corrected (closed ⇒ `decline`, `cancel` only for an in-flight
      request; "the machine running `codent acp`"; delta filed under `acp-session-mcp`).
