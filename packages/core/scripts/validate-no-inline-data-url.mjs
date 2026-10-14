/**
 * Fail when a module carries its own `data:*;base64,` regular expression instead of calling
 * `parseDataUrl` / `stripDataUrlPrefix` (`packages/core/src/utils/data-url.ts`).
 *
 * Five modules had each chosen their own shape, and they had drifted on whether the media type or
 * the payload was captured, and on whether a comma is allowed inside the media type.
 */

import { runGuard } from "./helpers/source-guard.mjs";

runGuard({
  name: "validate-no-inline-data-url",
  definitionFiles: ["utils/data-url.ts"],
  patterns: [
    { re: /\/\^data:/, reason: "inline data-URL regex" },
    { re: /data:\[\^/, reason: "inline data-URL regex" },
  ],
  note: "Call parseDataUrl / stripDataUrlPrefix from @codent/core (packages/core/src/utils/data-url.ts).",
});
