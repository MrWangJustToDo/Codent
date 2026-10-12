## 1. Core: canonical identifiers

- [x] 1.1 Add `packages/core/src/agent/tools/tool-names.ts` exporting `BUILTIN_TOOL_NAMES` (every built-in tool name, `as const`) and export it from `src/index.ts` (+ `dev` re-export for validators).
- [x] 1.2 Re-export `BEGIN_SUMMARY_TOOL_NAME` from the public `src/index.ts`.
- [x] 1.3 Add `validate:builtin-tool-names` asserting `BUILTIN_TOOL_NAMES` equals the set of tools core builds (`createTools` keys + plan/subagent/todo/ask_user/skills/memory/lsp/code-mode names), so the registry cannot drift; wire it into the core validator set.
- [x] 1.4 Build core + `tsc` + run the core validator set.

## 2. @codent/app

- [x] 2.1 Add `registerBuiltinCommand(name, def)` in `commands/utils/registry.ts` sourcing `name`/`description`/`usage`/`aliases` from `BUILTIN_COMMAND_CATALOG`; switch all `commands/*.ts` to it.
- [x] 2.2 `utils/tool-display.ts`: delete `ALWAYS_VISIBLE_TOOL_NAMES` / `DETAILED_OUTPUT_TOOL_NAMES`; derive `hasDetailedOutputBlock` from `getToolPresentation` and delegate `keepsCompactRow` to core.
- [x] 2.3 `hooks/use-task.ts`: import `BEGIN_SUMMARY_TOOL_NAME` from core.
- [x] 2.4 Message views (`ToolOutputView`, `ToolInputView`, `ToolCallPartView`, `ToolStatusIcon`) + input-controls hooks: replace built-in tool-name literals with `BUILTIN_TOOL_NAMES`.
- [x] 2.5 Replace `validate-command-catalog` with a derivation assertion (every catalog entry registered by the app; app commands carry no metadata of their own).
- [x] 2.6 Build app + run `pnpm --filter @codent/app test` + app validators.

## 3. @codent/acp

- [x] 3.1 `tools.ts`: derive `toolKindFor` from `getToolPresentation(name)?.category` + an override record keyed by `BUILTIN_TOOL_NAMES` (delete/fetch); key `TITLE_VERBS` by `BUILTIN_TOOL_NAMES`.
- [x] 3.2 `commands.ts`: dispatch built-ins from the catalog (identifier-keyed handler record driven by `BUILTIN_COMMAND_CATALOG`) instead of a private name switch.
- [x] 3.3 `agent.ts`: use `BUILTIN_TOOL_NAMES.ask_user` for the `ask_user` output marker.
- [x] 3.4 Build acp + run `validate:acp`.

## 4. @codent/im-bridge

- [x] 4.1 `interaction/render.ts` + `interaction/pending.ts`: key the tool switches/constants off `BUILTIN_TOOL_NAMES` instead of literals.
- [x] 4.2 Build im-bridge + run `validate:bridge`.

## 5. Guard, docs, validation, archive

- [x] 5.1 Add `validate:host-tool-names` (app/acp/im-bridge scripts) failing on bare built-in tool-name literals in host render/routing code; wire into each package's validate set and CI.
- [x] 5.2 Document the convention in `AGENTS.md` (built-in identity lives in core; hosts consume `BUILTIN_TOOL_NAMES` / `BUILTIN_COMMAND_CATALOG`).
- [x] 5.3 Run `pnpm build`, `pnpm lint`, `pnpm typecheck`, the affected `validate:*` sets, and `openspec validate unify-builtin-catalog --strict`.
- [x] 5.4 Archive the change and sync spec deltas into `openspec/specs/`.
