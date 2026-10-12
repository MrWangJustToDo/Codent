/**
 * Host tool-name guard (shared).
 *
 * Asserts a host package does not keep a private table of built-in tool names: a
 * built-in's identity lives in `@codent/core` (`BUILTIN_TOOL_NAMES`), and a host must
 * compare/route/label it through that export. This catches the regressions the change
 * removed — a literal `name === "run_command"`, a `case "todo":` tool switch, a
 * `new Set([...])` of built-in names, or a record keyed by tool name.
 *
 * Only tool-identity contexts are matched (a `.name`/`tool`/`toolName` comparison, a
 * `case`, a tool-keyed record, a `tool:` field), so an unrelated string that happens to
 * equal a built-in name (a workspace pane called "tree", a summary source "task") is not
 * flagged.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

/** Drop full-line comments (block-comment bodies start with `*`), so docs don't trip the scan. */
function stripCommentLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

function patternsFor(name) {
  const q = `["'\`]${escapeRegExp(name)}["'\`]`;
  return [
    new RegExp(`(?:\\.name|\\btoolName|\\btool)\\s*(?:===|!==|==|!=)\\s*${q}`),
    new RegExp(`${q}\\s*(?:===|!==|==|!=)\\s*(?:\\.name|\\btoolName|\\btool)\\b`),
    new RegExp(`\\bcase\\s+${q}\\s*:`),
    new RegExp(`(?:^|[{,])\\s*${q}\\s*:\\s*\\{`, "m"),
    new RegExp(`new\\s+Set\\(\\s*\\[\\s*${q}`),
    new RegExp(`\\btool\\s*:\\s*${q}`),
  ];
}

/**
 * @param {Record<string, string>} toolNames canonical identifier → wire name
 * @param {string} srcDir package `src/` directory (absolute)
 * @returns {string[]} human-readable violations
 */
export function collectHostToolNameViolations(toolNames, srcDir) {
  const names = Object.values(toolNames);
  const violations = [];
  for (const file of walk(srcDir)) {
    const lines = stripCommentLines(readFileSync(file, "utf8")).split("\n");
    for (const name of names) {
      for (const re of patternsFor(name)) {
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) {
            violations.push(`${relative(process.cwd(), file)}:${i + 1}: built-in tool name "${name}" as a literal`);
            break;
          }
        }
      }
    }
  }
  return violations;
}

/** Run the guard for one package; exits non-zero on violations. */
export function runHostToolNamesGuard(toolNames, srcDirUrl, packageName) {
  const srcDir = fileURLToPath(srcDirUrl);
  const violations = collectHostToolNameViolations(toolNames, srcDir);
  if (violations.length > 0) {
    console.error(
      `${packageName} host tool-name guard FAILED — use BUILTIN_TOOL_NAMES from @codent/core:\n  ` +
        violations.join("\n  ")
    );
    process.exit(1);
  }
  console.log(`${packageName} host tool-name guard OK (${Object.keys(toolNames).length} built-in names)`);
}
