/**
 * Validation: the approval preview is the write.
 *
 * Run: pnpm --filter @codent/core run validate:edit-preview
 *
 * `previewEdit` renders the before/after diff a user approves *before* `edit_file` runs. Both sides
 * call the SAME pipeline (`applyEditsToText`: BOM split, LF view, matching ladder, non-overlap,
 * splice, line-ending restore), so they cannot disagree about which bytes would be written.
 *
 * This drives the REAL tool and the preview over one in-memory file and asserts they agree on the
 * bytes: same `newFile`, or (when the tool refuses and writes nothing) an unchanged preview plus the
 * tool's own reason. The assertion is on the bytes, so it cannot pass by both sides describing the
 * same mistake.
 */

import assert from "node:assert/strict";

import { createEditFileTool, clearCoreEnv, registerCoreEnv } from "../dist/dev.mjs";
import { previewEdit } from "../dist/index.mjs";

const FILE = "src/a.ts";

/** A CoreEnv holding one file in memory; `readFile`/`writeFile` are all the tool and preview use. */
function makeEnv(content) {
  const files = new Map([[FILE, content]]);
  const env = {
    rootPath: "/repo",
    path: { resolve: (p) => p },
    fs: {
      readFile: async (p) => {
        if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
        return files.get(p);
      },
      writeFile: async (p, c) => {
        files.set(p, c);
      },
    },
  };
  return { env, files };
}

/**
 * Run the real tool the way the runtime does: parse the raw input through the tool's schema (which
 * performs the argument coercion) and execute with a run context. Returns the result or the thrown
 * error (it throws to refuse).
 */
async function runTool(env, edits, extra = {}) {
  const tool = createEditFileTool();
  try {
    const parsed = tool.inputSchema.parse({ path: FILE, edits, ...extra });
    const result = await tool.execute(parsed, { toolCallId: "call-1", context: { coreEnv: env } });
    return { result, error: null };
  } catch (error) {
    return { result: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// ============================================================================
// The cases
// ============================================================================

const CASES = [
  {
    label: "a plain exact edit",
    content: "const a = 1;\nconst b = 2;\n",
    edits: [{ oldString: "const b = 2;", newString: "const b = 3;" }],
  },
  {
    label: "an over-escaped oldString (the tool unescapes it)",
    content: "one\ntwo\n",
    edits: [{ oldString: "one\\ntwo", newString: "ONE\\nTWO" }],
  },
  {
    label: "replaceAll rewrites every occurrence",
    content: "same\nsame\n",
    edits: [{ oldString: "same", newString: "SAME", replaceAll: true }],
  },
  {
    // Fuzzy: the file has typographic quotes, the model typed ASCII.
    label: "a typographic (Unicode) match",
    content: "it\u2019s here\n",
    edits: [{ oldString: "it's here", newString: "it is here" }],
  },
  {
    // The failure that dominated real sessions: indentation drift.
    label: "indentation drift (trim level)",
    content: "if (x) {\n    doThing();\n}\n",
    edits: [{ oldString: "if (x) {\n  doThing();\n}", newString: "if (x) {\n  doOther();\n}" }],
  },
  {
    label: "trailing whitespace in the file (trimEnd level)",
    content: "const a = 1;   \n",
    edits: [{ oldString: "const a = 1;", newString: "const a = 9;" }],
  },
  {
    label: "a CRLF file edited with LF text",
    content: "a = 1;\r\nb = 2;\r\n",
    edits: [{ oldString: "b = 2;", newString: "b = 3;" }],
  },
  {
    label: "identical old/new is a no-op, not a failure",
    content: "unchanged\n",
    edits: [{ oldString: "unchanged", newString: "unchanged" }],
  },
  {
    label: "an ambiguous match — the tool refuses",
    content: "same\nsame\n",
    edits: [{ oldString: "same", newString: "SAME" }],
  },
  {
    label: "no match at all — the tool refuses",
    content: "hello\n",
    edits: [{ oldString: "absent", newString: "x" }],
  },
  {
    // The second edit cannot resolve, and the tool writes NOTHING when any edit fails. A preview that
    // applied the first one would show a diff for a write that never happens.
    label: "the second edit fails after the first resolved",
    content: "x\n",
    edits: [
      { oldString: "x", newString: "X" },
      { oldString: "absent", newString: "y" },
    ],
  },
  {
    // Both edits are matched against the ORIGINAL file: the first inserts a line the second edits,
    // which would become ambiguous under sequential matching.
    label: "edits are matched against the original, not incrementally",
    content: "alpha\nbeta\n",
    edits: [
      { oldString: "alpha", newString: "alpha\nbeta" },
      { oldString: "beta", newString: "BETA" },
    ],
  },
  {
    label: "overlapping edits are refused",
    content: "alpha beta\n",
    edits: [
      { oldString: "alpha beta", newString: "A B" },
      { oldString: "beta", newString: "B" },
    ],
  },
];

for (const { label, content, edits } of CASES) {
  // The preview reads the file it is previewing, so it runs BEFORE the tool writes — and on its own
  // copy, since both read the same workspace path.
  const { env: previewEnv } = makeEnv(content);
  clearCoreEnv();
  registerCoreEnv(previewEnv);
  const preview = await previewEdit({ path: FILE, edits }, previewEnv);

  const { env, files } = makeEnv(content);
  clearCoreEnv();
  registerCoreEnv(env);
  const tool = await runTool(env, edits);
  const written = files.get(FILE) ?? content;

  assert.equal(preview.oldFile, content, `${label}: the preview reports the file it read`);
  assert.equal(preview.newFile, written, `${label}: the preview must equal what the tool wrote`);

  if (tool.error) {
    assert.equal(written, content, `${label}: a refused edit set writes nothing`);
    assert.equal(preview.newFile, content, `${label}: …so the preview is unchanged, not partially applied`);
    assert.ok(preview.error, `${label}: and it carries the reason the diff is empty`);
    assert.ok(
      tool.error.includes(preview.error),
      `${label}: the reason must be the tool's own ("${tool.error}" should contain "${preview.error}")`
    );
  } else {
    assert.equal(preview.error, undefined, `${label}: a successful set reports no error`);
    assert.equal(tool.result.path, FILE, `${label}: the tool reported the file it wrote`);
  }
}

// ============================================================================
// The shapes that motivated the rewrite
// ============================================================================

{
  // A CRLF file must come back as CRLF, and the preview must show those exact bytes.
  const content = "function f() {\r\n  return 1;\r\n}\r\n";
  const { env, files } = makeEnv(content);
  clearCoreEnv();
  registerCoreEnv(env);
  const edits = [{ oldString: "function f() {\n  return 1;\n}", newString: "function f() {\n  return 2;\n}" }];
  const preview = await previewEdit({ path: FILE, edits }, env);
  assert.equal(files.get(FILE), content, "the preview writes nothing by itself");
  const tool = await runTool(env, edits);
  assert.equal(tool.error, null, "a CRLF file edited with LF text succeeds");
  assert.equal(files.get(FILE), "function f() {\r\n  return 2;\r\n}\r\n", "line endings are preserved");
  assert.equal(preview.newFile, files.get(FILE), "the preview and the write agree byte-for-byte");
}

{
  // Identical old/new: the tool succeeds with zero replacements and leaves the file alone.
  const { env, files } = makeEnv("same\n");
  clearCoreEnv();
  registerCoreEnv(env);
  const tool = await runTool(env, [{ oldString: "same", newString: "same" }]);
  assert.ok(tool.error === null, "an identical pair is not an error");
  assert.equal(tool.result.replacements, 0);
  assert.equal(tool.result.results[0].skipped, true, "it is reported as skipped");
  assert.equal(files.get(FILE), "same\n", "and the file is untouched");
}

{
  // The diff must show the block the ladder actually matched, including indentation that differs.
  const { env } = makeEnv("if (x) {\n    doThing();\n}\n");
  clearCoreEnv();
  registerCoreEnv(env);
  const preview = await previewEdit(
    { path: FILE, edits: [{ oldString: "if (x) {\n  doThing();\n}", newString: "if (x) {\n  doOther();\n}" }] },
    env
  );
  assert.notEqual(preview.newFile, preview.oldFile, "an indentation-drifted match must preview as a change");
  assert.match(preview.newFile, /doOther/, "and the diff shows the replacement");
}

// ============================================================================
// Accepted argument shapes reach BOTH the tool and the preview
// ============================================================================

{
  const tool = createEditFileTool();
  const shapes = [
    ["stringified edits", JSON.stringify([{ oldString: "a", newString: "b" }])],
    ["single edit object", { oldString: "a", newString: "b" }],
  ];

  for (const [label, edits] of shapes) {
    const parsed = tool.inputSchema.parse({ path: FILE, edits });
    assert.deepEqual(parsed.edits, [{ oldString: "a", newString: "b" }], `${label}: coerced by the schema`);

    const { env: previewEnv } = makeEnv("a\n");
    const preview = await previewEdit({ path: FILE, edits }, previewEnv);
    assert.equal(preview.newFile, "b\n", `${label}: the preview sees the coerced edit`);

    const { env, files } = makeEnv("a\n");
    clearCoreEnv();
    registerCoreEnv(env);
    const outcome = await runTool(env, edits);
    assert.equal(outcome.error, null, `${label}: the tool runs`);
    assert.equal(files.get(FILE), "b\n", `${label}: the tool writes the same bytes the preview showed`);
  }

  // Legacy top-level oldText/newText pair.
  const parsed = tool.inputSchema.parse({ path: FILE, oldText: "a", newText: "b" });
  assert.deepEqual(parsed.edits, [{ oldString: "a", newString: "b" }], "legacy top-level pair is coerced");
  const { env: legacyEnv } = makeEnv("a\n");
  const legacyPreview = await previewEdit({ path: FILE, oldText: "a", newText: "b" }, legacyEnv);
  assert.equal(legacyPreview.newFile, "b\n", "the legacy pair previews the edit");

  const { env: legacyRunEnv, files: legacyFiles } = makeEnv("a\n");
  clearCoreEnv();
  registerCoreEnv(legacyRunEnv);
  const legacyRun = await runTool(legacyRunEnv, undefined, { oldText: "a", newText: "b" });
  assert.equal(legacyRun.error, null, "the legacy pair runs");
  assert.equal(legacyFiles.get(FILE), "b\n");
}

// ============================================================================
// Write safety: external change is refused; an all-identical batch writes nothing
// ============================================================================

{
  let reads = 0;
  const env = {
    rootPath: "/repo",
    path: { resolve: (p) => p },
    fs: {
      readFile: async () => (++reads === 2 ? "a\nexternal\n" : "a\n"),
      writeFile: async () => {
        throw new Error("must not write after an external change");
      },
    },
  };
  clearCoreEnv();
  registerCoreEnv(env);
  const outcome = await runTool(env, [{ oldString: "a", newString: "b" }]);
  assert.match(outcome.error ?? "", /changed since it was read/);
}

{
  const env = {
    rootPath: "/repo",
    path: { resolve: (p) => p },
    fs: {
      readFile: async () => "same\n",
      writeFile: async () => {
        throw new Error("an all-identical batch must not write");
      },
    },
  };
  clearCoreEnv();
  registerCoreEnv(env);
  const outcome = await runTool(env, [{ oldString: "same", newString: "same" }]);
  assert.equal(outcome.error, null, "an all-identical batch succeeds");
  assert.equal(outcome.result.replacements, 0);
}

console.log("edit-preview validation passed");
