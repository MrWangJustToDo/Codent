/**
 * Accessor-convention gate.
 *
 * Core classes must expose ONE way to read a value: either a property-like getter
 * (`get foo()`) or a method (`getFoo()`), never both for the same concept — and, for
 * the classes named below, never a bare getter at all.
 *
 * Why a gate instead of a convention note: `ManagedAgent` had both
 * `get todoManager()` and `getTodoManager()` (identical bodies), so a reader had to
 * know which spelling was "the" one, and the surface grew variants
 * (`skillRegister` vs `getSkillRegistry`). A convention nobody checks is a
 * convention that drifts back — this repository's own history (`findCutPoint`
 * documented long after deletion, a boundary gate that covered 2 of 6 edges) is the
 * evidence.
 *
 * Two rules:
 *
 * 1. **No duplicates.** A class may not declare a getter and a method that resolve to
 *    the same concept (same name, or `foo` + `getFoo`).
 * 2. **Method form on the frozen list.** Classes on {@link METHOD_ONLY_CLASSES} must
 *    not use property getters for state access at all: the write side is already
 *    methods (`setUIChannel`, `setLog`), and state here is a *snapshot*, not
 *    a plain field — `managed.status` reads as data while `getStatus()` reads as a
 *    call, which is the honest signal.
 *
 * Run: pnpm --filter @codent/core run validate:accessor-convention
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(scriptDir, "../src");

/**
 * Classes that must not declare property getters for state access.
 *
 * Scope is deliberately narrow: the inconsistency lives in `ManagedAgent` (the
 * composition root that grew accessor shortcuts), and the audit confirmed every
 * other class in core is already method-only. Rule 1 (no duplicates) still applies
 * everywhere, so a new class that introduces `get x()` + `getX()` is caught even
 * though it is not listed here.
 */
const METHOD_ONLY_CLASSES = new Set(["ManagedAgent"]);

/**
 * `get foo()` declarations inside a class body, with or without a return type and with any
 * member modifiers.
 *
 * The original `^\s{2}get` form matched almost nothing: a real getter is either indented deeper
 * (object literal, nested class) or carries `private`/`static`. A gate that sees zero getters
 * cannot fail — which is worse than no gate at all, because it reports "passed".
 *
 * Capture groups: 1 = indentation, 2 = modifiers, 3 = name.
 */
const GETTER_RE =
  /^(\s+)((?:(?:public|private|protected|static|readonly|override|declare)\s+)*)get\s+([A-Za-z_$][\w$]*)\(\)\s*(?::[^{;]+)?\{/;
/** Method declarations `foo(...)` / `getFoo()` with optional modifiers. Groups: 1 = indent, 2 = name. */
const METHOD_RE =
  /^(\s+)(?:(?:public|private|protected|static|readonly|override|declare|async)\s+)*([A-Za-z_$][\w$]*)\([^)]*\)\s*(?::[^{;]+)?\{/;
/** `class X {` / `export class X {` — including `abstract`/generics. */
const CLASS_RE = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;

const indentOf = (line) => line.length - line.trimStart().length;

function walkTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTsFiles(full));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * Parse class bodies shallowly: collect getters and methods per class.
 *
 * Nesting is tracked by a stack of (class, indentation): a member belongs to the innermost class
 * that starts before it. The previous version kept a single `current` pointer, so a nested class
 * silently took ownership of every outer member that followed it (the members were then compared
 * against the wrong method list — a false negative for the outer class and a false positive for
 * the inner one).
 */
function collectClasses(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const classes = [];
  /** @type {Array<{ node: object, indent: number }>} */
  const stack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const classMatch = CLASS_RE.exec(line);
    if (classMatch) {
      const indent = indentOf(line);
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      const node = { name: classMatch[1], line: i + 1, getters: [], methods: [], underscored: [] };
      stack.push({ node, indent });
      classes.push(node);
      continue;
    }
    if (stack.length === 0) continue;

    const indent = indentOf(line);
    // Innermost class that starts before this line's own indentation (a top-level line has none).
    let current = null;
    for (let s = stack.length - 1; s >= 0; s--) {
      if (stack[s].indent < indent) {
        current = stack[s].node;
        break;
      }
    }
    if (!current) continue;

    const getter = GETTER_RE.exec(line);
    if (getter) {
      current.getters.push({ name: getter[3], line: i + 1, hasModifier: getter[2].trim().length > 0 });
      continue;
    }

    // Underscore-prefixed members are banned (the file's own rule, previously unchecked).
    const underscored = /^\s+(?:private|protected|public)?\s*(?:readonly\s+)?(_[A-Za-z_$][\w$]*)\s*[:(=;]/.exec(line);
    if (underscored) current.underscored.push({ name: underscored[1], line: i + 1 });

    const method = METHOD_RE.exec(line);
    if (method) {
      const name = method[2];
      // Control flow inside a method body can look like a call at this indent;
      // exclude the obvious keywords rather than tracking brace depth.
      if (!["if", "for", "while", "switch", "catch", "return", "else", "do"].includes(name)) {
        current.methods.push({ name, line: i + 1 });
      }
    }
  }

  return classes;
}

const violations = [];
const methodOnlyViolations = [];
let getterTotal = 0;
let getterWithModifier = 0;
let classTotal = 0;

for (const file of walkTsFiles(srcRoot)) {
  const rel = relative(join(scriptDir, ".."), file);
  for (const cls of collectClasses(file)) {
    classTotal += 1;
    getterTotal += cls.getters.length;
    getterWithModifier += cls.getters.filter((g) => g.hasModifier).length;
    const methodNames = new Set(cls.methods.map((m) => m.name));

    for (const member of cls.underscored) {
      violations.push({
        file: rel,
        cls: cls.name,
        detail: `member ${member.name} (line ${member.line}) — no underscore-prefixed members`,
      });
    }
    for (const getter of cls.getters) {
      const methodSpelling = `get${getter.name[0].toUpperCase()}${getter.name.slice(1)}`;
      if (methodNames.has(methodSpelling)) {
        violations.push({
          file: rel,
          cls: cls.name,
          detail: `get ${getter.name}() (line ${getter.line}) duplicates ${methodSpelling}()`,
        });
      }
      // Rule 1b: `get foo()` next to `foo()` — two spellings of the same read.
      if (methodNames.has(getter.name)) {
        violations.push({
          file: rel,
          cls: cls.name,
          detail: `get ${getter.name}() (line ${getter.line}) duplicates ${getter.name}()`,
        });
      }
      // Rule 2: frozen classes must not use property getters for state access.
      if (METHOD_ONLY_CLASSES.has(cls.name)) {
        methodOnlyViolations.push({
          file: rel,
          cls: cls.name,
          detail: `get ${getter.name}() (line ${getter.line}) — ${cls.name} must expose reads as getXxx()`,
        });
      }
    }
  }
}

const all = [...violations, ...methodOnlyViolations];

// A gate that parses zero getters passes for the wrong reason, and that is exactly how this file
// spent its life before the regex was fixed. Pin the non-vacuity of the scan itself.
assert.ok(classTotal > 20, `the class scan must find the tree's classes (saw ${classTotal})`);
assert.ok(getterTotal >= 10, `the getter scan must see real getters, not zero (saw ${getterTotal})`);
assert.ok(
  getterWithModifier >= 1,
  "modifier-prefixed getters must be parsed — that shape (`private get x()`) used to be invisible"
);

if (all.length > 0) {
  console.error("accessor convention violated:\n");
  for (const v of violations) console.error(`  [duplicate] ${v.file} — ${v.cls}: ${v.detail}`);
  for (const v of methodOnlyViolations) console.error(`  [getter-not-allowed] ${v.file} — ${v.cls}: ${v.detail}`);
  console.error(
    "\nReads must have ONE spelling per concept. In these classes use getXxx() / setXxx()" +
      " — the write side is already method-form, and a getter makes snapshot state read as plain data."
  );
  process.exit(1);
}

console.log("accessor convention validation passed (no duplicate reads, no getters in frozen classes)");
