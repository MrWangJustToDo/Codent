/**
 * Fail when a module converts bytes to a display size by hand instead of calling `formatByteSize`
 * (`packages/core/src/utils/byte-size.ts`).
 *
 * `Math.round(size / 1024) + "KB"` and its megabytes variant were each rewritten per caller.
 */

import { runGuard } from "./helpers/source-guard.mjs";

runGuard({
  name: "validate-no-inline-byte-size",
  definitionFiles: ["utils/byte-size.ts"],
  patterns: [
    { re: /Math\.round\([^)]*\/\s*1024/, reason: "manual KB/MB conversion" },
    // `(bytes / 1024).toFixed(1)` and `` `${n} KB` `` are the same re-derivation in a different
    // shape — `agent-doc-loader` had both, and the original pattern could not see either.
    { re: /\/\s*1024\s*\)?\s*\.toFixed\(/, reason: "manual KB/MB conversion" },
    { re: /`\$\{[^}]*\}\s*(?:KB|MB)`/, reason: "manual KB/MB label" },
  ],
  note: "Call formatByteSize from @codent/core (packages/core/src/utils/byte-size.ts).",
});
