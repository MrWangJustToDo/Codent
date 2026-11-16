## Context

`codent acp` serves an editor over ACP. Two of its planes were unrelated to MCP and both were wrong in
the same direction — they withheld something the local fallback could have provided:

- `createAcpClientEnv` (`packages/acp/src/client-env.ts`) builds the `CoreEnv` when `--client-env` is
  on: fs and argv are routed to the client, everything else comes from a local fallback. It omitted
  `createMCPStdioTransport`, on the reasoning that a stdio server "needs a local process runtime the
  client cannot provide".
- `agent.ts` never passed `mcpElicit` to `Host.create`, so core advertised no `elicitation` capability
  to any MCP server.

Both omissions are load-bearing in core: `McpManager` **throws** when the env has no stdio transport
(`agent/mcp/manager.ts:87`) and declines to advertise `elicitation` without a hook. So the first was
not a degradation, it was "MCP is unavailable", and the second was "every server tool that needs user
input fails".

Three facts constrain the fix:

1. **A stdio transport cannot cross the wire.** It needs a duplex pipe (JSON-RPC to the child's stdin,
   replies on its stdout), and ACP's `terminal/*` has no stdin write. The client can never provide one.
2. **Supplying the hook IS the capability claim.** Core's whole opt-in is the hook's presence; a hook
   that always declines would advertise a capability we cannot render.
3. **The ACP SDK does not settle a request when it is cancelled.** `prepareRequest`'s `cancel` only
   sends `$/cancel_request` and leaves `response` pending until the peer answers or the connection
   closes (`@agentclientprotocol/sdk` `dist/jsonrpc.js`). Treating an abort as "the request ended" is
   how a server's tool call gets parked forever.

## Goals / Non-Goals

**Goals:**

- A configured stdio MCP server connects under `--client-env`, spawned by this process, with zero
  client requests.
- An MCP server's `elicitation/create` reaches the client as one ACP form, and its answer comes back in
  MCP's vocabulary — on every path that builds an agent.
- No path hangs: a question is answered `decline` or `cancel` rather than left pending, whatever the
  client does.
- Supplying the hook is always truthful: never to a client that cannot render a form, never to a host
  that refuses one.

**Non-Goals:**

- A server whose workspace lives on another machine. The spawn is local by construction; making that
  case work is a deployment question (and the previous behaviour, withholding the member everywhere,
  did not serve it either).
- Relaying MCP's URL-mode elicitation. ACP has a URL mode, but the flow needs a client capability we
  do not gate on; declining is the honest answer.
- Answering `elicitation` during the MCP handshake (no ACP id exists yet — see decisions).
- Changing how `ask_user` works: it already owns the form/text dual path and its own timeout.

## Decisions

### 1. Forward the fallback's spawner; keep absence where absence is the truth

`createMCPStdioTransport` is delegated to the fallback when the fallback has it, and the transport
object is passed through **unchanged** rather than wrapped.

- **Why unchanged**: `getMCPTransportProcess` identifies the child by object identity, so a wrapper
  would make the manager unable to kill the server it started.
- **Why still absent when the fallback cannot spawn**: core feature-detects on member presence, so a
  defined-and-throwing member would flip detection to "supported" and fail later, further from the
  cause.
- **LSP / code-mode isolate stay absent**, for a different reason that the comment now states: they
  answer from a local *view of the workspace*, which is the client's, not this disk.

### 2. Two conditions gate the hook, because the claim is the hook

`mcpElicitationFor(caps, host)` returns a channel only when the client advertises
`elicitation.form` **and** the host accepts one: a new optional `AgentSessionHost.acceptMcpElicit`,
which `createRemoteAgentSessionHost` declares `false`.

- **Why the second condition exists**: the remote session host's `create` throws on `mcpElicit` (a hook
  is executable code and cannot be serialized). Gating on the client capability alone turned every
  `session/new` / `load` / `resume` on that plane into an error for any editor that supports
  elicitation — a working configuration broken by a fix for a capability that plane cannot have
  anyway. The flag is additive and absent means "accepts", so no existing host changed.
- **Alternative rejected**: try/catch around `create` and retry without the hook. It matches on an
  error message, and it would hide a real refusal behind a silent retry.

### 3. Bind to the bridge, read the handle per call

`bind()` takes the session bridge, and the hook reads `bridge.acpId` and `bridge.closed` on every call.

- **Why**: MCP servers connect inside `host.create`, so the hook must exist before the session does;
  `/new` then keeps the ACP handle while the disk id changes, and `session/fork` re-keys the *same*
  bridge. Reading per call makes all three cases structurally correct, and removes the fork re-bind that
  a later edit could drop (it is the kind of line whose deletion no other assertion notices).

### 4. End locally: race the request, and never credit a late answer

The deadline and any abort are raced against `client().request(...)`, exactly as `interactions.ts`
already does for `ask_user`; the `cancellationSignal` is still passed so a cooperative client closes its
dialog.

- **Why**: fact 3 above. An abort-only implementation is correct against a client that honours it and
  hangs against one that does not, and the SDK gives no help either way.
- **Consequence asserted**: the validator's timeout case uses a client that *ignores* the signal and
  never resolves — the shape that made the first implementation hang.
- **Consent is time-bound**: if the session closed or the request was aborted while the form was open,
  a submitted `accept` becomes `cancel`. The server is gone or its run is over; forwarding values would
  be an answer to a question nobody is waiting for.

### 5. Normalize only what ACP validates more strictly, and decline what a form cannot express

The server's `requestedSchema` travels through, except:

- an unknown string `format` is dropped (ACP defines `email` / `uri` / `date` / `date-time`, and its
  zod schema fails the WHOLE request otherwise — the user would see nothing at all);
- `enumNames` becomes `oneOf` const/title, so option labels are not stripped down to bare values;
- `type` is forced to `object` (the schema ACP requires), and a non-object schema becomes an empty form;
- `mode: "url"` is declined: there is no form to render, and an empty one asks for values nobody reads.

Both rewrites are "restore the request a validating client accepts", not "improve the server's schema",
so each is asserted against the un-normalized shape as well as the normalized one.

### 6. Verify with a real process, not a double

`validate-acp-client-env-bootstrap` runs a real `CodentAgent` and spawns a real stdio MCP server
(`scripts/mcp-stdio-fixture.mjs`), asserting `connected` + tool count. A fake transport would have
proved nothing about the class of failure being fixed (the member's absence), and the fixture is also
the only way to prove the elicit hook reaches the manager — `isElicitationAvailable()` is what decided
the MCP handshake.

Each behaviour was mutation-checked: restoring the omission, dropping the race, dropping the
`session.closed` guard, dropping the host gate, and skipping the hook on `resume` each fail a named
assertion.

## Risks / Trade-offs

- **A question asked before the bridge exists is declined without a diagnostic.** Servers ask from tool
  calls in practice, and the alternative (parking `host.create` until an id exists) deadlocks
  `session/new`. Recorded rather than hidden.
- **The hook lives longer than the connection.** It closes over the bridge, so after a client quits it
  answers `decline`; the alternative — a lookup that returns nothing — answers the same, one step later.
- **A client that ignores `$/cancel_request` keeps its dialog open** while we have already told the
  server `cancel`. Unavoidable without a client-side round-trip, and strictly better than the server
  waiting forever.
- **URL-mode requests from a non-compliant server are refused.** Core advertises form-only, so this is
  defensive; a server that needs a URL flow cannot be served through a form.
- **`stdout` of the fixture is protocol-only**, so a failed handshake is silent unless diagnostics go to
  stderr — which they now do.

## Migration Plan

No migration: the interface member is optional and absent means "accepts", the env member is forwarded
only when the fallback has it, and the hook is supplied only in configurations that previously received
none. `packages/acp/src/bin.ts` help text is unchanged — the flag's meaning did not change, only what it
stops disabling.

## Open Questions

- Should ACP relay MCP's URL mode once we gate on a client capability for it? Deferred: it needs a
  client capability we cannot yet verify, and a wrong guess would send users to a URL the client cannot
  surface.
- Should `imageToText` be forwarded too? It serves the terminal preview pane, which this host does not
  render; if a future ACP panel does, the same "omission removes vs degrades" test decides it.
