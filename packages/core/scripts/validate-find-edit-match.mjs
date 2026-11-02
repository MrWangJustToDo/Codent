/**
 * Validates edit matching and batch application:
 * - the five-level ladder (exact → trimEnd → trim → Unicode → Unicode+trim) and its order;
 * - uniqueness / replaceAll / overlap / identical (skipped) semantics;
 * - every edit matched against the ORIGINAL content, never incrementally;
 * - BOM + CRLF round-trips and offset-safe splicing;
 * - the failure hint (closest numbered lines, already-applied detection).
 *
 * Run: pnpm --filter @codent/core run validate:find-edit-match
 */
import assert from "node:assert/strict";

import {
  applyEdits,
  applyEditsToText,
  detectLineEnding,
  expandMatchVariants,
  findEditMatch,
  formatNotFoundHint,
  splitBom,
  toLF,
  unescapeCommonEscapes,
} from "../dist/dev.mjs";

const apply = (content, edits) => applyEdits(content, edits);

// ---------------------------------------------------------------------------
// 1. Exact match, and the over-escape variants models still produce
// ---------------------------------------------------------------------------

{
  const file = "description: `Edits via the \\`edits\\` array.`;\n";
  const exact = findEditMatch(file, "description: `Edits via the \\`edits\\` array.`;", "description: `ok`;");
  assert.equal(exact.ok, true);
  assert.equal(exact.match.mode, "exact");

  // Over-escaped needle (extra backslashes) → an unescape variant hits the file.
  const overEscaped = "description: `Edits via the \\\\`edits\\\\` array.`;";
  assert.ok(expandMatchVariants(overEscaped).includes("description: `Edits via the \\`edits\\` array.`;"));
  const unesc = findEditMatch(file, overEscaped, "description: `ok`;");
  assert.equal(unesc.ok, true);
  assert.equal(
    applyEditsToText(file, [{ oldString: overEscaped, newString: "description: `ok`;" }]).content,
    "description: `ok`;\n"
  );

  assert.equal(unescapeCommonEscapes("a\\nb"), "a\nb");
  const nl = findEditMatch("a\nb\n", "a\\nb", "x");
  assert.equal(nl.ok, true);
}

// ---------------------------------------------------------------------------
// 2. newString is written verbatim (no `$` replacement expansion)
// ---------------------------------------------------------------------------

for (const literal of ["$$", "$&", "$`", "$'", "$1", "$<name>"]) {
  const result = apply("a 1 b 1\n", [{ oldString: "1", newString: literal, replaceAll: true }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, `a ${literal} b ${literal}\n`, `newString ${JSON.stringify(literal)} is verbatim`);
}

// ---------------------------------------------------------------------------
// 3. The matching ladder, conservative first
// ---------------------------------------------------------------------------

{
  // trimEnd: the model reproduced the line without the file's trailing whitespace. A needle that
  // includes the newline is not an exact substring when the file has spaces before it.
  const file = "const a = 1;   \nconst b = 2;\n";
  const match = findEditMatch(file, "const a = 1;\n", "const a = 9;\n");
  assert.equal(match.ok, true);
  assert.equal(match.match.mode, "trimEnd");
  assert.equal(
    apply(file, [{ oldString: "const a = 1;\n", newString: "const a = 9;\n" }]).content,
    "const a = 9;\nconst b = 2;\n"
  );

  // A partial-line needle is an exact substring; the ladder must not make it fuzzy.
  const partial = findEditMatch(file, "const a = 1;", "const a = 9;");
  assert.equal(partial.match.mode, "exact");

  // trim: indentation drifted (the failure seen most often in real sessions).
  const indented = "if (x) {\n    doThing();\n}\n";
  const drifted = findEditMatch(indented, "if (x) {\n  doThing();\n}", "if (x) {\n    doOther();\n}");
  assert.equal(drifted.ok, true);
  assert.equal(drifted.match.mode, "trim");

  // Unicode: typographic quotes in the file, ASCII in the request.
  const curly = "say \u201Chello\u201D\n";
  const fuzzy = findEditMatch(curly, 'say "hello"\n', "ok\n");
  assert.equal(fuzzy.ok, true);
  assert.equal(fuzzy.match.mode, "unicode");
  assert.equal(apply(curly, [{ oldString: 'say "hello"\n', newString: "ok\n" }]).content, "ok\n");
}

// ---------------------------------------------------------------------------
// 4. Uniqueness, replaceAll, overlap, identical
// ---------------------------------------------------------------------------

{
  const multi = apply("aa\naa\naa\n", [{ oldString: "aa", newString: "b" }]);
  assert.equal(multi.ok, false);
  assert.match(multi.message, /3 matches at lines 1, 2, 3/);

  const all = apply("aa aa\n", [{ oldString: "aa", newString: "b", replaceAll: true }]);
  assert.equal(all.ok, true);
  assert.equal(all.content, "b b\n");

  // Overlap is refused, not silently ordered.
  const overlap = apply("alpha beta\n", [
    { oldString: "alpha beta", newString: "A B" },
    { oldString: "beta", newString: "B" },
  ]);
  assert.equal(overlap.ok, false);
  assert.match(overlap.message, /overlap/);

  // Identical old/new is a no-op (skipped), not an error — the rest of the batch applies.
  const noop = apply("keep\nchange\n", [
    { oldString: "keep", newString: "keep" },
    { oldString: "change", newString: "changed" },
  ]);
  assert.equal(noop.ok, true);
  assert.deepEqual(noop.skipped, [0]);
  assert.equal(noop.content, "keep\nchanged\n");

  // …but only when the text is actually there. A no-op for absent text is still not-found.
  const phantomNoop = apply("x\n", [{ oldString: "absent", newString: "absent" }]);
  assert.equal(phantomNoop.ok, false);
  assert.match(phantomNoop.message, /not found/);

  // Adjacent ranges (end == next start) are allowed; they are not an overlap.
  const adjacent = apply("ab", [
    { oldString: "a", newString: "A" },
    { oldString: "b", newString: "B" },
  ]);
  assert.equal(adjacent.ok, true);
  assert.equal(adjacent.content, "AB");

  // An escaped oldString whose replacement is the matched bytes changes nothing → skipped, not a
  // reported replacement.
  const escapedNoop = apply("a\nb\n", [{ oldString: "a\\nb", newString: "a\nb" }]);
  assert.equal(escapedNoop.ok, true);
  assert.deepEqual(escapedNoop.skipped, [0]);
}

// ---------------------------------------------------------------------------
// 4b. Line-level matches keep the file's indentation
// ---------------------------------------------------------------------------

{
  const file = "if (x) {\n    return 1;  \n}\n";
  const result = apply(file, [{ oldString: "return 1;\n", newString: "return 2;\n" }]);
  assert.equal(result.ok, true);
  assert.equal(
    result.content,
    "if (x) {\n    return 2;\n}\n",
    "a needle without indentation inherits the matched line's indentation"
  );
}

// ---------------------------------------------------------------------------
// 4c. No phantom final line / no zero-length match
// ---------------------------------------------------------------------------

{
  // The file has no blank line after `b`, so a needle that claims one cannot match.
  const phantom = apply("a\nb\n", [{ oldString: "a\nb\n\n", newString: "X\n" }]);
  assert.equal(phantom.ok, false);

  // A tab-only line does not match the synthetic final line either.
  const blank = apply("a\n", [{ oldString: "\t\n", newString: "X\n" }]);
  assert.equal(blank.ok, false);
}

// ---------------------------------------------------------------------------
// 4d. The replacement is unescaped at the SAME depth as the old string
// ---------------------------------------------------------------------------

{
  const file = "a\\b\n"; // one literal backslash
  const overOld = "a\\\\\\\\b"; // four backslashes → two unescape passes
  const overNew = "c\\\\\\\\d";
  const result = apply(file, [{ oldString: overOld, newString: overNew }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, "c\\d\n", "two passes on oldString means two on newString");
}

// ---------------------------------------------------------------------------
// 5. Every edit matches the ORIGINAL content (not incrementally)
// ---------------------------------------------------------------------------

{
  // The first edit inserts a line that equals the second edit's oldString. Matched incrementally,
  // the second would become ambiguous; matched against the original, it is unique.
  const content = "alpha\nbeta\n";
  const result = apply(content, [
    { oldString: "alpha", newString: "alpha\nbeta" },
    { oldString: "beta", newString: "BETA" },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.content, "alpha\nbeta\nBETA\n");
}

// ---------------------------------------------------------------------------
// 6. BOM + CRLF round-trips, and offset safety
// ---------------------------------------------------------------------------

{
  const raw = "\uFEFFa = 1;\r\nb = 2;\r\n";
  const { bom, text } = splitBom(raw);
  assert.equal(bom, "\uFEFF");
  assert.equal(text, "a = 1;\r\nb = 2;\r\n");
  assert.equal(detectLineEnding(text), "\r\n");
  assert.equal(toLF(text), "a = 1;\nb = 2;\n");

  const result = applyEditsToText(raw, [{ oldString: "b = 2;", newString: "b = 3;" }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, "\uFEFFa = 1;\r\nb = 3;\r\n");

  // A multi-line edit written with LF against a CRLF file must still match.
  const multiline = applyEditsToText("function f() {\r\n  return 1;\r\n}\r\n", [
    { oldString: "function f() {\n  return 1;\n}", newString: "function f() {\n  return 2;\n}" },
  ]);
  assert.equal(multiline.ok, true);
  assert.equal(multiline.content, "function f() {\r\n  return 2;\r\n}\r\n");
}

{
  // Zero-width characters must not shift the splice point (the old fuzzy path corrupted this).
  const content = "pre\u200B \u201Chello\u201D post\n";
  const result = apply(content, [{ oldString: '"hello"', newString: '"bye"' }]);
  assert.equal(result.ok, true);
  assert.equal(result.content, 'pre\u200B "bye" post\n');
  assert.ok(!result.content.includes("\u201D"), "no orphaned closing quote");
}

// ---------------------------------------------------------------------------
// 7. Failure hints
// ---------------------------------------------------------------------------

{
  // Most lines match, the middle one does not: show the numbered block so the model can fix it.
  const missing = apply("alpha\nfunction createEditFileTool() {\n  return 1;\n}\nomega\n", [
    { oldString: "function createEditFileTool() {\n  return 2;\n}", newString: "x" },
  ]);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /Closest lines in the file:/);
  assert.match(missing.message, /2: function createEditFileTool\(\) \{/);

  // The replacement is already present → say so rather than showing unrelated lines.
  assert.match(
    formatNotFoundHint(
      "const done = true;\nexport { done };\n",
      "const finished = true;",
      "const done = true;\nexport { done };"
    ),
    /already in the file/
  );

  // No anchor at all → the generic guidance names the line-number prefix trap.
  assert.match(formatNotFoundHint("hello\n", "zzzzzzzz", "q"), /line-number prefix/);
}

console.log("validate-find-edit-match: ok");
