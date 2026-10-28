/**
 * Fail when a module spells the `slice(0, N) + "..."` truncation out instead of calling
 * `truncateText` (`packages/core/src/utils/text-truncation.ts`).
 *
 * The marker budget was hand-computed at each site (`57` for a requested `60`, `117` for `120`), so
 * two callers asking for the same width disagreed by a marker's length.
 */

import { runGuard } from "./helpers/source-guard.mjs";

runGuard({
  name: "validate-no-inline-char-truncation",
  definitionFiles: ["utils/text-truncation.ts"],
  patterns: [
    { re: /\.slice\(0,\s*[^)]*\)\s*\+\s*["'](?:\.\.\.|…)["']/, reason: "slice + omission marker" },
    { re: /\.slice\(0,\s*[^)]*\)\}?\s*(?:\.\.\.|…)[`"']/, reason: "template slice + omission marker" },
    // `substring` is the same truncation spelled differently — and the conditional-marker form
    // (`substring(0, 50) + (len > 50 ? "..." : "")`) is what a `slice`-only pattern cannot see.
    { re: /\.substring\(0,\s*[^)]*\)[^\n]*["'](?:\.\.\.|…)["']/, reason: "substring + omission marker" },
    { re: /\.slice\(0,\s*[^)]*\)[^\n]*["'](?:\.\.\.|…)["']/, reason: "slice + conditional omission marker" },
  ],
  note: "Call truncateText from @codent/core (packages/core/src/utils/text-truncation.ts).",
});
