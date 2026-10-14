#!/usr/bin/env node
/**
 * Rewrite the tool audit's "余量" summary line from the per-item markers in the same file.
 *
 * The line used to be hand-counted, and two rounds of arithmetic got it wrong in different ways — a
 * count that disagrees with the bullets it summarizes is worse than no count, because the reader
 * trusts it. It is now derived by construction:
 *
 *   node scripts/audit-summary.mjs            # rewrites docs/tool-audit-findings.md in place
 *
 * A bullet's status is its leading `【…】` marker up to the first `·` (so `【已修 · \`abc123\`】` counts
 * as 已修). Anything unrecognized is reported instead of being silently binned.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOC = fileURLToPath(new URL("../docs/tool-audit-findings.md", import.meta.url));
const KNOWN = ["已修", "部分修", "不修", "不成立", "未修"];
const SECTIONS = [
  { label: "中", heading: "## 中（" },
  { label: "低", heading: "## 低（" },
];

const doc = readFileSync(DOC, "utf8");
const lines = doc.split("\n");

/** The bullets of one `## `-delimited section (up to the next top-level heading). */
function sectionBullets(heading) {
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) throw new Error(`no section: ${heading}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = end < 0 ? rest : rest.slice(0, end);
  return body.filter((line) => line.startsWith("- 【"));
}

const counts = {};
for (const { label, heading } of SECTIONS) {
  const statuses = new Map(KNOWN.map((status) => [status, 0]));
  let total = 0;
  for (const bullet of sectionBullets(heading)) {
    const marker = /\s*【([^】·]+)/.exec(bullet.slice(2))?.[1]?.trim();
    if (!statuses.has(marker)) throw new Error(`unknown status marker ${JSON.stringify(marker)} in: ${bullet.slice(0, 60)}`);
    statuses.set(marker, statuses.get(marker) + 1);
    total += 1;
  }
  counts[label] = { total, statuses };
}

/** `17 条已修、2 条部分修…` — every status except the one the sentence already states. */
function others(statuses, except) {
  return KNOWN.filter((status) => status !== except && status !== "未修" && statuses.get(status) > 0)
    .map((status) => `${statuses.get(status)} 条${status}`)
    .join("、");
}

const parts = SECTIONS.map(({ label }) => {
  const { total, statuses } = counts[label];
  return `「${label}」${total} 条里 **${statuses.get("未修")} 条未修**（另 ${others(statuses, "未修")}）`;
});
const line =
  "> - 余量（由 `node scripts/audit-summary.mjs` 从本文件的标记生成，勿手改）：" +
  `${parts.join("；")}。剩余顺序见文末。`;

// Matches the line however its parenthetical note reads, so the note can be reworded.
const previous = lines.findIndex((line) => line.startsWith("> - 余量"));
if (previous < 0) throw new Error("no 余量 line to replace");
lines[previous] = line;
writeFileSync(DOC, lines.join("\n"), "utf8");
console.log(line);
