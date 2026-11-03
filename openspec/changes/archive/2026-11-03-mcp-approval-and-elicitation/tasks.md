## 1. Config surface

- [x] 1.1 Extend `mcpServerConfigStdioSchema` / `mcpServerConfigHttpSchema` in `packages/core/src/agent/mcp/types.ts` with a shared base: `enabled?: boolean` (default true) and `approval?: z.enum(["annotations", "always", "never"])` (default `"annotations"`), keeping the stdio/HTTP union intact
- [x] 1.2 Add `resolveServerPolicy(config)` returning `{ enabled, approval }` with defaults applied, and make an unknown `approval` value fail with an error naming the server and the accepted values
- [x] 1.3 Skip `enabled: false` servers in `McpManager.initialize` before any transport work, recording them as `disabled` in `serverStatuses`
- [x] 1.4 Export the resolved policy type from `packages/core/src/agent/mcp/index.ts` (no new public `@codent/core` entry needed)

## 2. Approval policy

- [x] 2.1 Add `deriveNeedsApproval(tool, approvalMode)` implementing the ordered rule from design §2 (`never` → `always` → `destructiveHint` → `readOnlyHint` → gate); add the conflicting-annotations case (`destructiveHint` wins)
- [x] 2.2 Pass `needsApproval` into `createMCPClient` in `manager.ts`, **and forward the flag the client stamps onto each tool through `ctx.registerTool({ needsApproval })`**. The second hop is the one that makes the policy real: `isToolNeedsApproval` reads the registered definition, so a client-side flag alone is inert. (`toolFilter` deliberately not used — filtering which tools a server exposes is a separate concern and not P0.) Verified end to end: `toServerTools` stamps → wrapper spread preserves → registry → `defineServerTool` → tools record → `isToolNeedsApproval` → engine gate.
- [x] 2.3 Verify a gated MCP tool flows through the existing path unchanged: approval table record, TUI prompt, ACP `session/request_permission`, plan-mode withholding — chain read end to end (`defineServerTool` → `isToolNeedsApproval` → `agent-status-controller` → table/ACP projector) plus an assertion that the registered definition carries the flag (`validate-mcp-tool-presentation`). A live prompt is the host smoke in 7.4.
- [x] 2.4 Confirm session auto-mode still approves gated MCP tools (no exception carved out; matches design §2 non-goal) and note it in the release text

## 3. Elicitation

- [x] 3.1 Add `McpElicitHook` to `packages/core/src/agent/mcp/types.ts` (server name + opaque params → `accept` / `decline` / `cancel` / `{ action: "accept", content }`)
- [x] 3.2 Add an optional hook to `McpManager`'s constructor options; make the capability and the handler ONE decision — hook ⇒ advertise + register, no hook ⇒ neither (the SDK throws `CAPABILITY_NOT_SUPPORTED` for a handler on an undeclared capability, so a handler without the claim would break every connection). A throwing hook becomes `decline` plus a recorded error.
- [x] 3.3 Withdraw the SDK's default claim the only way the SDK allows: `clientOptions.capabilities = { elicitation: undefined }` (an own `undefined` key overwrites the spread default and JSON drops it; `{ sampling: {} }` — the first spelling attempted — changes nothing, measured). Assert the merge the SDK performs, not our own input object, and pin that merge against the installed SDK.
- [x] 3.4 Report a refusal where it happens: `McpManager.setDiagnosticSink` is installed by the extension at activation (live `logger.warn`) and the buffer is drained after `initialize` for hosts that install none. The buffer is capped, and `shutdown()` drops the sink so a force-killed teardown cannot keep logging through a dead `ctx`.
- [x] 3.5 Patch `@tanstack/ai-mcp@1.0.0` to thread `onElicit` into `connectTransport` (`patches/@tanstack__ai-mcp@1.0.0.patch`, pinned via `pnpm-workspace.yaml` `patchedDependencies`) and add the removal note to design §Migration Plan
- [x] 3.6 Make the hook reachable by a host, not just by validators: `AgentSessionCreateOptions.mcpElicit` → `ManagedAgentConfig.mcpElicit` → `AgentBootstrap` → `new McpManager(env, { elicit })`, and export `McpElicitHook` / `McpElicitAnswer` from the public entry so a host can type it

## 4. `input_required` mapping

- [x] 4.1 In the existing MCP tool wrapper (`prefer-multimodal-content.ts`), catch `isMCPInputRequiredError` and fail the call with a message naming the server, the kind (`form` / `sampling`) and the request body
- [x] 4.2 Make the `sampling` message say explicitly that this runtime cannot answer it (no sampling handler), and keep `form` actionable
- [ ] 4.3 A **spec-2025 task** that reports `input_required` while polling is still surfaced as the SDK's own generic `Error`, not through the mapping above. Deferred with task support (P2): the existing message is accurate about the limit, and adding task-resume is a larger change than this one.

## 5. Status and docs

- [x] 5.1 Extend `McpServerStatus` (`packages/core/src/runtime-types/mcp-status.ts`) with `enabled` and `approvalMode` (both required — a host that cannot tell a disabled server from a broken one renders both as failures); report whether elicitation is available once in the `/mcp` header
- [x] 5.2 Update `/mcp` rendering (`packages/core/src/agent/mcp/extension.ts`) for disabled servers, approval mode, and elicitation availability
- [x] 5.3 Update the MCP paragraph in `AGENTS.md` (policy fields, the registry hop, elicitation contract, `input_required` behaviour, patch dependency)
- [x] 5.4 Stop logging a disabled server as a failure (`agent/log/event-log-specialized.ts` treated every non-`connected` row as `MCP server failed`, so each session with `enabled: false` wrote a false failure line)
- [x] 5.5 Normalize `approvalMode` on the failed-policy row: a rejected value leaves the documented default and travels in `error`, so an untyped session-supplied config cannot print `approval=42`
- [x] 5.6 Parse the config file per server: one invalid entry (e.g. `"approval": "alwayss"`) is named, quoted and skipped instead of failing the whole document — previously every MCP tool vanished for that session

## 6. Validation

- [x] 6.1 Add `packages/core/scripts/validate-mcp-client.mjs` asserting against `mcpClientOptions` (the object the manager sends) and `McpManager.initialize` — **not** a fixture server: `McpManager` builds its own transport from config, so a fixture would be reached through a second client construction, i.e. a replica of the wiring under test
- [x] 6.2 Assert approval derivation for all four `approval` modes and the fail-closed default
- [x] 6.3 Assert elicitation: capability absent without a hook, present with one, shorthand/object answers normalized, throwing hook → `decline`, a request with no hook → `decline` + diagnostic
- [x] 6.4 Assert `form` and `sampling` `input_required` mapping produces the named failure text
- [x] 6.5 Register `validate:mcp-client` in `packages/core/package.json` (the `validate:all` aggregate discovers `validate-*.mjs` by glob)
- [x] 6.6 Assert the dependency patch is installed and declared — handler reaches `connectTransport`, option is typed, `pnpm-workspace.yaml` entry + patch file present (a reinstall reverts a dependency silently)
- [x] 6.7 Confirm the guard has teeth: inverting the fail-closed approval default and reintroducing the withdrawn-capability spelling each turned the run red; restoring them turned it green
- [x] 6.8 Assert the capability merge against the SDK's own defaults (so the mirror cannot drift), the claim/handler invariant, `formatMcpStatus` output, the SDK's own `needsApproval` stamp, and `loadMcpConfig`'s per-server tolerance

## 7. Verification

- [x] 7.1 `pnpm build:core` then `node scripts/validate-mcp-client.mjs` — 24 checks
- [x] 7.2 `pnpm build` + `pnpm typecheck` + `pnpm lint` (all clean; `pnpm build` first because both read `dist`)
- [x] 7.3 `pnpm --filter @codent/app test` (159 pass) and `pnpm --filter @codent/core run validate:all:core` (264 pass, 1 pre-existing skip)
- [ ] 7.4 Manual, on a host with a real MCP server: an annotated read-only tool runs silently; an unannotated tool prompts; `/mcp` shows policy and elicitation availability
- **Not covered by any assertion** (recorded, not hidden): a *connected* row's `enabled`/`approvalMode` is only asserted for the `disabled` and `failed` rows, because reaching `connected` needs a real transport; and a spec-2025 task reporting `input_required` keeps the SDK's generic error (task support is P2)
