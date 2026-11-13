/**
 * lsp_completions — get completion suggestions at a position.
 */

import { errorMessage } from "../../../utils/errors.js";
import { truncateText } from "../../../utils/text-truncation.js";
import { resolveSymbolPosition } from "../shared/resolve-position.js";
import { insertDot, shouldSyntheticTrigger, syntheticDotLocks } from "../shared/synthetic-dot.js";
import { SYNTHETIC_DOT_SETTLE_DELAY_MS } from "../shared/timing.js";

import { POSITION_PROPERTIES, normalizeLspPath, positionParams, type PositionInput } from "./tool-shared.js";

import type { ToolExecutionOptions } from "../../extension/types.js";
import type { FileSync } from "../file-sync.js";
import type { LspManager } from "../lsp-manager.js";
import type { CompletionItem, CompletionList, CompletionItemKind, MarkupContent } from "vscode-languageserver-protocol";

/** How long one `completionItem/resolve` may take before the item is shown unresolved. */
const RESOLVE_TIMEOUT_MS = 2000;

/**
 * Bound one `completionItem/resolve` by {@link RESOLVE_TIMEOUT_MS}, releasing the timer afterwards.
 *
 * A bare `Promise.race` against a rejecting timeout leaves the timer armed when the request wins,
 * and a completion request resolves up to `limit` items at once on every keystroke.
 */
function raceCompletionResolve(request: Promise<CompletionItem>): Promise<CompletionItem> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CompletionItem>((_, reject) => {
    timer = setTimeout(() => reject(new Error("resolve timeout")), RESOLVE_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  return Promise.race([request, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

const KIND_LABELS: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "constructor",
  5: "field",
  6: "variable",
  7: "class",
  8: "interface",
  9: "module",
  10: "property",
  11: "unit",
  12: "value",
  13: "enum",
  14: "keyword",
  15: "snippet",
  16: "color",
  17: "file",
  18: "reference",
  19: "folder",
  20: "enum member",
  21: "constant",
  22: "struct",
  23: "event",
  24: "operator",
  25: "type param",
};

function kindLabel(kind?: CompletionItemKind): string {
  if (!kind) return "unknown";
  return KIND_LABELS[kind] ?? "unknown";
}

function docSummary(doc?: string | MarkupContent): string | undefined {
  if (!doc) return undefined;
  const text = typeof doc === "string" ? doc : doc.value;
  if (!text) return undefined;
  const lines = text
    .replace(/```[\s\S]*?```/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const summary = lines.slice(0, 2).join(" ");
  return truncateText(summary, 120);
}

function formatItem(item: CompletionItem): string {
  const kind = kindLabel(item.kind);
  const label = item.label;
  const detail = item.detail ? ` ${item.detail}` : "";
  const labelDetail = item.labelDetails?.detail ? item.labelDetails.detail : "";
  const labelDesc = item.labelDetails?.description ? ` — ${item.labelDetails.description}` : "";

  let line = `${kind.padEnd(12)} ${label}${labelDetail}${detail}${labelDesc}`;
  const doc = docSummary(item.documentation);
  if (doc) line += `\n${"".padEnd(13)}${doc}`;
  return line;
}

type CompletionResponse = CompletionList | CompletionItem[] | null;

export interface CompletionsToolDeps {
  manager: LspManager;
  versionTracker?: FileSync;
  readFile?: (absPath: string) => Promise<string>;
}

export function createCompletionsTool(deps: CompletionsToolDeps) {
  return {
    name: "lsp_completions",
    present: { category: "searches" as const },
    description:
      'Get completion suggestions at a position (1-indexed line/character, or query). Returns methods, properties, and symbols available at that point. When trigger is "auto" (default), a dot is temporarily inserted at the end of identifiers to enable member completion.',
    inputSchema: {
      type: "object",
      properties: {
        ...POSITION_PROPERTIES,
        limit: { type: "number", description: "Max results to return (default: 20)." },
        trigger: {
          type: "string",
          enum: ["auto", "none"],
          description:
            'Synthetic trigger mode (default: "auto"). When "auto", temporarily inserts a dot at the end of identifiers for member completion.',
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (input: unknown, options: ToolExecutionOptions) => {
      const params = positionParams<PositionInput & { limit?: number; trigger?: "auto" | "none" }>(input);
      const filePath = normalizeLspPath(params.path) ?? "";
      const limit = params.limit ?? 20;
      const trigger = params.trigger ?? "auto";
      let line = params.line;
      let character = params.character;
      let resolvedFrom: string | undefined;

      if ((line === undefined || character === undefined) && params.query) {
        const resolved = await resolveSymbolPosition(filePath, params.query, deps.manager);
        if (resolved) {
          line = resolved.line;
          character = resolved.character;
          resolvedFrom = `Resolved "${params.query}" → ${resolved.symbolName} at ${line}:${character} [${resolved.source}]`;
        } else {
          return { text: `Could not find symbol "${params.query}" in ${filePath}`, ok: false, count: 0, total: 0 };
        }
      }

      if (line === undefined || character === undefined) {
        return { text: "Either line/character or query is required.", ok: false, count: 0, total: 0 };
      }

      const client = await deps.manager.getClientForFile(filePath).catch(() => null);
      if (!client) {
        return { text: deps.manager.getUnavailableReason(filePath), count: 0, total: 0 };
      }

      const caps = client.connection.serverCapabilities as {
        completionProvider?: { resolveProvider?: boolean };
      } | null;
      if (caps && !caps.completionProvider) {
        return { text: "LSP server for this file does not support completions.", count: 0, total: 0 };
      }

      const uri = deps.manager.getFileUri(filePath);
      const position = { line: line - 1, character: character - 1 };

      let syntheticDot = false;
      let originalContent: string | null = null;
      let revertVersion = 99991;
      let completionPosition = position;
      let lockHeld = false;

      if (trigger === "auto" && !syntheticDotLocks.has(uri)) {
        syntheticDotLocks.add(uri);
        lockHeld = true;
        try {
          const absPath = deps.manager.resolvePath(filePath);
          const readFile = deps.readFile ?? ((p) => deps.manager.readFileIfPossible(p).then((c) => c ?? ""));
          const fileContent = await readFile(absPath);
          const triggerPos = fileContent
            ? shouldSyntheticTrigger(fileContent, position.line, position.character)
            : null;

          if (triggerPos && fileContent) {
            originalContent = fileContent;
            const modifiedContent = insertDot(fileContent, triggerPos.insertLine, triggerPos.insertChar);

            const currentVersion = deps.versionTracker?.getTrackedVersion(uri);
            const insertVersion = currentVersion != null ? currentVersion + 1 : 99990;
            revertVersion = currentVersion != null ? currentVersion + 2 : 99991;

            client.connection.didChange(uri, insertVersion, modifiedContent);
            if (deps.versionTracker && currentVersion != null) {
              deps.versionTracker.setTrackedVersion(uri, insertVersion);
            }

            completionPosition = {
              line: triggerPos.insertLine,
              character: triggerPos.insertChar + 1,
            };
            syntheticDot = true;

            await new Promise((r) => setTimeout(r, SYNTHETIC_DOT_SETTLE_DELAY_MS));
          }
        } catch {
          // fall through to normal completion
        }
        // The lock is NOT released here: it must cover the whole window in which the server's copy
        // of the document is the synthetic-dot version. Releasing it at the end of this block left
        // the revert (in the `sendRequest` finally below) outside the lock, so a write landing in
        // between was pushed by file-sync as `version + 1` and then overwritten by the revert —
        // the server then held the wrong text and published diagnostics for it.
      }

      try {
        let response: CompletionResponse;
        try {
          response = await client.connection.sendRequest<CompletionResponse>(
            "textDocument/completion",
            { textDocument: { uri }, position: completionPosition },
            { signal: options?.abortSignal }
          );
        } finally {
          // Revert first, release second — the reverse order reopens the same race.
          if (syntheticDot && originalContent !== null) {
            try {
              client.connection.didChange(uri, revertVersion, originalContent);
              if (deps.versionTracker) {
                deps.versionTracker.setTrackedVersion(uri, revertVersion);
              }
            } catch {
              // best effort revert
            }
          }
          if (lockHeld) syntheticDotLocks.delete(uri);
        }

        if (!response) {
          return { text: "No completions available at this position.", count: 0, total: 0 };
        }

        const allItems: CompletionItem[] = Array.isArray(response) ? response : response.items;
        if (allItems.length === 0) {
          return { text: "No completions available at this position.", count: 0, total: 0 };
        }

        const total = allItems.length;
        const sorted = [...allItems].sort((a, b) => {
          const sa = a.sortText ?? a.label;
          const sb = b.sortText ?? b.label;
          return sa.localeCompare(sb);
        });
        const topItems = sorted.slice(0, limit);

        const resolveSupported = caps?.completionProvider?.resolveProvider;
        let resolvedItems: CompletionItem[];

        if (resolveSupported) {
          const results = await Promise.allSettled(
            topItems.map((item) =>
              // The timeout timer is cleared when the request wins: a race that only rejects on
              // timeout left one live 2s handle per resolved item, on a path every completion
              // keystroke takes. `unref` keeps a pending resolve from holding the process open.
              raceCompletionResolve(
                client.connection.sendRequest<CompletionItem>("completionItem/resolve", item, {
                  signal: options?.abortSignal,
                })
              )
            )
          );
          resolvedItems = results.map((result, i) => (result.status === "fulfilled" ? result.value : topItems[i]));
        } else {
          resolvedItems = topItems;
        }

        let header = `${resolvedItems.length} of ${total} completions at ${filePath}:${line}:${character}\n`;
        if (resolvedFrom) header = `${resolvedFrom}\n\n${header}`;
        const lines = resolvedItems.map(formatItem);
        const text = header + lines.join("\n");

        return { text, count: resolvedItems.length, total };
      } catch (err) {
        const msg = errorMessage(err);
        return { text: `LSP completion request failed: ${msg}`, ok: false, count: 0, total: 0 };
      }
    },
  };
}
