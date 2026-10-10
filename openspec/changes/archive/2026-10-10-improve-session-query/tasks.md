## 1. Surface + time filter in the reader

- [x] 1.1 Derive each message's `surface` (`current` / `shadowed`) in `session-reader.ts` from the session's latest compaction summary (`isCompactionSummaryUIMessage`); all-`current` when none
- [x] 1.2 Add `surface` to `SessionMessage` and `HistoryMatch`
- [x] 1.3 Add `since` / `until` (epoch ms) to `SearchHistoryOptions` and filter session matches by message timestamp

## 2. Tools

- [x] 2.1 `session_search`: add `since` / `until` inputs and `surface` to the match schema + model output
- [x] 2.2 `session_read`: add `surface` to the message schema + rendered text
- [x] 2.3 Keep bounds/spill behavior unchanged

## 3. Coverage

- [x] 3.1 Extend `validate-session-search.mjs`: shadowed vs current around a compaction summary, all-current without one, and time-window filtering
- [x] 3.2 Run the full core validator suite plus typecheck/lint
