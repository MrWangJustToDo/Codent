import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";

const { formatToolOutput } = await import(new URL("../dist/index.mjs", import.meta.url).href);

test("formatToolOutput prefers a session-resolved present.text for extension tools", () => {
  const resolve = (name) =>
    name === "ext_echo"
      ? {
          text: (result) => {
            const echoed = result && typeof result === "object" && "echoed" in result ? String(result.echoed) : "";
            return `echo → ${echoed}`;
          },
        }
      : undefined;

  assert.equal(formatToolOutput({ echoed: "hi" }, "ext_echo", resolve), "echo → hi");
  assert.equal(formatToolOutput({ echoed: "hi" }, "unknown_ext", resolve), "");
  assert.equal(formatToolOutput({ echoed: "hi" }, "ext_echo"), "", "no resolver / no descriptor falls back empty");
});

test("formatToolOutput echoes ask_user multi-select as one item per line", () => {
  const question = "Which features should we ship?";

  // Multi-select: explicit list so option text with commas is unambiguous.
  assert.equal(
    formatToolOutput(
      {
        question,
        answer: "alpha, beta",
        hasOptions: true,
        multiSelect: true,
        selected: ["alpha", "beta"],
      },
      "ask_user"
    ),
    "Selected 2 items:\n  - alpha\n  - beta"
  );

  // Multi-select with a free-form draft appended as its own line.
  assert.equal(
    formatToolOutput(
      {
        question,
        answer: "alpha, beta, my idea",
        hasOptions: true,
        multiSelect: true,
        selected: ["alpha", "beta"],
        draft: "my idea",
      },
      "ask_user"
    ),
    "Selected 2 items:\n  - alpha\n  - beta\n  - my idea (custom answer)"
  );
});

test("formatToolOutput echoes single-select ask_user with Selected:", () => {
  // Single-select (hasOptions but no multiSelect): keeps the compact label.
  assert.equal(
    formatToolOutput({ question: "Proceed?", answer: "yes", hasOptions: true, multiSelect: false }, "ask_user"),
    "Selected: yes"
  );

  // Free-form (no options): labeled as an Answer.
  assert.equal(
    formatToolOutput(
      { question: "Tell me more", answer: "here is the detail", hasOptions: false, multiSelect: false },
      "ask_user"
    ),
    "Answer: here is the detail"
  );
});
