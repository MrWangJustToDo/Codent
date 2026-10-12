## Context

`add-agent-runtime-instances` gave core an instance boundary: `CodentAgent` owns an `AgentRuntime`
(env + provider), an `AgentManager`, an `AgentSessionHost`, and runtime-scoped stores; tools read
`ToolRunContext.coreEnv`. The audit (`5f5b9183..4d1480f1`) confirmed the tool/session/media paths but
found ambient `getEnv()` reads still reachable from a run, a guard that does not see them, and
structural drift. This change finishes the migration; it does not change the public contract.

## Goals / Non-Goals

**Goals:** every run-reachable env read resolves from the owning runtime; the guard enforces it; the
layer graph is acyclic with exercised edges; docs/validators describe reality; a two-runtime
managed-run validator locks the guarantee.

**Non-Goals:** async-context/`AsyncLocalStorage` resolution; per-request multi-tenancy; merging the
ambient registries away entirely (they remain the documented fallback); UI multi-runtime switching
(the app stays one-session-per-runtime; a second session is a second runtime, out of scope here).

## Decisions

- **Thread an explicit `env` (or `ResolvedCoreEnv`) into each reader**, matching how `SessionStore` /
  `MediaStore` already take it. Most sites already receive `rootPath`/a manager and only need the env
  added. No ambient lookup is introduced.
- **`dispose` releases only an owned env.** `AgentRuntime.ownsEnv` (default `false`) is set `true` by
  the local Node hosts; a borrowed remote env is never destroyed (a remote `destroy()` POSTs a
  destructive teardown to the server). `dispose` is idempotent.
- **Guard semantics: a fallback is `?? getEnv()` / a default parameter, never a bare assignment.** The
  `=\s*$` heuristic silently allowed `const env = getEnv();`; narrowing it is what makes the guard
  bite. Scan roots widen to every run-path directory; each allowlist entry keeps a written reason.
- **Layer graph.** `provider` is the LLM plane; `models` is config/adapters/metadata. Pick one
  direction for the config↔provider edge and delete the reverse + the cross-layer `models/index.ts`
  re-export (no consumer). Edges used only as types become `mode: "type-only"`.
- **Structure gate.** `validate-module-organization`'s `CORE_TOP_LEVEL` gains `provider` and
  `runtime` so the doc-path rule covers the new layers.

## Risks / Trade-offs

- [Threading env touches many signatures] → do it per module with the gate widened first, so each
  remaining offender fails loudly rather than silently.
- [Breaking the `models ↔ provider` cycle could ripple] → the only real value edge is
  `models/config/models-config.ts` building providers; move that construction to `provider/` or make
  `models` depend on `provider` one-way.
- [Over-scoping the guard] → keep the documented ambient-by-design set (models-dev memory cache,
  process-global registries) explicitly allowlisted with reasons, so the gate stays a decision, not a
  blanket disable.

## Migration Plan

1. Guard + ambient wiring (highest value; unblocks correctness).
2. Structure (layer edges, re-export, gate, docs tree).
3. Docs/tooling cleanup + the two-runtime managed-run validator.
Each group is green on `pnpm build` / `lint` / `typecheck` + the `validate:*` suite before the next.

## Open Questions

- Whether `command-output-log.ts` (background-job durable log) takes the run env or stays
  ambient-by-design. Current design classifies it ambient; this change wires it to the runtime env so
  the advertised `cachedOutputPath` is readable through the same env that `read_file` uses.
