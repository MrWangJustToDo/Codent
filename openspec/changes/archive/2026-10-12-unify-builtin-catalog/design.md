## Context

Three catalogs already live in core:

- `agent/commands/catalog.ts` — `BUILTIN_COMMAND_CATALOG` (name / aliases / description / usage /
  scope / dispatched `AgentSessionCommand` type), consumed today by `@codent/acp` for
  `available_commands_update` and by `@codent/app` only through a parity script.
- The tool factories (`defineServerTool({ name, present, ... })`) plus
  `agent/tools/presentation/builtin-table.ts` (`BUILTIN_PRESENTATION`) and the registry
  (`getToolPresentation`) — the single source of tool classification, already shipped to hosts as the
  serializable `ToolPresentationInfo` catalog.
- The filesystem/shell/web tool names are also typed as the keys of `Tools` (`create-tools.ts`).

Hosts nonetheless keep private copies. This change makes core the only place a built-in's identity
is written for hosts.

## Goals / Non-Goals

- Goals: a host adding/renaming/removing a built-in tool or command touches core only; hosts derive
  classification from core and never keep a built-in name table.
- Non-Goals: removing the internal string literals inside core's own tool factories and `Tools` type
  (the tool definition and its structural type are where a tool is genuinely defined; a separate
  constant would be a third copy, not a deduplication). Core does **not** learn ACP's `ToolKind`
  vocabulary.

## Decisions

- **Decision: export a canonical identifier registry, not just the catalog.** Add
  `agent/tools/tool-names.ts` exporting `BUILTIN_TOOL_NAMES` (all built-in names, `as const`) and
  re-export `BEGIN_SUMMARY_TOOL_NAME` from the public index. Hosts import these instead of literals, so
  a rename is a core edit.
  - Alternatives considered: a per-tool presentation field. Rejected — the identifier is the stable
    contract hosts key on; presentation is a separate concern already covered by `present`.
- **Decision: ACP derives `ToolKind` from the core presentation `category`.** category →
  kind is `reads→read`, `edits→edit`, `searches→search`, `commands→execute`, everything else→`other`,
  with a two-entry override record (`delete_file→delete`, `websearch`/`webfetch→fetch`) keyed by
  `BUILTIN_TOOL_NAMES`. ACP's human title verbs stay host policy (a curated vocabulary), but the map is
  keyed by core identifiers so a rename cannot leave a stale key.
  - Alternatives considered: give core an ACP-shaped `action` field. Rejected — it couples core to a
    host protocol's enum for one consumer.
- **Decision: app command files register behavior only.** A `registerBuiltinCommand(name, def)` helper
  looks the entry up in `BUILTIN_COMMAND_CATALOG` and fills `name` / `description` / `usage` /
  `aliases`; the file supplies `execute` / `options` / `immediate`. Missing a catalog entry fails
  loudly at registration.
- **Decision: app tool row/visibility derives from core.** `hasDetailedOutputBlock` reads
  `getToolPresentation(name)?.detailed`; `keepsCompactRow` delegates to core's `keepsCompactRow`.
  `getToolPresentation` already falls back to `BUILTIN_PRESENTATION`, so the local sets were a
  redundant second source, not a needed fallback.

## Risks / Trade-offs

- ACP running against a remote session would not have core's tool registry populated process-locally.
  → `getToolPresentation` still falls back to the static `BUILTIN_PRESENTATION`, and the override
  record is static, so built-in kind mapping is correct without a live session. (ACP runs agent-side
  in-process today; noted for completeness.)
- Removing the app's static fallback sets could regress a renderer whose process has no descriptors.
  → The fallback lives in core's `BUILTIN_PRESENTATION`; `getToolPresentation` consults it after the
  live registry, so the behavior is preserved.
- A host name table removed but the constant left unused would be a silent hole.
  → `validate:host-tool-names` fails on bare built-in name literals in host render/routing code, and
  `validate:builtin-tool-names` asserts `BUILTIN_TOOL_NAMES` equals the set core builds.

## Migration Plan

1. Add core registry + exports (tools, `begin_summary`); guard it against the built set.
2. Migrate `@codent/app` (commands, tool-display, use-task, message views). Parity script becomes a
   derivation assertion.
3. Migrate `@codent/acp` (kind/title, command dispatch, `agent.ts`).
4. Migrate `@codent/im-bridge`.
5. Docs (`AGENTS.md` convention note) + full validation + archive.

Rollback is per-step; the wire contract (names) is unchanged throughout.

## Open Questions

- Should `im-bridge`'s per-tool input formatting be reduced further (derive from core `present`)?
  Scoped here to identifier-keying only; broader derivation is a possible follow-up.
