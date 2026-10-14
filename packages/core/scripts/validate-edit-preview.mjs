/**
 * Validation: the approval preview is the write.
 *
 * Run: pnpm --filter @codent/core run validate:edit-preview
 *
 * `previewEdit` renders the before/after diff a user approves *before* `edit_file` runs. It re-implemented
 * the tool's matching (exact `includes` → fuzzy) instead of calling it, and drifted in three ways that
 * all point the same direction — a diff that is not the write:
 *
 *   - it never tried the over-escape variants the tool tries, so an escaped `oldString` previewed as
 *     "no change" while the tool would have written one;
 *   - it ignored `startLine`, so with several matches the preview rewrote the first while the tool
 *     rewrote the one near that line;
 *   - it did not enforce uniqueness, so an edit the tool refuses previewed as an applied change.
 *
 * This drives the REAL tool and the preview over one in-memory file and asserts they agree: same
 * `newFile`, or (when the tool refuses and writes nothing) an unchanged preview plus the tool's own
 * reason. The assertion is on the bytes, so it cannot pass by both sides describing the same mistake.
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

/** Run the real tool, returning either its result or the error it threw (it throws to refuse). */
async function runTool(env, edits) {
  try {
    const result = await createEditFileTool().execute({ path: FILE, edits }, { coreEnv: env, toolCallId: "call-1" });
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
    // The tool's match order tries `\\n` → newline. The preview used to look for the literal `\\n`.
    label: "an over-escaped oldString (the tool unescapes it)",
    content: "one\ntwo\n",
    edits: [{ oldString: "one\\ntwo", newString: "ONE\\nTWO" }],
  },
  {
    // Two identical hits; the tool rewrites the one near `startLine`. The preview rewrote the first.
    label: "startLine selects the occurrence",
    content: "keep\nsame\nkeep\nsame\nkeep\n",
    edits: [{ oldString: "same", newString: "SAME", startLine: 4 }],
  },
  {
    label: "replaceAll rewrites every occurrence",
    content: "same\nsame\n",
    edits: [{ oldString: "same", newString: "SAME", replaceAll: true }],
  },
  {
    // Fuzzy: the file has a typographic apostrophe, the model typed ASCII.
    label: "a fuzzy (typographic) match",
    content: "it\u2019s here\n",
    edits: [{ oldString: "it's here", newString: "it is here" }],
  },
  {
    label: "an ambiguous match with no startLine — the tool refuses",
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
    label: "two edits applied in sequence",
    content: "alpha\nbeta\n",
    edits: [
      { oldString: "alpha", newString: "ALPHA" },
      { oldString: "beta", newString: "BETA" },
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
// The two shapes that motivated this: a diff that showed no change, and one that
// showed the change somewhere else
// ============================================================================

{
  const { env, files } = makeEnv("one\ntwo\n");
  clearCoreEnv();
  registerCoreEnv(env);
  const edits = [{ oldString: "one\\ntwo", newString: "ONE\\nTWO" }];
  const preview = await previewEdit({ path: FILE, edits }, env);
  assert.equal(preview.oldFile, "one\ntwo\n", "the preview reports the file as it was");
  assert.equal(files.get(FILE), "one\ntwo\n", "and writes nothing by itself");
  assert.notEqual(
    preview.newFile,
    preview.oldFile,
    "an escaped oldString the tool would unescape must not preview as 'no change'"
  );
}

{
  const { env } = makeEnv("keep\nsame\nkeep\nsame\nkeep\n");
  clearCoreEnv();
  registerCoreEnv(env);
  const preview = await previewEdit(
    { path: FILE, edits: [{ oldString: "same", newString: "SAME", startLine: 4 }] },
    env
  );
  assert.equal(
    preview.newFile,
    "keep\nsame\nkeep\nSAME\nkeep\n",
    "startLine decides WHICH occurrence changes — the diff must show that one"
  );
}

console.log("edit-preview validation passed");
