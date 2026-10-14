/**
 * Fail when a module keeps its own slug skeleton instead of calling `slugifyName`
 * (`packages/core/src/utils/slug.ts`).
 *
 * The memory store and the plan store agreed on the shape but disagreed on the character policy
 * and the length cap; a fix to one was forgotten in the other.
 */

import { runGuard } from "./helpers/source-guard.mjs";

runGuard({
  name: "validate-no-inline-slugify",
  definitionFiles: ["utils/slug.ts"],
  patterns: [
    { re: /replace\(\/-{2,}\/g/, reason: "slug hyphen collapsing" },
    { re: /replace\(\/\^-+\|-+\$\/g/, reason: "slug trimming" },
  ],
  note: "Call slugifyName(input, { unicode, maxLength, fallbackPrefix }) from @codent/core.",
});
