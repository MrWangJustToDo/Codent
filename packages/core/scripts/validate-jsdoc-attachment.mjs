/**
 * JSDoc attachment guard.
 *
 * Two adjacent JSDoc blocks with no code between them are never intentional: one of them
 * is an abandoned doc that a refactor left behind, so the declaration below is described twice
 * (or the real owner is described nowhere). The pattern is invisible to every other gate —
 * TypeScript and ESLint do not read comments — and it has shipped repeatedly (a `getL1State`
 * doc on `setDisplayName`, a `queryMessages` doc on `withUsage`).
 *
 * Both shapes are flagged: a single-line block and a multi-line block, whose closing line is a bare
 * terminator and which a naive "the line starts with `/**`" check cannot see. The scanner therefore
 * tracks block state instead of inspecting one line at a time.
 *
 * Only *directly* stacked blocks are flagged. A file header separated by a blank line (or by code)
 * from the first declaration's doc is normal and is not reported. A plain block comment
 * (for example an `eslint-disable` directive) is not JSDoc and never counts as the first block.
 *
 * Scanned across EVERY package's source (not just core): the abandoned-doc shape is a refactor
 * artifact, and hosts refactor at least as much as core does.
 *
 * Run: pnpm --filter @codent/core run validate:jsdoc-attachment
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { collectPackageSources, packageNames } from "./helpers/package-sources.mjs";

/**
 * 1-based line numbers whose JSDoc block closes immediately above another JSDoc block.
 *
 * State is tracked line by line: `inJsDoc` while a block is open, `closedJsDoc` on the line that
 * closed it. A JSDoc line that also closes (single-line block) sets both from the same line, which
 * is what makes the single-line and multi-line shapes one rule instead of two.
 */
function stackedJsDocLines(source) {
  const lines = source.split("\n");
  const hits = [];
  let inJsDoc = false;
  let closedJsDoc = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const startsJsDoc = trimmed.startsWith("/**");

    // A new JSDoc immediately after a closed one: the second block describes the same declaration.
    if (closedJsDoc && startsJsDoc) hits.push(i + 1);

    if (inJsDoc) {
      // A closing line is `*/` (or carries content before it); anything else keeps the block open.
      if (trimmed.endsWith("*/")) {
        inJsDoc = false;
        closedJsDoc = true;
      } else {
        closedJsDoc = false;
      }
      continue;
    }

    if (startsJsDoc) {
      // `/**/` closes on its opening line, exactly like `/** one line */`.
      const closesOnSameLine = trimmed.endsWith("*/");
      inJsDoc = !closesOnSameLine;
      closedJsDoc = closesOnSameLine;
      continue;
    }

    closedJsDoc = false;
  }

  return hits;
}

// Self-check: the gate exists for the multi-line shape (every real case was multi-line), so pin
// both shapes plus the two shapes that must stay quiet. A future refactor of the scanner that
// reintroduces the single-line-only check fails here, not in a review six months later.
const SELF_CHECKS = [
  ["multi-line stacked", "/**\n * abandoned\n */\n/**\n * live\n */\nconst x = 1;\n", [4]],
  ["single-line stacked", "/** abandoned */\n/** live */\nconst x = 1;\n", [2]],
  ["eslint-disable then doc", "/* eslint-disable max-lines */\n/** live */\nconst x = 1;\n", []],
  ["header then blank then doc", "/** header */\n\n/** live */\nconst x = 1;\n", []],
  ["header then code then doc", "/** header */\nimport x from 'x';\n\n/** live */\nexport const y = 1;\n", []],
  ["empty jsdoc then doc", "/**/\n/** live */\nexport const y = 1;\n", [2]],
];
for (const [name, source, expected] of SELF_CHECKS) {
  assert.deepEqual(stackedJsDocLines(source), expected, `scanner self-check failed: ${name}`);
}

const violations = [];
for (const pkg of await packageNames()) {
  for (const { absolute, relative } of await collectPackageSources(pkg)) {
    for (const line of stackedJsDocLines(await readFile(absolute, "utf8"))) {
      violations.push(`${relative}:${line}`);
    }
  }
}

assert.deepEqual(violations, [], `stacked JSDoc blocks (one is abandoned):\n${violations.join("\n")}`);
console.log("jsdoc attachment validation passed");
