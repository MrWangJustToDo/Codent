/**
 * Fail when a module re-derives a UTF-8 byte count or approximates a byte budget from a character
 * count instead of calling `utf8ByteLength` / `truncateToUtf8Bytes`
 * (`packages/core/src/utils/bytes.ts`).
 *
 * The approximation (`out.length * 2 > maxBytes`) is why an LSP tool's byte bound cut the wrong
 * number of characters for CJK output; the inline `TextEncoder().encode(x).length` is why the rule
 * had five homes.
 */

import { runGuard } from "./helpers/source-guard.mjs";

runGuard({
  name: "validate-no-inline-byte-truncation",
  definitionFiles: ["utils/bytes.ts"],
  patterns: [
    { re: /new TextEncoder\(\)\.encode\([^)]*\)\.length/, reason: "inline UTF-8 byte count" },
    { re: /\.length\s*\*\s*2\s*[><]=?/, reason: "byte budget approximated from character count" },
  ],
  note: "Call utf8ByteLength / truncateToUtf8Bytes from @codent/core (packages/core/src/utils/bytes.ts).",
});
