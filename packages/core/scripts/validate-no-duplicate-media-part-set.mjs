/**
 * Fail when a module under `agent/media/` re-lists the four binary media part types itself instead
 * of deriving them from `isBinaryMediaPartType` (`agent/media/types.ts`).
 *
 * `media-utils.ts` listed `image` / `audio` / `video` / `document` twice in one file, and
 * `repair-stringified-multimodal.ts` a third time. The vocabulary's one definition is the tuple in
 * `utils/multimodal-part-types.ts` (shared with the wire layer, which cannot import `agent/`); this
 * guard ensures no media module — `types.ts` included — re-lists the four names instead of deriving
 * them.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mediaDir = resolve(here, "../src/agent/media");

const PART_TYPES = ["image", "audio", "video", "document"];
const listsAllFour = (line) => PART_TYPES.every((type) => line.includes(`"${type}"`));

const offenders = [];
for (const entry of readdirSync(mediaDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const file = join(mediaDir, entry.name);
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (listsAllFour(line)) {
        offenders.push({
          rel: relative(resolve(here, "../src"), file).split("\\").join("/"),
          line: index + 1,
          text: line.trim(),
        });
      }
    });
}

if (offenders.length > 0) {
  process.stderr.write("validate-no-duplicate-media-part-set: binary media part types re-listed under agent/media/:\n");
  for (const offender of offenders) {
    process.stderr.write(`  ${offender.rel}:${offender.line}\n      ${offender.text}\n`);
  }
  process.stderr.write(
    "\nUse isBinaryMediaPartType from agent/media/types.ts (defined in utils/multimodal-part-types.ts).\n"
  );
  process.exit(1);
}

process.stdout.write("validate-no-duplicate-media-part-set: ok\n");
