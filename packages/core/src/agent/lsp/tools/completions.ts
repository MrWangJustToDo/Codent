/**
 * lsp_completions — get completion suggestions at a position.
 */

import { errorMessage } from "../../../utils/errors.js";
import { truncateText } from "../../../utils/text-truncation.js";
import { resolveSymbolPosition } from "../shared/resolve-position.js";
import { insertDot, shouldSyntheticTrigger, syntheticDotLocks } from "../shared/synthetic-dot.js";
import { SYNTHETIC_DOT_SETTLE_DELAY_MS } from "../shared/timing.js";

import type { ToolExecutionOptions } from "../../extension/types.js";
import type { FileSync } from "../file-sync.js";
import type { LspManager } from "../lsp-manager.js";
import type { CompletionItem, CompletionList, CompletionItemKind, MarkupContent } from "vscode-languageserver-protocol";

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
        path: { type: "string", description: "File path" },
        line: { type: "number", description: "Line number (1-indexed). Required unless query is provided." },
        character: { type: "number", description: "Column number (1-indexed). Required unless query is provided." },
        query: { type: "string", description: "Symbol name to find in the file (alternative to line/character)." },
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
      const params = input as {
        path?: string;
        line?: number;
        character?: number;
        query?: string;
        limit?: number;
        trigger?: "auto" | "none";
      };
      const filePath = (params.path ?? "").replace(/^@/, "");
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
          return { text: `Could not find symbol "${params.query}" in ${filePath}`, count: 0, total: 0 };
        }
      }

      if (line === undefined || character === undefined) {
        return { text: "Either line/character or query is required.", count: 0, total: 0 };
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

      if (trigger === "auto" && !syntheticDotLocks.has(uri)) {
        syntheticDotLocks.add(uri);
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
        } finally {
          syntheticDotLocks.delete(uri);
        }
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
              Promise.race([
                client.connection.sendRequest<CompletionItem>("completionItem/resolve", item, {
                  signal: options?.abortSignal,
                }),
                new Promise<CompletionItem>((_, reject) =>
                  setTimeout(() => reject(new Error("resolve timeout")), 2000)
                ),
              ])
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
        return { text: `LSP completion request failed: ${msg}`, count: 0, total: 0 };
      }
    },
  };
}
