/**
 * Fail when a module re-lists the four binary media part types itself instead of deriving them from
 * the one definition.
 *
 * `media-utils.ts` listed `image` / `audio` / `video` / `document` twice in one file, and
 * `repair-stringified-multimodal.ts` a third time. The vocabulary's one definition is the tuple in
 * `utils/multimodal-part-types.ts` (shared with the wire layer, which cannot import `agent/`); this
 * guard checks that no other module in `src/` re-lists the four names instead of deriving them.
 *
 * Scanning all of `src/`, not just `agent/media/`: the second duplicate this guard was meant to
 * prevent appeared in `agent/mcp/prefer-multimodal-content.ts` as a private
 * `type BinaryPartType = "image" | "audio" | "video" | "document"` — same re-listing, one directory
 * outside the net, so it passed. The rule is about the vocabulary, not the directory.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "../src");

/** The one module allowed to name all four: it IS the definition. */
const DEFINITION_FILE = "utils/multimodal-part-types.ts";

const PART_TYPES = ["image", "audio", "video", "document"];
const listsAllFour = (line) => PART_TYPES.every((type) => line.includes(`"${type}"`));

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

const offenders = [];
for (const file of sourceFiles(srcDir)) {
  const rel = relative(srcDir, file).split("\\").join("/");
  if (rel === DEFINITION_FILE) continue;
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (listsAllFour(line)) {
        offenders.push({ rel: `src/${rel}`, line: index + 1, text: line.trim() });
      }
    });
}

if (offenders.length > 0) {
  process.stderr.write("validate-no-duplicate-media-part-set: binary media part types re-listed in src/:\n");
  for (const offender of offenders) {
    process.stderr.write(`  ${offender.rel}:${offender.line}\n      ${offender.text}\n`);
  }
  process.stderr.write(
    `\nUse isBinaryMediaPartType / MultimodalPartType from agent/media/types.ts (defined in ${DEFINITION_FILE}).\n`
  );
  process.exit(1);
}

process.stdout.write("validate-no-duplicate-media-part-set: ok\n");
