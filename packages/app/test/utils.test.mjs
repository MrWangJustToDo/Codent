import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

const {
  formatDuration,
  formatToolArgs,
  formatToolInput,
  formatToolOutput,
  getDurationMs,
  getToolCallColor,
  clampHeaderInput,
  wrapTextToLines,
  CLAMP_MARKER,
} = await import(new URL("../dist/index.mjs", import.meta.url).href);

test("formatDuration formats millisecond, second, and minute durations", () => {
  assert.equal(formatDuration(250), "250ms");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(65_000), "1m 5s");
});

test("formatToolInput renders tool-specific summaries", () => {
  assert.equal(formatToolInput({ path: "src/index.ts", offset: 3, limit: 4 }, "read_file"), "src/index.ts lines 3-6");
  assert.equal(formatToolInput({ pattern: "TODO", path: "src" }, "grep"), '"TODO" in src');
});

test("formatToolOutput renders common tool results", () => {
  assert.equal(formatToolOutput({ entries: [], count: 0 }, "list_file"), "Empty directory");
  assert.equal(formatToolOutput({ files: ["a.ts", "b.ts"], count: 2 }, "glob"), "2 files found:\n  a.ts\n  b.ts");
  assert.equal(formatToolOutput({ matches: [], count: 0, contentTruncated: false }, "grep"), "No matches found");
});

test("formatToolArgs renders compact multi-line arguments", () => {
  assert.equal(formatToolArgs(null), "No arguments");
  assert.equal(formatToolArgs({ path: "src/index.ts", limit: 10 }), "  path: src/index.ts\n  limit: 10");
});

test("tool display helpers handle duration and state colors", () => {
  assert.equal(getDurationMs({ durationMs: 1200 }), 1200);
  assert.equal(getDurationMs({ durationMs: "1200" }), null);
  assert.equal(getToolCallColor("output-available"), "#3FB950");
  assert.equal(getToolCallColor("unknown"), "#8B949E");
});

// ----------------------------------------------------------------------------
// Settled-row argument clamping
// ----------------------------------------------------------------------------
//
// The header is one `wrap="wrap"` Text, so a multi-line or long command used to grow a
// FINISHED row to whatever height the wrapping produced. The assertions below pin the row
// budget, and `wrapTextToLines` is used to measure it — the same wrapper Ink lays out with,
// so a fit cannot be asserted against an arithmetic guess that disagrees with the renderer.

/** Rows the composed header would occupy. */
const headerRows = (input, compose, width) => wrapTextToLines(compose(input), width).length;

const runCmd = (input) => `run_command ${input} (1.2s)`;

test("a settled row's arguments never exceed the row budget", () => {
  const inputs = [
    // A heredoc: three physical lines the model wrote verbatim.
    'cat <<EOF\nline one\nline two\nline three\nEOF',
    // One long line that only wraps.
    'find . -name "*.ts" | xargs grep -l foo | head -20 | sort | uniq -c | sort -rn',
    // Forty lines — the shape that made the row own the transcript.
    Array.from({ length: 40 }, (_, i) => `echo line${i}`).join("\n"),
    // Wide characters count 2 columns each, so a character budget would under-measure.
    `echo ${"中文".repeat(60)}`,
    // No spaces at all: the wrapper must hard-wrap every row.
    "x".repeat(600),
  ];

  for (const width of [40, 80, 114, 200]) {
    for (const input of inputs) {
      const clamped = clampHeaderInput(input, runCmd, width, 2);
      assert.ok(
        headerRows(clamped, runCmd, width) <= 2,
        `width=${width} input=${JSON.stringify(input.slice(0, 40))}rows=${headerRows(clamped, runCmd, width)}`
      );
    }
  }
});

test("clamping marks the cut with a bare ellipsis and keeps a readable prefix", () => {
  const input = Array.from({ length: 40 }, (_, i) => `echo line${i}`).join("\n");
  const clamped = clampHeaderInput(input, runCmd, 114, 2);

  assert.notEqual(clamped, input, "an over-budget input must actually be cut");
  assert.ok(clamped.endsWith(CLAMP_MARKER), `expected a trailing ${CLAMP_MARKER}, got ${JSON.stringify(clamped)}`);
  // The point of keeping a prefix at all: the command stays identifiable.
  assert.ok(clamped.startsWith("echo line0"), JSON.stringify(clamped));
  // No line-count hint — the row says only that something was omitted.
  assert.ok(!/\d+ lines?\)/.test(clamped), `no line count in ${JSON.stringify(clamped)}`);
});

test("a header that already fits is returned byte-identical", () => {
  assert.equal(clampHeaderInput("ls -la", runCmd, 114, 2), "ls -la");
  assert.equal(clampHeaderInput("", runCmd, 114, 2), "");
  assert.equal(clampHeaderInput(null, runCmd, 114, 2), null);
  // A single row that fits settles the whole header at one row — no marker, no padding.
  assert.equal(clampHeaderInput("pnpm build", runCmd, 40, 2), "pnpm build");
});

test("the parenthetical and tool name are charged against the argument width", () => {
  // `read_file path/x.ts (1.2s)` is one row at 40 columns; the args must not be allowed to
  // consume the width that the prefix and paren occupy on the same row.
  const name = "read_file";
  const long = "a".repeat(200);
  const compose = (input) => `${name} ${input} (1.2s)`;
  const clamped = clampHeaderInput(long, compose, 40, 2);
  assert.ok(headerRows(clamped, compose, 40) <= 2, JSON.stringify(clamped));

  // A long parenthetical leaves almost nothing for the arguments: the clamp must not
  // overrun the budget by cutting at the wrong boundary.
  const heavyParen = (input) => `${name} ${input} (cancelled, 3/50 turns, 1.2k tokens)`;
  const clampedHeavy = clampHeaderInput(long, heavyParen, 60, 2);
  assert.ok(headerRows(clampedHeavy, heavyParen, 60) <= 2, JSON.stringify(clampedHeavy));
});

test("clamping never makes the row taller than its own fixed segments", () => {
  // Degenerate narrow widths: the tool name plus a long parenthetical already wrap past the
  // budget, so nothing cut from the arguments can recover it. The one thing that must hold
  // is that the clamp never ADDS a row — otherwise the fix would worsen the symptom it
  // exists to remove.
  const heavyParen = (input) => `run_command ${input} (cancelled, 3/50 turns, 1.2k tokens)`;
  for (const width of [10, 16, 20]) {
    const baseline = wrapTextToLines(heavyParen(""), width).length;
    for (const input of ["a\nb\nc", "x".repeat(300), "中文".repeat(40)]) {
      const rows = wrapTextToLines(heavyParen(clampHeaderInput(input, heavyParen, width, 2)), width).length;
      assert.ok(rows <= baseline, `width=${width} rows=${rows} baseline=${baseline} input=${JSON.stringify(input.slice(0, 20))}`);
    }
  }
});
