import { isSyntheticCancelOutput } from "../../../runtime-types/abort.js";
import { TOOL_CANCELLED_MESSAGE } from "../../stream/incomplete-tool-calls.js";

import { getBuiltinToolPresentation } from "./builtin.js";
import { inlineSummaryForOutput } from "./format/inline-summary.js";

import type { ToolDisplayPayload } from "./types.js";

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Renderers run inside the agent loop now, so a renderer that throws (or returns
 * nonsense) must never take the run down: a tool's display payload is cosmetic, the
 * tool result itself is not.
 */
function safe<T>(render: () => T): T | undefined {
  try {
    return render();
  } catch {
    return undefined;
  }
}

/**
 * Render a tool call's display payload — **once, at completion**, in core.
 *
 * Hosts read the result off the tool-call part (`part.display`), so nothing about how
 * a tool looks has to be reachable in the host process: remote CoreEnv / Agent Session
 * and extension hosts get the same strings as the local CLI.
 *
 * `text` is the tool's **own** renderer (`present.text`, the old `toUI` contract): that one
 * string *is* the row, and hosts read its presence as "this tool owns a result block".
 * Built-ins deliberately get no `text` here — their formatting lives in core's
 * self-contained output switch (a host can run it without the registry), and filling
 * `text` for them made every tool look like it owns a block (`read_file` / `grep` grew
 * output blocks). `summary` prefers `present.summary`, then the built-in inline summary;
 * `label` is the tool's declarative input label.
 *
 * Deterministic by construction: every renderer is a pure function of the stored
 * output / parsed input (see {@link ToolPresentation}), so the payload can be persisted
 * with the session and replayed without changing the prompt prefix.
 */
export function computeToolDisplay(
  name: string,
  output: unknown,
  input?: unknown,
  resolvePresentation: (name: string) => ReturnType<typeof getBuiltinToolPresentation> = getBuiltinToolPresentation
): ToolDisplayPayload | undefined {
  if (!name) return undefined;

  // A failed call is rendered by the error path (the part's `errorText`), never by the
  // tool's success-shaped renderers: `{ error: "denied by user" }` used to summarize as
  // "updated" / "applied" / "saved", and that wrong text is persisted with the session.
  if (isErrorOutput(output)) return undefined;

  const present = resolvePresentation(name);
  // Only the SYNTHETIC framework payload is replaced wholesale: it carries no output at all (the
  // tool never returned). A tool that caught its own abort DOES have output, and its own `text`
  // renderer is what renders it — see {@link isSyntheticCancelOutput}.
  const text = isSyntheticCancelOutput(output) ? TOOL_CANCELLED_MESSAGE : safe(() => present?.text?.(output));
  const summary =
    safe(() => present?.summary?.(output)) ?? safe(() => inlineSummaryForOutput(output, name)) ?? undefined;
  const label = safe(() => present?.label?.(input)) ?? undefined;

  const display: ToolDisplayPayload = {};
  const body = nonEmpty(text);
  if (body) display.text = body;
  const head = nonEmpty(summary);
  if (head) display.summary = head;
  if (label) display.label = label;

  return Object.keys(display).length > 0 ? display : undefined;
}

/**
 * Whether the stored output is a failure report (as opposed to a normal result).
 *
 * `ok: false` / `success: false` count as failure: every built-in uses those fields with
 * that meaning in its output schema. A tool that carries business data in them would lose its
 * summary — the durable fix for such a tool is to declare `isError` in its output schema
 * rather than to widen this check.
 */
function isErrorOutput(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const record = output as { error?: unknown; isError?: unknown; ok?: unknown; success?: unknown };
  return typeof record.error === "string" || record.isError === true || record.ok === false || record.success === false;
}
