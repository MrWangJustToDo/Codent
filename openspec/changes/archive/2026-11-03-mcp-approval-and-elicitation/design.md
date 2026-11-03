## Context

`McpManager` (`packages/core/src/agent/mcp/manager.ts`) uses three of `@tanstack/ai-mcp`'s surfaces: `createMCPClient({ transport, name, prefix })`, `client.tools()`, and `client.instructions`. Everything else the package offers is unused, including the two things this change needs:

- **Policy**: `MCPClientOptions.toolFilter` / `needsApproval` / `toolName` (`packages/…/@tanstack/ai-mcp/src/client.ts:90-93`), applied when a tool is wrapped (`tools.ts:681-684` sets `needsApproval = true` on the tool).
- **Elicitation**: `connectTransport(options, onElicit)` registers the `elicitation/create` request handler (`client.ts:312-316`), and `OnElicit` is typed at `client.ts:777-779`.

Two facts about the current state drive the design:

1. **We already claim elicitation.** `client.ts:286-290` declares `elicitation: { form: {} }` and `sampling: {}` by default and lets `clientOptions.capabilities` override them. We pass no `clientOptions`, so every session advertises a capability it cannot answer. The repo's standing rule — a capability we cannot serve must not be declared — is violated today by construction.
2. **`input_required` already throws.** `throwIfInputRequired` (`tools.ts:443-466`) converts a spec-2026 `tools/call` result into `MCPInputRequiredError('form' | 'sampling', body)`, and a spec-2025 *task* that needs input is cancelled and thrown as a plain `Error` (`tools.ts:325-332`). So the failure modes already exist; what is missing is that they reach the model as a generic tool exception nobody can act on.

Constraint: `McpManager` is built by the agent factory and wrapped by the MCP extension (`extension.ts`), which registers each server tool through `ctx.registerTool`. Whatever gate we choose has to work through that path so the TUI, ACP and remote sessions all see the same approval.

## Goals / Non-Goals

**Goals:**

- An MCP tool's approval requirement comes from the tool's own annotations, with a per-server override, expressed through the mechanism built-in tools already use.
- The client advertises `elicitation` only when it can answer it, and never leaves a request unanswered.
- A server's request for user input produces a tool result the model can read and act on, never a hang and never an opaque exception.
- All four behaviours are asserted by a script that needs no child process and no network.

**Non-Goals:**

- Implementing the host-side UI that answers an elicitation. The port ships with a fail-closed default; the TUI and ACP adapt it in their own changes.
- Making `destructiveHint` immune to session auto-mode. Auto-approval is one session-wide decision (`mode-coordinator.shouldAutoApprove()`), and carving out an exception for one tool family would make built-ins and MCP tools disagree. Recorded as a follow-up.
- Resources, prompts, task execution, tools/list hot reload, progress notifications, `server/discover` caching (P1/P2 of the audit).
- Answering `sampling`. This runtime has no sampling handler and this change does not add one.

## Decisions

### 1. Derive approval inside the client policy, not by wrapping `execute`

`createMCPClient` receives `needsApproval` and `toolFilter`; the SDK stamps `needsApproval: true` on the resulting tool.

- **Why**: the approval flag must exist on the tool *definition*, because that is what the approval table, the TUI prompt, the ACP `session/request_permission` mapping and plan-mode withholding all read. A wrapper that intercepts `execute` would be a second, invisible approval mechanism.
- **Alternative rejected**: wrapping each tool's `execute` ourselves. It would prompt in the tool body — after the decision point — and would not appear in `session.toolDescriptors` or plan-mode filtering.

### 2. Gate by default; treat annotations as claims, not proof

Rule, in order:

1. `approval: "never"` → no gate (explicit user choice).
2. `approval: "always"` → gate.
3. `destructiveHint: true` → gate.
4. `readOnlyHint: true` → no gate.
5. Otherwise → gate.

`destructiveHint` beats `readOnlyHint` when a server sets both, because a server that contradicts itself is not evidence of safety.

- **Why fail-closed**: the alternative (gate only when `destructiveHint` is set) hands the decision to the server. A server that omits annotations — including one that is merely old — would run unprompted.
- **Cost**: existing setups start prompting. Mitigations are per-server `approval: "never"`, session auto-mode, and a release note.

### 3. Elicitation is an injected port, and the claim and the handler are one decision

```ts
export type McpElicitHook = (input: {
  server: string;
  params: unknown; // ElicitRequest["params"] — kept opaque so core does not pin the spec revision
}) => Promise<"accept" | "decline" | "cancel" | { action: "accept"; content?: Record<string, unknown> }>;
```

`McpManager` takes it as a constructor option (`McpManagerOptions.elicit`, reached from a host through `AgentSessionCreateOptions.mcpElicit`). **Hook present ⇒ advertise `elicitation` and register the handler. No hook ⇒ declare nothing and register nothing.**

The conditional handler is not a shortcut, it is a constraint measured against `@modelcontextprotocol/client` 2.3.1: `setRequestHandler("elicitation/create")` throws `CAPABILITY_NOT_SUPPORTED` (`Client does not support elicitation capability (required for elicitation/create)`) when the capability is not declared. Wiring a handler under an honest handshake would therefore fail **every** MCP connection at construction — the opposite of fail-closed. Without a hook, a server that asks anyway receives that protocol error as its answer: still an answer, the request terminates, and the tool call fails with it rather than parking.

- **Why a port, not a core implementation**: answering means showing UI, and the UI lives per host (TUI select, ACP `elicitation/create`, extension side panel). Core's `ask_user` is a *client tool the model calls* — there is no in-process "ask the user" function a tool body can call, so inventing one here would be a new interaction channel dressed as a hook.
- **Why `unknown` params**: the elicitation schema is versioned by the spec; hosts narrow it. Core must not import a spec revision to type it.
- **Known limit (host contract, not a bug)**: nothing in core bounds the hook's own wait. A host whose UI never answers parks that `tools/call` until the run is aborted; the abort rejects the tool call, but the pending request outlives the turn. Hosts must resolve the hook under the same interaction timeout they use for approvals — the port has no per-call context to carry a signal.

### 4. Capability truthfulness: `undefined` is the only way to withdraw a default

The SDK builds `{ elicitation: { form: {} }, sampling: {}, ...clientOptions?.capabilities }` — its defaults come **first**. A spread cannot delete a key, so `{ capabilities: { sampling: {} } }` changes nothing: `JSON.stringify` still yields `{"elicitation":{"form":{}},"sampling":{}}`. An own key whose value is `undefined` does overwrite the default, and JSON drops that member, so `{ capabilities: { elicitation: undefined } }` is the only spelling that withdraws the claim. `sampling` stays declared (the SDK default; this change neither adds nor removes that ability).

`validate:mcp-client` mirrors that merge and serializes the result, **and** asserts the installed SDK still holds those defaults — otherwise the mirror would drift from upstream and keep passing while the handshake changed.

### 5. `input_required` maps to a readable tool failure

The tool wrapper that already re-wraps MCP `execute` for multimodal content gains a sibling concern: catch `isMCPInputRequiredError(error)` and **throw** a normalized `Error` whose message names the server, the kind and the request body:

- `form` → `MCP tool "<server>" needs user input before it can continue — ask the user, then retry. Request: <body>`.
- `sampling` → `MCP tool "<server>" asked for a model sampling request, which this runtime cannot answer. Request: <body>`.

- **Why throw rather than return a result**: the call genuinely did not complete, and the tool row must say so; a returned result would render as a success the model can misread. The run loop already converts a thrown tool error into the model-visible failure text, so the diagnosis reaches the model either way — what is preserved is the *distinction*, carried by wording that names the server and the kind rather than a generic "tool failed".
- **Why not retry automatically**: answering a spec-2026 `input_required` requires resuming a server-side task, which is task support — out of scope. The honest outcome is a clear "this server wants input" the model can resolve with `ask_user` and a new call.

### 6. Config and status stay additive — and one bad entry costs one server

`mcpServerConfigSchema` gains `enabled` and `approval` (z.enum, so an unknown value fails with the accepted set). `McpServerStatus` gains `enabled`, `approvalMode`, and the session-level `elicitation` availability is reported once in the `/mcp` header. No existing field changes meaning, so old config files keep loading.

`loadMcpConfig` parses the **envelope** loosely and each server strictly. Validating the whole document with `mcpConfigSchema` made one typo (`"approval": "alwayss"`) throw for the file: `loadMcpConfig` returned null, the extension returned before registering anything, and every MCP tool disappeared from that session with only a `warn` to explain it — while the per-server `failed` row the manager already had was unreachable from the file path. The policy fields are now checked first, through `resolveServerPolicy` itself, because inside a stdio|http union zod reports a bad enum as a generic `invalid_union`; the error names the server, the value and the accepted set, and the neighbours still connect. (Follow-up: those rows could be surfaced in `/mcp` as `failed` instead of only in the log.)

`McpServerStatus` rows are also normalized at their producer: a rejected policy value leaves `approvalMode` at the documented default and puts the offending value in `error`, because a session-supplied config arrives through an untyped route and echoing it would print `approval=42`.

### 7. Validation drives the real wiring, not a fixture server

`validate:mcp-client` asserts the object the manager actually sends (`mcpClientOptions`) rather than a copy of its wiring, and drives `McpManager.initialize` for the cases that decide before any transport exists. It deliberately does **not** stand up a fixture MCP server over `InMemoryTransport`: `McpManager` builds its transport from config (`createTransportInput`), so a fixture would have to be reached through a second client construction inside the test — i.e. a replica of the wiring under test. What is asserted instead:

- policy derivation and the approval matrix (pure functions the manager calls);
- the capability set and the elicit handler on the exact options object, mirroring the SDK's own merge and **pinning the mirror** against the installed SDK, plus the invariant that the claim and the handler never split (§3);
- `input_required` mapping for both kinds;
- `formatMcpStatus` — the `approval=` column, the disabled glyph/count, the failure line and the elicitation line, since `/mcp` is the only place a user reads this;
- `initialize` skipping a disabled server and failing an unusable policy, with the status rows;
- `loadMcpConfig` keeping a healthy server when a neighbour is invalid (`validate-mcp-session-servers`);
- **the dependency patch is still installed** — the handler reaches `connectTransport`, the option is typed, the SDK stamps the approval flag, and the patch is declared in `pnpm-workspace.yaml` with its file present. Without that last group every other elicitation assertion would describe an option the client ignores, and `pnpm install` silently restores the published file.

Teeth were confirmed by mutation: inverting the fail-closed default and reintroducing the withdrawn-capability spelling each turned the run red (`1 check(s) failed`), and restoring them turned it green. The second mutation is the reason the capability assertion mirrors the SDK's merge rather than inspecting our own input object — the first draft did the latter and stayed green while the handshake still claimed elicitation.

## Upstream status (checked 2026-11-03)

- **No issue or PR asks for an `onElicit` option on `createMCPClient`.** `@modelcontextprotocol/client`-backed `connectTransport(options, onElicit)` exists and is what upstream itself uses — but only from `harness-plugin.ts` (`elicitFor`) and `connector.ts`, i.e. through the `mcp()` harness plugin / `mcpConnector()`, not through the plain `createMCPClient` + `tools()` path this repo uses. `connectTransport` is **not** in the package's export map (`exports` has `.`, `./stdio`, `./apps`, `./server`, `./server/stdio`, `./connector`, `./harness`, `./events`), so a deep import would throw `ERR_PACKAGE_PATH_NOT_EXPORTED` at runtime rather than work by luck. `latest` on npm is still `1.0.0`, and `main` still calls `connectTransport(options)` from `createMCPClient`.
- **So the patch mirrors upstream's own seam.** It changes `connectTransport(options)` → `connectTransport(options, options.onElicit)`; the day the option is exposed, the patch and its `patchedDependencies` entry are deleted with no call-site change (design §Migration Plan).
- **Follow-up that re-opens the capability decision:** upstream's newer work has `@tanstack/ai`'s `chat()` turn a spec-2026 `input_required` into an `mcp_input` interrupt answered by the host (`resolveInterrupt`). That is *not* in the pinned `@tanstack/ai` 1.0.1 — nothing in this repo or in that version's types knows `mcp_input` — which is exactly why "do not advertise what we cannot answer" plus a readable failure is the honest pair today. When the dependency gains interrupts, revisit both halves together, or the client would keep refusing input the runtime could then actually collect.

## Risks / Trade-offs

- **[Existing MCP setups start prompting]** → per-server `approval: "never"`, session auto-mode, and a release note that names the new default.
- **[Annotations are server-claimed; a hostile server can say `readOnlyHint`]** → `destructiveHint` wins on conflict; `approval: "always"` is the switch for untrusted servers; the spec states annotations are hints, not guarantees. Trust policy for `instructions` text stays a P2 item.
- **[Capability omission]** → measured, not assumed: the SDK spreads its defaults first, so only an `undefined` own key withdraws `elicitation`; the validator mirrors the merge and pins it against the installed SDK, and asserts the claim and the handler never split (a handler under an unadvertised capability throws `CAPABILITY_NOT_SUPPORTED`, which would break every connection).
- **[A hook that never resolves would hang a tool call]** → a throw becomes `decline`; the wait itself is the host's contract (the port has no per-call context to carry a signal), so hosts must resolve it under their approval timeout. Recorded in §3, not enforced here.
- **[`input_required` from a spec-2025 task is still unsupported]** → that path throws the SDK's own plain `Error` (which does say the client cannot answer a 2025 task input request, but does not name the server); mapping it needs task support, so it is deferred rather than half-done. `form` / `sampling` are mapped.
- **[Silent divergence if a host shows the prompt but core never sees the answer]** → the port returns the answer to the SDK; core never caches it, matching the "no permission cache" stance.

## Migration Plan

1. Land core + validation (no config change required; defaults take effect).
2. **Temporary dependency patch.** `@tanstack/ai-mcp` 1.0.0 declares the `elicitation` capability but offers no way to register a handler (`createMCPClient` calls `connectTransport(options)` without the second argument). `patches/@tanstack__ai-mcp@1.0.0.patch` threads `options.onElicit` through and types it; `pnpm-workspace.yaml` pins it to `1.0.0`. **Delete the patch and its `patchedDependencies` entry as soon as an upstream release exposes the option** — `validate:mcp-client`'s patch group is what fails if the patch is dropped without the replacement.
3. Release note: MCP tools without `readOnlyHint` now prompt; how to opt out per server.
4. Hosts adopt `McpElicitHook` in their own changes (the port is already reachable: `AgentSessionCreateOptions.mcpElicit` → `ManagedAgentConfig.mcpElicit` → `McpManager`); until a host supplies one, `/mcp` reports elicitation as unavailable, which is the truth.
5. Rollback: reverting the manager change restores silent MCP tools and the (false) elicitation claim — no data migration either way.

## Open Questions

- Which host adopts the elicit hook first — the TUI (a confirm/select reusing the approval row) or ACP (`elicitation/create`, already implemented for `ask_user`)? ACP is closer; the TUI affects the most users.
- Should `sampling` ever be answered (it means running a model call on behalf of a server)?
- After this lands, is `readOnlyHint` trustworthy enough to also skip *plan-mode* withholding for MCP tools, or does plan mode stay fail-closed regardless of annotations?
