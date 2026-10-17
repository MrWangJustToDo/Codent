/**
 * Validation: every `toModelOutput` projection is idempotent.
 *
 * Run: pnpm --filter @codent/core run validate:model-output-idempotency
 *
 * A tool result does not always reach `toModelOutput` in the tool's own shape. The content that gets
 * there can already be the projection's output — a re-run re-projecting a retained wire, a host
 * re-deriving a transcript it received, and (the case documented in
 * `agent/mcp/prefer-multimodal-content.ts`) any result whose value is an ARRAY, which TanStack
 * `normalize-stream-chunk` turns into the JSON text of a `ContentPart[]` before the projection ever
 * sees it. `read_file` and the MCP resolver both open with an idempotency check for exactly that
 * reason; this asserts the same of every one of the thirteen registered projections, and that a new
 * one cannot be added without it.
 *
 * Two halves, because either alone can pass vacuously:
 *
 *   1. fed its OWN output, a projection returns it untouched (the guard is present and correct);
 *   2. fed a RAW output, it still shapes it (the guard is not "return the input").
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBeginSummaryTool,
  createEditFileTool,
  createGetCommandOutputTool,
  createGlobTool,
  createGrepTool,
  createKillCommandTool,
  createListFileTool,
  createReadFileTool,
  createRunCommandTool,
  createSessionReadTool,
  createSessionSearchTool,
  createTaskTool,
  createTodoTool,
  createTreeTool,
  createWebfetchTool,
  createWebsearchTool,
  createWriteFileTool,
  isProjectedModelContent,
  toModelOutputRegistry,
  toPosixPath,
} from "../dist/dev.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// ============================================================================
// 0. The guard itself: what counts as "already projected"
// ============================================================================

{
  const parts = [{ type: "text", content: "already shaped" }];
  assert.equal(isProjectedModelContent(parts), true, "a ContentPart[] is projection output");
  assert.equal(isProjectedModelContent("already shaped"), true, "a plain string is projection output");
  assert.equal(isProjectedModelContent({}), false, "an object is a tool's raw output, not content");
  assert.equal(isProjectedModelContent({ matches: [] }), false, "…even one shaped like a tool result");
  assert.equal(isProjectedModelContent(null), false, "null is not content");
  assert.equal(isProjectedModelContent(undefined), false, "undefined is not content");
  assert.equal(isProjectedModelContent(42), false, "a number is not content");
  // The negative half is what makes the guard safe to open every projection with: every built-in
  // returns an OBJECT from `execute`, so a raw result can never be mistaken for its own projection.
  assert.equal(isProjectedModelContent([{ not: "a part" }]), false, "an array of non-parts is not content");
}

// ============================================================================
// 1. Every registered projection, driven with its own output
// ============================================================================

/**
 * One row per projection: how to create the tool (registration is a side effect) and a minimal RAW
 * output it can shape. The raw fixtures are also section 2's evidence that the guard does not
 * swallow real work, so each must be acceptable to its projection.
 */
const PROJECTIONS = [
  {
    name: "read_file",
    make: () => createReadFileTool(),
    raw: { type: "text", path: "a.ts", content: "1: const x = 1;\n" },
  },
  {
    name: "list_file",
    make: () => createListFileTool(),
    raw: { entries: [{ name: "a.ts", type: "file" }], offset: 0, limit: 10 },
  },
  { name: "glob", make: () => createGlobTool(), raw: { files: ["a.ts"], offset: 0, limit: 10 } },
  {
    name: "grep",
    make: () => createGrepTool(),
    raw: { matches: [{ file: "a.ts", lineNumber: 1, content: "const x" }], offset: 0, limit: 10 },
  },
  { name: "tree", make: () => createTreeTool(), raw: { tree: "a.ts\nb.ts" } },
  {
    name: "run_command",
    make: () => createRunCommandTool(),
    raw: { command: "ls", stdout: "a.ts\n", stderr: "", exitCode: 0, success: true },
  },
  {
    name: "get_command_output",
    make: () => createGetCommandOutputTool(),
    raw: { jobId: "job-1", status: "running", running: true, exitCode: null },
  },
  {
    name: "kill_command",
    make: () => createKillCommandTool(),
    raw: { killed: true, jobId: "job-1", status: "exited" },
  },
  { name: "write_file", make: () => createWriteFileTool(), raw: { created: true, path: "a.ts" } },
  {
    name: "webfetch",
    make: () => createWebfetchTool({ managed: undefined }),
    raw: {
      url: "https://x",
      finalUrl: "https://x",
      content: "body",
      contentType: "text/plain",
      isImage: false,
      cancelled: false,
    },
  },
  {
    name: "websearch",
    make: () => createWebsearchTool({ managed: undefined }),
    raw: { query: "q", provider: "duckduckgo", results: [] },
  },
  { name: "session_read", make: () => createSessionReadTool({ managed: undefined }), raw: { content: "page" } },
  {
    name: "session_search",
    make: () => createSessionSearchTool({ managed: undefined }),
    raw: { query: "q", matches: [], truncated: false },
  },
  {
    name: "task",
    make: () => createTaskTool({ parentAgentId: "a", manager: { getAgent: () => undefined } }),
    raw: { summary: "done", reachedLimit: false, incomplete: false, aborted: false, truncated: false },
  },
  {
    name: "todo",
    make: () => createTodoTool({ todoManager: { getTitle: () => null } }),
    raw: { title: "T", items: [], source: "plan" },
  },
  { name: "edit_file", make: () => createEditFileTool(), raw: { path: "a.ts", replacements: 1 } },
  // Its projection ignores the output entirely, so the guard passes the input straight back — the
  // two are the same constant either way, and the guard keeps the rule uniform.
  { name: "begin_summary", make: () => createBeginSummaryTool(), raw: {} },
];

const PART_ARRAY = [{ type: "text", content: "already shaped" }];

for (const { name, make, raw } of PROJECTIONS) {
  make();
  const project = toModelOutputRegistry.get(name);
  assert.equal(typeof project, "function", `${name}: registers its projection through the real factory`);

  // 1a. Its own output, as an array — the shape TanStack stringifies into the content a later
  // projection reads back.
  const fromParts = await project({ toolCallId: "c", input: {}, output: PART_ARRAY });
  assert.deepEqual(fromParts, PART_ARRAY, `${name}: a re-projection of its ContentPart[] output is a no-op`);

  // 1b. Its own output, as the string form of the same thing (read_file's text branch returns one,
  // and a JSON-stringified array is how an array result is persisted).
  const asString = JSON.stringify(PART_ARRAY);
  const fromString = await project({ toolCallId: "c", input: {}, output: asString });
  assert.equal(fromString, asString, `${name}: a re-projection of its string output is a no-op`);

  // 2. A RAW output still goes through the projection: the guard must not have turned the whole
  // function into an identity.
  const shaped = await project({ toolCallId: "c", input: {}, output: raw });
  assert.notDeepEqual(
    shaped,
    raw,
    `${name}: a raw output is still shaped — the idempotency guard did not swallow the projection`
  );
}

// ============================================================================
// 2. Every declaration site carries the guard
// ============================================================================
//
// A source check rather than a roster, because the behavioural half can only drive the projections
// whose factories are reachable from `dev.mjs`. This counts declaration sites (both spellings a
// `defineServerTool` / `registerTool` option can take) against guard call sites per file, so a new
// projection — or a site that drops the guard — fails here even when it cannot be instantiated.
//
// `read_file` is the one indirection: its projection delegates to the shared formatter, which owns
// the guard. Listed explicitly so the exception stays visible instead of being a silent allowlist.
const DELEGATES = [
  {
    file: "agent/tools/read-file-tool.ts",
    to: "agent/tools/util/format-read-file-result.ts",
    why: "the projection delegates to the shared formatter, which owns its guard",
  },
  {
    file: "agent/code-mode/extension.ts",
    to: "agent/code-mode/model-output.ts",
    why: "the projection delegates to the code-mode media lifter, which owns its guard",
  },
];

{
  const walk = (dir) =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
    });

  // The relative path must be POSIX-normalized before it is compared: `readdir` yields
  // `agent\tools\read-file-tool.ts` on Windows while the allowlist is written for `/`. That mismatch
  // is not hypothetical — it is what made CI red on Windows, where the delegating entry stopped
  // matching and `read-file-tool.ts` was counted as an unguarded declaration site.
  const delegatingFiles = new Set(DELEGATES.map((d) => toPosixPath(d.file)));
  const isDelegating = (rel) => delegatingFiles.has(toPosixPath(rel));
  const relOf = (file) => toPosixPath(file.replace(SRC, ""));

  // Both spellings, asserted here so the rule is exercised on any platform (`toPosixPath`'s own
  // contract: the Windows-shaped case is reachable and testable on Linux).
  assert.equal(isDelegating("agent/tools/read-file-tool.ts"), true, "a POSIX checkout matches the delegating entry");
  assert.equal(
    isDelegating("agent\\tools\\read-file-tool.ts"),
    true,
    "so does a Windows checkout — the comparison must fold separators"
  );

  let declarations = 0;

  for (const file of walk(join(SRC, "agent"))) {
    const rel = relOf(file);
    assert.ok(!rel.includes("\\"), `${rel}: the relative path must be POSIX-normalized before matching`);
    const src = readFileSync(file, "utf8");
    const sites =
      (src.match(/toModelOutput\(\{ output \}/g) ?? []).length + (src.match(/toModelOutput: \(/g) ?? []).length;
    const guards = (src.match(/isProjectedModelContent\(output\)/g) ?? []).length;
    declarations += sites;

    if (isDelegating(rel)) {
      assert.equal(sites, 1, `${rel}: the delegating projection is still a single site`);
      continue;
    }
    if (sites === 0) continue;
    assert.ok(
      guards >= sites,
      `${rel}: ${sites} projection site(s) but ${guards} idempotency guard(s) — every \`toModelOutput\` must ` +
        `open with \`if (isProjectedModelContent(output)) return output;\``
    );
  }

  // A site count this far from the known set means the walk stopped matching (a refactor renamed the
  // declaration shape), which would silently turn the check above into a no-op.
  assert.ok(
    declarations >= 24,
    `the walk found ${declarations} projection sites; it is expected to see every \`toModelOutput\` in ` +
      `agent/ — if the declaration shape changed, update the patterns here`
  );

  for (const { file, to, why } of DELEGATES) {
    assert.ok(readFileSync(join(SRC, file), "utf8").includes("toModelOutput"), `${file} still declares a projection`);
    assert.ok(readFileSync(join(SRC, to), "utf8").includes("isProjectedModelContent(output)"), `${file}: ${why}`);
  }
}

console.log("model-output-idempotency validation passed");
