## 1. Phase 1 — byte and text primitives

- [x] 1.1 Extend `packages/core/src/utils/bytes.ts` with the one byte-bounded truncation primitive (UTF-8 binary search, optional line boundary) alongside `utf8ByteLength`
- [x] 1.2 Migrate `truncateToBudget` (`agent/prompt/instruction-files.ts`) and `truncateBody` (`agent/memory/memory-retrieval.ts`) onto the shared primitive; delete both private copies
- [x] 1.3 Fix `truncateHead` (`agent/lsp/tools/tool-shared.ts:28`) to use `utf8ByteLength` instead of `length * 2`; assert the true-byte bound in a `validate:lsp-output-bytes` script
- [x] 1.4 Add `packages/core/src/utils/text-truncation.ts` (character truncation + one owned omission-marker budget)
- [x] 1.5 Migrate the ~20 inline `slice(0, N) + "..."` sites in `presentation/input-format.ts`, `presentation/output-format.ts`, `compaction/serialize-conversation.ts`, `lsp/tools/*`, `log/event-log-rules.ts`, `plan/plan-summary.ts`, `tools/session-read-tool.ts`, `tools/grep-tool.ts`, `tools/util/find-edit-match.ts`, `plan/extract-plan.ts` to the shared function
- [x] 1.6 Add `packages/core/src/utils/byte-size.ts` `formatByteSize`; migrate `tools/util/format-read-file-result.ts`, `presentation/output-format.ts`, `tools/session-read-tool.ts`, `tools/read-file-tool.ts`

## 2. Phase 1 — encoding, classification, media

- [x] 2.1 Add `packages/core/src/utils/data-url.ts` (`parseDataUrl`, `isBase64Source`, strip-prefix) and route `media/media-store.ts`, `media/media-utils.ts`, `tools/webfetch-tool.ts`, `models/adapter/chat-completions-text-adapter.ts` onto it
- [x] 2.2 Collapse the duplicate MIME maps in `media/media-utils.ts` onto the single map in `media/types.ts`; remove the second `mimeDefaults`
- [x] 2.3 Add `packages/core/src/utils/errors.ts` (`toError`, `errorMessage`); migrate the ~43 sites, including `errorFromUnknown` (`managers/run-stream-recovery.ts:60`) and `errorMessage` (`models/adapter/capability-message-utils.ts:34`)
- [x] 2.4 Replace the inline `error.name === "AbortError"` checks in `compaction/auto-compact.ts`, `compaction/reactive-compact.ts`, `managers/middleware/compaction-middleware.ts`, `managers/managed-agent-compact.ts` with `isAbortError`
- [x] 2.5 Add `agent/memory/memory-expiry.ts` with the single `isExpired`; use it from `memory/memory-manager.ts` and `memory/memory-extractor.ts`
- [x] 2.6 Export `isBinaryMediaPartType` from `agent/media/types.ts` and use it for both membership checks in `media/media-utils.ts`

## 3. Phase 2 — semantics-preserving unification

- [x] 3.1 Add `packages/core/src/utils/display-lines.ts` `splitDisplayLines(text, { normalizeCrlf, dropTrailingEmpty })`; fold `splitLinesForCounting` (`tools/util/output-accumulator.ts`) and `truncateLines` (`tools/util/search-command.ts`) onto it and adopt it in `presentation/lines.ts`
- [x] 3.2 Add `packages/core/src/utils/slug.ts` `slugifyName(input, policy)`; migrate `memory/memory-manager.ts` and `plan/plan-store.ts`, preserving each policy via parameters
- [x] 3.3 Share one entry-truncation primitive between `formatToolArgs` (`presentation/output-format.ts`) and `formatGenericInput` (`presentation/input-format.ts`)
- [x] 3.4 Unify the inconsistent ellipsis budgets (for example `57`/`60`, `117`/`120`, `30`/`50`) to single constants; update the affected presenters, and keep `OUTPUT_LIMITS.MAX_CONTENT_CHARS` (chars) and `OutputAccumulator.DEFAULT_MAX_BYTES` (bytes) distinct

## 4. Guards — one per shared rule

- [x] 4.1 `packages/core/scripts/validate-no-inline-byte-truncation.mjs` (own binary search, `TextEncoder().encode().length`, `length * 2`)
- [x] 4.2 `packages/core/scripts/validate-no-inline-char-truncation.mjs` (`slice(0, N) + "..."` outside the definition and named presenters)
- [x] 4.3 `packages/core/scripts/validate-no-inline-byte-size.mjs` (`Math.round(<n> / 1024) + "KB"` shape)
- [x] 4.4 `packages/core/scripts/validate-no-inline-data-url.mjs` (`data:...;base64` regex outside the definition)
- [x] 4.5 `packages/core/scripts/validate-no-inline-error-normalize.mjs` (`instanceof Error ? ... : new Error(String(...))` and inline `name === "AbortError"`)
- [x] 4.6 `packages/core/scripts/validate-no-inline-slugify.mjs` and `packages/core/scripts/validate-no-duplicate-media-part-set.mjs`
- [x] 4.7 Add a `validate:*` entry in `packages/core/package.json` for each new guard so it runs standalone (CI discovery covers the rest)

## 5. Docs and verification

- [x] 5.1 Update `AGENTS.md` core naming/structure sections for the new `utils/` modules; confirm every documented path resolves (`validate:module-organization`)
- [x] 5.2 Run the affected core validators green: `pnpm --filter @codent/core run validate:instruction-budget`, `validate:instruction-imports`, `validate:read-file-model-output`, `validate:find-edit-match`, `validate:lsp-parity`, `validate:module-organization`, `validate:layer-boundaries`, `validate:cost-convention`, plus the new guards
- [x] 5.3 `pnpm build:core` and `pnpm typecheck` are clean
- [x] 5.4 `pnpm lint` and `pnpm exec prettier --check` on changed files are clean
- [x] 5.5 `pnpm --filter @codent/app test` passes
- [x] 5.6 Diff tool-output fixtures before/after to confirm the only observable changes are the true-byte LSP bound and the unified ellipsis budgets
