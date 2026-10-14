/**
 * Validation: the user-cancel contract is one semantic with two wire shapes.
 *
 * Run: pnpm --filter @codent/core run validate:cancel-semantics
 *
 * A cancelled tool call can be written by three producers, and they do not agree on the field
 * name: the framework fallback and the built-in tools that catch their own abort write
 * `cancelled: true`, while the `task` tool writes `aborted: true` (its subagent cancels
 * instead of throwing, so the tool returns normally). Reading only one of the two is how the
 * original defect appeared — "only `task` shows cancelled".
 *
 * The invariant that keeps the two shapes one semantic is `isCancelledOutputMarker` (both
 * markers) plus `isSyntheticCancelOutput` (which of the two `cancelled` producers it is).
 * This script pins:
 *
 *   1. the marker tables — both markers, both read from `output` alone
 *   2. the framework fallback's real output — every tool gets a readable cancel, opted in or not
 *   3. both markers readable off a persisted part, the way a host reads them after a resume —
 *      and each SHAPE rendering as itself (the bare message for the synthetic payload, its own
 *      output for a tool that caught its own abort)
 *   4. "could Esc cut this tool short?" answered at every tool definition site, enforced
 *      against the source so a new tool cannot quietly skip the question
 *   5. the model-facing projection carries the flag (it is not a UI-only concern)
 *   6. the derived status flags cannot contradict a cancel
 *   7. the lifecycle events that report a cancel carry the verdict, and the log wording
 *      follows it — a cancel reaches the log as a cancel, a fault as a fault
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The render-layer readers are public (`@codent/core`) — a host uses them to render a part it
// was handed; the producers and the projection registry are internal (`dev.mjs`).
import {
  TOOL_CANCELLED_MESSAGE,
  applySubagentStopNotice,
  cancelInFlightToolCalls,
  cancelIncompleteToolCalls,
  createTaskTool,
  deriveSubagentRunStats,
  taskOutputSchema,
} from "../dist/dev.mjs";
import {
  formatToolOutput,
  getInlineSummary,
  isCancelledOutputMarker,
  isCancelledToolCall,
  isSyntheticCancelOutput,
} from "../dist/index.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

// ============================================================================
// 1. The marker tables: one semantic, two field names
// ============================================================================

assert.equal(isCancelledOutputMarker({ cancelled: true }), true, "`cancelled` is a cancel marker");
assert.equal(isCancelledOutputMarker({ aborted: true }), true, "`aborted` is a cancel marker");
assert.equal(isCancelledOutputMarker({ cancelled: false }), false, "an explicit false is not a cancel");
assert.equal(isCancelledOutputMarker({}), false, "no marker is not a cancel");
assert.equal(isCancelledOutputMarker(null), false, "a null output is not a cancel");
assert.equal(isCancelledOutputMarker("cancelled"), false, "a bare string is not a cancel");

// The two `cancelled` producers differ in kind, and only the empty one may skip rendering.
const synthetic = { success: false, error: TOOL_CANCELLED_MESSAGE, cancelled: true };
const ownCatch = { success: false, cancelled: true, command: "x", stdout: "partial", exitCode: -1 };
assert.equal(isSyntheticCancelOutput(synthetic), true, "the framework payload is the synthetic one");
assert.equal(isSyntheticCancelOutput(ownCatch), false, "a tool's own partial result is a real result");
assert.equal(isCancelledOutputMarker(ownCatch), true, "though both are cancels");

// The marker union lives in exactly one place. If a "cleanup" ever drops `aborted`, every
// persisted `task` row silently turns into a tool failure with nothing else failing.
const abortSrc = readFileSync(join(SRC, "runtime-types/abort.ts"), "utf8");
assert.ok(
  /\(output as \{ cancelled\?: boolean \}\)\.cancelled === true[\s\S]{0,120}\(output as \{ aborted\?: boolean \}\)\.aborted === true/.test(
    abortSrc
  ),
  "`isCancelledOutputMarker` must keep reading BOTH marker fields"
);
assert.ok(
  /const SYNTHETIC_CANCEL_KEYS = new Set\(\[[^\]]*"cancelled"[^\]]*"aborted"[^\]]*\]\)/.test(abortSrc),
  "the synthetic-payload key table must keep both markers"
);

// ============================================================================
// 2. The framework fallback: every tool gets a readable cancel, opted in or not
//
// Driven through the real writer (`cancelInFlightToolCalls` / `cancelIncompleteToolCalls`),
// not a hand-written payload — the original defect was that the marker was written only onto
// the appended `tool-result` and never onto the part output the host reads.
// ============================================================================

{
  const names = ["run_command", "task", "grep", "read_file", "glob", "list_file", "tree", "webfetch", "write_file"];

  const inFlight = (name) => [
    {
      id: `m-${name}`,
      role: "assistant",
      parts: [{ type: "tool-call", id: `call-${name}`, name, state: "input-complete", arguments: '{"path":"a.ts"}' }],
    },
  ];
  const truncated = (name) => [
    {
      id: `m-${name}`,
      role: "assistant",
      parts: [{ type: "tool-call", id: `call-${name}`, name, state: "input-streaming", arguments: '{"pa' }],
    },
  ];

  for (const name of names) {
    for (const [cancel, build] of [
      [cancelInFlightToolCalls, inFlight],
      [cancelIncompleteToolCalls, truncated],
    ]) {
      const [part, result] = cancel(build(name), TOOL_CANCELLED_MESSAGE)[0].parts;
      assert.equal(isCancelledToolCall(part), true, `${name}: the part carries the marker`);
      assert.equal(getInlineSummary(part, name), "cancelled", `${name}: the row reads as cancelled`);
      assert.equal(formatToolOutput(part.output, name), TOOL_CANCELLED_MESSAGE, `${name}: the body reads as cancelled`);
      // The wire copy must agree with the part, or the model sees a different verdict than the user.
      assert.ok(
        String(result.content).includes('"cancelled":true'),
        `${name}: the appended tool-result carries the marker for the model wire`
      );
      assert.equal(
        isCancelledOutputMarker(JSON.parse(String(result.content))),
        true,
        `${name}: wire output is a cancel`
      );
    }
  }

  // Same channel, opposite verdicts: a genuine failure must keep its own reading.
  const failure = {
    type: "tool-call",
    id: "call-f",
    name: "grep",
    state: "error",
    arguments: "{}",
    output: { error: "boom" },
  };
  assert.equal(isCancelledToolCall(failure), false, "a real failure is not a cancel");
  assert.equal(getInlineSummary(failure, "grep"), null, "and it keeps the failure verdict");
}

// ============================================================================
// 3. Both markers readable off a persisted part (a host's only view after a resume)
// ============================================================================

{
  const taskPart = {
    type: "tool-call",
    id: "call-t",
    name: "task",
    state: "complete",
    arguments: "{}",
    output: {
      subagentId: "sub_1",
      summary: applySubagentStopNotice("Now let me look at…", "user"),
      truncated: false,
      iterations: 1,
      maxIterations: 50,
      reachedLimit: false,
      incomplete: false,
      aborted: true,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, billedInputTokens: 2 },
      durationMs: 1,
      cachedOutputPath: null,
    },
  };
  assert.equal(isCancelledToolCall(taskPart), true, "the task tool's own marker is readable off the part");
  assert.equal(getInlineSummary(taskPart, "task"), "cancelled", "a cancelled task reads as cancelled on the row");
  const body = formatToolOutput(taskPart.output, "task");
  // A cancel that CARRIES output renders it. `formatToolOutput` short-circuits only the framework's
  // synthetic payload (section 2); reaching the tool's own formatter here is what keeps the cancel
  // notice in the detailed block instead of collapsing both shapes into the bare message.
  assert.ok(body.includes("cancelled"), `the detailed block words it as cancelled (${body})`);
  assert.ok(body.includes("[Task cancelled by user.]"), "and the cancel notice survives into the body");
  assert.ok(!body.includes("stalled"), "and it is never worded as a stall");

  // The other half of that shape: `run_command`'s own catch keeps the stdout the command had already
  // printed, alongside a synthesized `exitCode: -1` that must NOT be rendered as a result.
  const runCommandBody = formatToolOutput(
    {
      command: "sleep 10",
      stdout: "partial line one\npartial line two",
      stderr: "",
      exitCode: -1,
      success: false,
      cancelled: true,
    },
    "run_command"
  );
  assert.ok(
    runCommandBody.includes("partial line one"),
    `a cancelled run_command keeps the stdout it already produced (${runCommandBody})`
  );
  assert.ok(!/Exit code/.test(runCommandBody), "…and prints no exit code for a stopped command");

  // ...while a normal task result stays a normal result.
  const cleanPart = { ...taskPart, output: { ...taskPart.output, aborted: false, summary: "found it" } };
  assert.equal(isCancelledToolCall(cleanPart), false, "a clean task is not a cancel");
}

// ============================================================================
// 4. "Can Esc cut this tool short?" — answered at every definition site
//
// A tool that does not declare a marker is not broken: the fallback in section 2 still marks
// its row. It just cannot use `cancelled`/`aborted` as an *output field*, which only matters
// for a tool that catches its own abort to keep partial output. That is a real decision, so it
// is declared with the tool.
// ============================================================================

/** Tools whose own `catch` settles the abort must declare the marker they write. */
const CATCHER_TOOLS = [
  {
    file: "agent/tools/run-command-tool.ts",
    name: "run_command",
    marker: "cancelled",
    // Its `catch` returns a full result (partial stdout, synthesized exit code) with the marker.
    evidence: [
      [/cancelled: true/, "settles its own abort with `cancelled: true` instead of throwing"],
      [/isAbortError\(/, "classifies the abort through the shared predicate, not a local heuristic"],
    ],
  },
  {
    file: "agent/tools/webfetch-tool.ts",
    name: "webfetch",
    marker: "cancelled",
    evidence: [
      [/cancelled: true/, "settles its own abort with `cancelled: true` instead of throwing"],
      [/isAbortError\(/, "classifies the abort through the shared predicate"],
    ],
  },
  {
    file: "agent/tools/websearch-tool.ts",
    name: "websearch",
    marker: "cancelled",
    evidence: [
      [/cancelled: true/, "settles its own abort with `cancelled: true` instead of throwing"],
      [/isAbortError\(/, "classifies the abort through the shared predicate"],
    ],
  },
  {
    file: "agent/tools/grep-tool.ts",
    name: "grep",
    marker: "cancelled",
    // The search is the only step the run can stop, so the abort is caught there and reported as a
    // cancel — a killed `rg`'s empty stdout is not "no matches".
    evidence: [
      [/signal: abortSignal/, "passes the run's signal into the search, so Esc ends the spawn"],
      [/cancelled: true/, "settles its own abort with `cancelled: true` instead of throwing"],
      [/isAbortError\(/, "classifies the abort through the shared predicate, not a local heuristic"],
    ],
  },
  {
    file: "agent/tools/glob-tool.ts",
    name: "glob",
    marker: "cancelled",
    evidence: [
      [/signal: abortSignal/, "passes the run's signal into the search, so Esc ends the spawn"],
      [/cancelled: true/, "settles its own abort with `cancelled: true` instead of throwing"],
      [/isAbortError\(/, "classifies the abort through the shared predicate, not a local heuristic"],
    ],
  },
  {
    file: "agent/tools/tree-tool.ts",
    name: "tree",
    marker: "cancelled",
    // Both halves of this tool can run long: the spawn, and the native walk that replaces it.
    evidence: [
      [/signal: abortSignal/, "passes the run's signal into the spawn AND the walk"],
      [/cancelled: true/, "settles its own abort with `cancelled: true` instead of throwing"],
      [/isAbortError\(/, "classifies the abort through the shared predicate, not a local heuristic"],
    ],
  },
  {
    file: "agent/subagent/task-tool.ts",
    name: "task",
    marker: "aborted",
    // The task tool does not catch anything: its subagent cancels without throwing, so the flag
    // comes from the run result and is a required boolean on the output schema.
    evidence: [
      [/aborted: result\.aborted/, "passes the subagent's cancel verdict through untouched"],
      [/aborted: z\.boolean\(\)/, "declares it as a required boolean status flag"],
    ],
  },
];

/** Every other built-in tool, with the reason it needs no marker field. */
const NO_MARKER_REASON = {
  read_file: "no partial output worth keeping; the fallback marks the row",
  list_file: "no partial output worth keeping; the fallback marks the row",
  get_command_output: "background-job poll; a cancel leaves the job running, nothing to report",
  kill_command: "background-job control; synchronous",
  write_file: "synchronous and short; cannot be interrupted mid-write",
  edit_file: "synchronous and short; cannot be interrupted mid-write",
  delete_file: "synchronous and short; cannot be interrupted mid-write",
  todo: "local state mutation; nothing to report when cut short",
  complete_plan: "local state mutation; nothing to report when cut short",
  ask_user: "blocks on the user, not on the run; a cancel is the interaction layer's story",
  session_search: "read-only history scan; no partial output worth keeping, the fallback marks the row",
  session_read: "read-only history render; no partial output worth keeping, the fallback marks the row",
};

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
  });
}

{
  // Every `defineServerTool` / `defineClientTool` definition site, by source.
  const defined = [];
  for (const file of walk(join(SRC, "agent"))) {
    const src = readFileSync(file, "utf8");
    if (!/define(?:Server|Client)Tool\(/.test(src)) continue;
    // `\r?\n`, not `\n`: a Windows checkout has CRLF, and a literal `\n` matches nothing
    // there — which silently reported "found 0" tool definitions.
    for (const match of src.matchAll(/\bname: "([a-z_]+)",\r?\n/g)) defined.push({ name: match[1], file });
  }
  const names = defined.map((d) => d.name);
  assert.ok(names.length >= 12, `expected the built-in tool set, found ${names.length}: ${names.join(",")}`);
  for (const required of ["run_command", "task", "grep", "read_file", "todo", "webfetch"]) {
    assert.ok(names.includes(required), `${required} must be part of the enumerated tool set`);
  }

  const catcherNames = new Set(CATCHER_TOOLS.map((t) => t.name));
  for (const { name, file } of defined) {
    if (catcherNames.has(name)) continue;
    assert.ok(
      name in NO_MARKER_REASON,
      `${name} (${file.replace(SRC, "")}): unclassified — every tool must answer whether Esc can cut it ` +
        `short. Add it to CATCHER_TOOLS (it declares the marker it writes) or NO_MARKER_REASON (with why ` +
        `it declares none).`
    );
    assert.ok(NO_MARKER_REASON[name]?.trim().length > 10, `${name}: the no-marker reason must say something real`);
    // The two answers are exclusive: a tool that declares no marker must not write one.
    const src = readFileSync(file, "utf8");
    assert.ok(
      !/\bcancelled: true\b|\baborted: true\b/.test(src),
      `${name}: claims no cancel marker but writes one — the tables disagree with the source`
    );
  }

  // A stale entry is an error too: the two tables must describe the tool set exactly.
  for (const name of Object.keys(NO_MARKER_REASON)) {
    assert.ok(names.includes(name), `NO_MARKER_REASON.${name} is stale — no such tool definition site`);
  }
  for (const { file, name, evidence } of CATCHER_TOOLS) {
    assert.ok(names.includes(name), `CATCHER_TOOLS.${name} is stale — no such tool definition site`);
    const src = readFileSync(join(SRC, file), "utf8");
    for (const [pattern, why] of evidence) {
      assert.ok(pattern.test(src), `${name}: ${why}`);
    }
  }

  // The subagent side of the task tool: a cancel is recognized there, not in the tool.
  const runSubagentSrc = readFileSync(join(SRC, "agent/subagent/run-subagent.ts"), "utf8");
  assert.ok(
    /applySubagentStopNotice\(output, stopReason\)/.test(runSubagentSrc),
    "run-subagent: a stopped run appends the notice for its recorded reason, not an assumed one"
  );
  assert.ok(
    /resolveSubagentStopReason\(\{[\s\S]{0,120}abortSignal\?\.reason/.test(runSubagentSrc),
    "run-subagent: the reason comes from the abort signal — the channel every abort path uses"
  );
  // The child status is read through the accessor (see validate-accessor-convention.mjs),
  // so accept either spelling — what matters is that the *status* is one of the two inputs.
  assert.ok(
    /aborted \|\|[\s\S]{0,200}(?:getStatus\(\)|status) === "aborted"/.test(runSubagentSrc),
    "run-subagent: derives the flag from the child status AND the abort signal, not one of them"
  );
  const planSrc = readFileSync(join(SRC, "agent/plan/create-plan-tool.ts"), "utf8");
  assert.ok(
    /createPlanAuthoringTool\(name: "create_plan" \| "update_plan"/.test(planSrc),
    "create_plan / update_plan are still one parameterized authoring tool"
  );
  assert.ok(!/\bcancelled: true\b|\baborted: true\b/.test(planSrc), "plan authoring writes no cancel marker");
  const beginSummarySrc = readFileSync(join(SRC, "agent/subagent/begin-summary-tool.ts"), "utf8");
  assert.ok(/name: BEGIN_SUMMARY_TOOL_NAME/.test(beginSummarySrc), "begin_summary takes its name from a constant");
  // …and the places that RECOGNIZE a built-in read that same name, so renaming one stays a core-only
  // edit: a hardcoded literal keeps compiling while it quietly stops matching anything.
  const preforkMiddlewareSrc = readFileSync(join(SRC, "managers/middleware/task-prefork-middleware.ts"), "utf8");
  assert.ok(
    /=== BUILTIN_TOOL_NAMES\.task/.test(preforkMiddlewareSrc) && !/=== "task"/.test(preforkMiddlewareSrc),
    "the pre-fork middleware recognizes `task` through BUILTIN_TOOL_NAMES, not a literal"
  );
  assert.ok(
    /=== BEGIN_SUMMARY_TOOL_NAME/.test(runSubagentSrc) && !/=== "begin_summary"/.test(runSubagentSrc),
    "run-subagent recognizes the marker tool through BEGIN_SUMMARY_TOOL_NAME, not a literal"
  );
  assert.ok(!/\bcancelled: true\b|\baborted: true\b/.test(beginSummarySrc), "begin_summary writes no cancel marker");
}

// ============================================================================
// 5. The flag is not a UI-only concern: the model is told too
// ============================================================================

{
  // `defineServerTool` moves the projection into the registry, so the composed chain the engine
  // calls is `toModelOutputRegistry.get(name)` — that is what must carry the cancel notice.
  const toModelOutputRegistry = (await import("../dist/dev.mjs")).toModelOutputRegistry;

  createTaskTool({ parentAgentId: "a", manager: { getAgent: () => undefined } });
  const taskProjection = toModelOutputRegistry.get("task");
  assert.equal(typeof taskProjection, "function", "the task tool registers its model-facing projection");
  const projected = await taskProjection({
    toolCallId: "c",
    input: {},
    output: { summary: "partial", reachedLimit: false, incomplete: false, aborted: true, truncated: false },
  });
  const text = (Array.isArray(projected) ? projected : [projected]).map((p) => p?.content ?? "").join("\n");
  assert.ok(text.includes("aborted=true"), `the task projection must carry the cancel flag, got: ${text}`);
  assert.ok(text.includes("partial"), "and the summary the subagent produced");

  // A tool that catches its own abort must not let the model read a cancel as a result. The
  // three producers are registered through their real factories — the projection is part of the
  // contract, not a UI detail.
  const { createRunCommandTool, createWebfetchTool, createWebsearchTool } = await import("../dist/dev.mjs");
  for (const [name, make, output, expected] of [
    [
      "run_command",
      createRunCommandTool,
      { command: "x", stdout: "partial", stderr: "", exitCode: -1, success: false, cancelled: true },
      "[Command cancelled by user.]",
    ],
    [
      "websearch",
      createWebsearchTool,
      { query: "q", results: [], provider: "", cancelled: true },
      "[Search cancelled by user.]",
    ],
    [
      "webfetch",
      createWebfetchTool,
      { url: "u", content: "", contentType: "text/plain", cancelled: true },
      "[Fetch cancelled by user.]",
    ],
  ]) {
    assert.equal(typeof make, "function", `${name}: factory is reachable for the projection check`);
    make({ managed: undefined }); // registration is a side effect; the registry is what runs
    const toModelOutput = toModelOutputRegistry.get(name);
    assert.equal(typeof toModelOutput, "function", `${name}: registered its model-facing projection`);
    const out = await toModelOutput({ toolCallId: "c", input: {}, output });
    const body = (Array.isArray(out) ? out : [out]).map((p) => p?.content ?? "").join("\n");
    assert.ok(body.includes(expected), `${name}: the model reads a cancel notice, got: ${body}`);
    assert.ok(!/Exit code: -?\d/.test(body), `${name}: the model must not read a result for a stopped call`);
  }
}

// The task tool's marker is a status flag, not an optional decorator: a required boolean on the
// output schema (`false` on every clean run) that reaches the model as `aborted=…`.
assert.ok(taskOutputSchema.shape.aborted, "task.aborted exists on the schema");
assert.equal(
  taskOutputSchema.shape.aborted.isOptional(),
  false,
  "task.aborted is a required status flag — collapsing it into an optional marker changes the wire contract"
);
assert.equal(taskOutputSchema.shape.cancelled, undefined, "task declares ONE marker, not both");

// ============================================================================
// 6. The derived status flags cannot contradict a cancel
// ============================================================================

{
  // `deriveSubagentRunStats` only evaluates `incomplete` on the `!aborted` path, so an aborted
  // run must never also read as "stalled" — a consumer that reads `incomplete` alone (the
  // progress-summary fallback does) would report the wrong reason.
  const stats = deriveSubagentRunStats({
    messages: [{ id: "a1", role: "assistant", parts: [{ type: "text", content: "Working…" }] }],
    maxIterations: 50,
    // The shape a real cancel produces: the user stops mid-tool-loop, so the engine's last reason is
    // `tool_calls` and the iteration count sits at the ceiling. `finishReason: null` used to make
    // both assertions below pass for the wrong reason — the flag is the only thing that can rule
    // this out, and it does not read the reason.
    finishReason: "tool_calls",
    output: "(no summary)",
    aborted: true,
  });
  assert.equal(stats.incomplete, false, "an aborted run is not `incomplete` — consumers read that as `stalled`");
  assert.notEqual(stats.reachedLimit, true, "and it is not a budget cutoff, even stopped at the ceiling");

  // The stub the pre-fork coordinator settles a never-started run with must obey the same
  // invariant: the consumer reads `incomplete` without consulting `aborted`.
  const preforkSrc = readFileSync(join(SRC, "agent/subagent/task-prefork.ts"), "utf8");
  const stub = /function cancelledStubResult\(\): SubagentResult \{([\s\S]*?)\n\}/.exec(preforkSrc);
  assert.ok(stub, "the pre-fork cancel stub still exists");
  assert.ok(/aborted: true/.test(stub[1]), "the stub is a cancel");
  assert.ok(
    /incomplete: false/.test(stub[1]),
    "and it must NOT also be `incomplete` — that flag is cancel-unaware on the consumer side"
  );
}

// ============================================================================
// 7. The lifecycle verdict: a returned cancel still reports as a cancel
// ============================================================================
//
// Sections 2–3 pin what is written into a part. This pins what the LIFECYCLE says about
// it, which is a different reader of the same semantic:
//
//   - `agent:tool-end` fires whenever a tool RETURNS, and a tool that catches its own
//     abort returns normally — so `info.ok` was `true` for a user-cancelled
//     `run_command`, and the log recorded it as a successful call. The verdict has to be
//     read from the output, because the return carries no information about it.
//   - `agent:tool-error` and `subagent:error` are the two events whose payload `error`
//     field can hold something that is not an error. Without the flag, the log bridge
//     attached a cancelled subagent's partial narration as a stack-bearing exception.
//
// Both payload fields are load-bearing for the log wording, which is asserted here so a
// field dropped from the payload fails a check rather than quietly changing what the
// session log says.

{
  const payloadSrc = readFileSync(join(SRC, "runtime-types/agent-event-payloads.ts"), "utf8");

  for (const [eventType, why] of [
    ["agent:tool-end", "a tool that catches its own abort returns normally, so `ok` cannot express it"],
    ["subagent:error", "the abort path reuses this event, and its `error` field then holds narration"],
  ]) {
    const block = new RegExp(`"${eventType}": \\{([\\s\\S]*?)\\n  \\};`).exec(payloadSrc);
    assert.ok(block, `${eventType} payload block still exists`);
    assert.ok(/cancelled\?: boolean/.test(block[1]), `${eventType} declares the cancel flag — ${why}`);
  }

  // The emit sites must actually set it, and read it from the right place.
  const middlewareSrc = readFileSync(join(SRC, "managers/middleware/extensions-middleware.ts"), "utf8");
  assert.ok(
    /cancelled: isCancelledOutputMarker\(info\.result\)/.test(middlewareSrc),
    "tool-end derives the verdict from the OUTPUT — `info.ok` only says the tool returned"
  );
  assert.ok(
    /cancelled: isAbortError\(info\.error, deps\.getAbortSignal\?\.\(\)\)/.test(middlewareSrc),
    "tool-error keeps classifying the throw against the run's signal"
  );

  const runSubagentSrc2 = readFileSync(join(SRC, "agent/subagent/run-subagent.ts"), "utf8");
  // Structural, not proximity-based: `cancelled: true` must be the FIRST key of the abort
  // branch. The branch is where the flag is decided, and leading with it is what keeps a
  // later field insertion (a new id next to the others) from pushing the flag out of a
  // character window — which is how this assertion was silently satisfied by accident
  // once already. The ordering is the read, so assert the ordering.
  assert.ok(
    /aborted\s*\?\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*cancelled:\s*true/.test(runSubagentSrc2),
    "subagent:error leads its abort branch with the cancel flag (the branch it reuses for a cancel)"
  );

  // The stop notice is applied ONLY on the abort path.
  //
  // Applying it by class is how every SUCCESSFUL subagent's summary came back carrying
  // `[Task cancelled.]` — into the transcript and into the parent model's context, as a
  // cancellation the operator never made. A unit test of `applySubagentStopNotice` cannot
  // catch that: the bug was never in the function, it was in the caller that reached it. So
  // the gate is asserted at the call site, where it lives.
  const noticeCall = /const noticed = ([^;]+);/.exec(runSubagentSrc2)?.[1] ?? "";
  assert.ok(noticeCall.includes("applySubagentStopNotice"), "the stop notice is applied here");
  assert.ok(/^aborted\s*\?/.test(noticeCall.trim()), "…and only when the run was aborted");
  assert.ok(/\boutput\b\s*$/.test(noticeCall.trim()), "a finished run's summary passes through verbatim");

  // The log wording follows the flag on all three, so the flag cannot be set without the
  // log changing with it.
  const rulesSrc = readFileSync(join(SRC, "agent/log/event-log-rules.ts"), "utf8");
  assert.ok(/Tool cancelled:/.test(rulesSrc) && /Tool end:/.test(rulesSrc), "tool-end has both wordings");
  assert.ok(/Subagent cancelled/.test(rulesSrc), "subagent:error has both wordings");
  // ...and the wording follows the recorded reason rather than assuming the user did it.
  assert.ok(
    /SUBAGENT_STOP_WORDING/.test(rulesSrc) && /stopReason/.test(rulesSrc),
    "subagent:error picks its wording from `stopReason` — a discarded run is not a user cancel"
  );

  // And a cancel must not be written through the error path, which synthesizes an Error
  // from the payload — for a cancelled subagent that text is a paragraph of narration.
  const bridgeSrc = readFileSync(join(SRC, "agent/log/event-log-bridge.ts"), "utf8");
  assert.ok(
    /rule\.level === "error"[\s\S]{0,300}p\(event\)\.cancelled === true/.test(bridgeSrc),
    "the bridge short-circuits a cancelled payload BEFORE synthesizing an Error from it"
  );
}

// ============================================================================
// 6. Force-submit keeps the queue; a plain abort drops it
//
// `forceSubmit` interrupts the run to send a message NOW. It used to reach the interrupt through the same
// path as a plain abort — which clears the queues, because an abort genuinely drops pending input (that
// clearing IS the documented behavior of Esc, and the footer hint now names it) — so a queued message
// vanished the instant the user force-submitted something else, while the docs promised only Esc clears.
//
// Asserted at the source, not behaviorally: driving the real thing needs a live run. A fresh agent has no
// chat controller yet (`Chat controller not initialized`), and an agent past a run refuses to queue onto
// its unwinding pump (`currentToken && !isCurrent`) — both correct, and both out of reach of a unit
// validator without a stub provider.
{
  const controllerSrc = readFileSync(
    new URL("../src/managers/controllers/agent-chat-controller.ts", import.meta.url),
    "utf8"
  );
  assert.ok(
    /interruptCurrentRun\("force-submit", \{ keepQueue: true \}\)/.test(controllerSrc),
    "forceSubmit interrupts the run WITHOUT clearing the queue"
  );
  assert.ok(
    /if \(!options\.keepQueue\) this\.clearQueuedMessages\(\);/.test(controllerSrc),
    "…and the plain-abort path still clears it (that is what the footer hint warns about)"
  );
}

// The queue is also not a one-way door: Ctrl+Q takes the last message back, which has to reach the queues
// through a command that RETURNS it (the pop) rather than clearing them.
{
  const controllerSrc = readFileSync(new URL("../src/managers/controllers/agent-chat-controller.ts", import.meta.url), "utf8");
  const dispatchSrc = readFileSync(new URL("../src/agent-session/local-session-dispatch.ts", import.meta.url), "utf8");
  assert.ok(/popQueuedMessage\(\): \{ kind: "steer" \| "followUp"; content: QueuedMessageContent \} \| null/.test(controllerSrc),
    "the controller can take the last queued message back");
  assert.ok(/this\.followUpQueue\.popLast\(\)/.test(controllerSrc), "…from the queue Enter fills first");
  assert.ok(/case "queue\.pop":/.test(dispatchSrc) && /data: chat\.popQueuedMessage\(\)/.test(dispatchSrc),
    "…and the session command returns it to the caller");
}

console.log("cancel-semantics validation passed");
