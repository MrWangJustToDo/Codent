import { isSyntheticCancelOutput, syntheticCancelMessage } from "../../../runtime-types/abort.js";
import { isBareToolErrorResult } from "../../../runtime-types/tool-error.js";

import { getBuiltinToolPresentation } from "./builtin.js";

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
 * `text` is the tool's **own** renderer (`present.text`, the old `toUI` contract). For an
 * EXTENSION tool that string *is* the row result. A built-in may also declare `text` (session
 * search/read, tree, memory, LSP) — there it is the full-display body only. `row-rules.ts` decides
 * the row from tool identity for built-ins, and from the presence of `present.text` for extension
 * tools (for an extension, that string is its whole result). `summary` comes from
 * `present.summary` only — for a built-in, the resolver merges the built-in table's formatter, so
 * there is no second name-keyed summary switch here. `label` is the tool's declarative input label.
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

  // A CANCEL is a shared shape, not a tool's output: the framework settles every interrupted call
  // with the same marker, so the row must say "cancelled" for EVERY tool. Handled before the error
  // short-circuit (the marker carries `success: false`) and before the name-keyed formatter, which
  // is the only other place that knew how to render it.
  if (isSyntheticCancelOutput(output)) return { text: syntheticCancelMessage(output) };

  // A failed call is rendered by the error path (the part's `errorText`), never by the
  // tool's success-shaped renderers: `{ error: "denied by user" }` used to summarize as
  // "updated" / "applied" / "saved", and that wrong text is persisted with the session.
  if (isErrorOutput(output)) return undefined;

  const present = safe(() => resolvePresentation(name));
  // Only the SYNTHETIC framework payload is replaced wholesale: it carries no output at all (the
  // tool never returned). A tool that caught its own abort DOES have output, and its own `text`
  // renderer is what renders it — see {@link isSyntheticCancelOutput}.
  const text = safe(() => present?.text?.(output));
  const summary = safe(() => present?.summary?.(output)) ?? undefined;
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
 * `{ error }` alone is the framework's error shape and has nothing to render. An `error` field
 * ALONGSIDE a payload is not: MCP/extension tools legitimately return `{ error, content }`, and
 * blanking them here made the local body and the cross-process `part.display` disagree.
 *
 * `ok: false` / `success: false` still count: every built-in uses those flags to mean "the
 * success-shaped renderers have nothing truthful to say" (a failed edit still carries `path`).
 * A tool that carries business data in those fields should declare `isError` in its schema rather
 * than widening this check.
 */
function isErrorOutput(output: unknown): boolean {
  if (isBareToolErrorResult(output)) return true;
  if (typeof output !== "object" || output === null) return false;
  const record = output as { isError?: unknown; ok?: unknown; success?: unknown };
  return record.isError === true || record.ok === false || record.success === false;
}
