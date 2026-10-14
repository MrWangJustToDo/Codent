/**
 * Fail when a module under `agent/media/` lists the four binary media part types itself instead of
 * calling `isBinaryMediaPartType` (`agent/media/types.ts`).
 *
 * `media-utils.ts` listed `image` / `audio` / `video` / `document` twice in one file, and
 * `repair-stringified-multimodal.ts` a third time; the membership set now has one home.
 *
 * Scoped to `agent/media/` on purpose: `models/adapter/capability-message-utils.ts` describes the
 * multimodal *wire* capabilities (a different concept with the same four names), so a repo-wide
 * scan would flag a legitimate set.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mediaDir = resolve(here, "../src/agent/media");
const DEFINITION = "types.ts";

const PART_TYPES = ["image", "audio", "video", "document"];
const listsAllFour = (line) => PART_TYPES.every((type) => line.includes(`"${type}"`));

const offenders = [];
for (const entry of readdirSync(mediaDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === DEFINITION) continue;
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
  process.stderr.write(
    "validate-no-duplicate-media-part-set: binary media part types listed outside agent/media/types.ts:\n"
  );
  for (const offender of offenders) {
    process.stderr.write(`  ${offender.rel}:${offender.line}\n      ${offender.text}\n`);
  }
  process.stderr.write("\nCall isBinaryMediaPartType from agent/media/types.ts.\n");
  process.exit(1);
}

process.stdout.write("validate-no-duplicate-media-part-set: ok\n");
