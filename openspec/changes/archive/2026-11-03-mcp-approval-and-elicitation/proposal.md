## Why

Every MCP tool we register today runs **outside the approval system**, and our MCP client **advertises `elicitation` while registering no handler for it**. Both defects are invisible until an external server needs them, and both are already paid for: `@tanstack/ai-mcp@1.0.0` supports `needsApproval`, `toolFilter` and `onElicit`, and `McpManager` passes none of them.

The consequences are not theoretical. A third-party server can ship `run_command`-shaped tools that execute without a prompt, because `needsApproval` is never derived from the server's own `annotations`. And a server that asks the user anything — per-app authorization, a URL approval, a write confirmation — gets a client that declared the capability and then cannot answer, so the call fails opaquely or hangs. Wiring this is also the precondition for the computer-use backend work: every candidate server (Codex's `cua_repl`, LCU, `open-computer-use`) gates its first action behind elicitation.

## What Changes

- **Approval derived from server annotations.** MCP tools become approval-gated from the tool's `annotations` (`readOnlyHint` → no approval; `destructiveHint` → approval that even session auto-mode cannot skip; absent metadata → approval). This is the fail-closed default: "the server did not say it is read-only" is not evidence that it is.
- **BREAKING** — MCP servers that declare no annotations now prompt before their tools run. Users who want the old silent behaviour must opt in per server.
- **Per-server policy in config** (`.agents/mcp.json` / `.mcp.json`): `enabled` (skip a server without deleting its entry) and `approval: "annotations" | "always" | "never"` (default `"annotations"`).
- **Elicitation answered, or honestly refused.** A runtime-supplied `McpElicitHook` is registered as the `elicitation/create` handler. When no hook is present the client no longer advertises the `elicitation` capability, and an unexpected request fails closed with a diagnostic naming the server — never a silent hang.
- **`MCPInputRequiredError` becomes a readable failure.** A server that returns `input_required` produces a structured tool failure naming the server, the request kind (`form` / `sampling`) and the request body, so the model can ask the user and decide what to do instead of surfacing a generic exception.
- **`/mcp` reports the truth**: disabled and filtered servers, and whether elicitation is available in this runtime.
- **New validation**: `validate:mcp-client` drives an in-process fixture server (annotations, elicitation, `input_required`) so all four behaviours are asserted without a child process or a network.

Explicitly **not** in this change: resources/prompts mapping, task execution, tool-list hot reload, progress notifications, and the app/ACP UI that can actually answer an elicitation (the port ships with a fail-closed default; each host adopts it separately).

## Capabilities

### New Capabilities

- `mcp-client-integration`: how the runtime connects to external MCP servers — which tools reach the model, what gates them before execution, what capabilities the client may claim, and what a server's request for user input does to a tool call.

### Modified Capabilities

<!-- None: `tool-approval-resume` already defines how an approval-gated tool call is recorded and resumed;
     this change only feeds that mechanism from MCP annotations. No requirement there changes. -->

## Impact

- **Code**: `packages/core/src/agent/mcp/manager.ts` (policy + elicitation + error mapping), `types.ts` (per-server config), `config.ts` (schema plumbing), `extension.ts` (`/mcp` output), `index.ts` (exports for the hook type), `packages/core/src/runtime-types/mcp-status.ts` (status shape).
- **Behaviour**: existing MCP setups get approval prompts on first use of a non-read-only tool; users can restore silence per server with `approval: "never"` or globally defer with session auto-mode (which still cannot skip `destructiveHint`).
- **Tests**: new `packages/core/scripts/validate-mcp-client.mjs` + fixture, registered in the core `validate:all` aggregate.
- **Docs**: the MCP paragraph in `AGENTS.md` (and the package README pointer) gains the policy fields and the elicitation contract.
- **Dependencies**: none added — every capability used ships in the already-pinned `@tanstack/ai-mcp@1.0.0`.
