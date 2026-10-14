#!/usr/bin/env node
/**
 * Mock LSP server for validating @codent LSP integration.
 *
 * Speaks LSP over stdio (Content-Length framed JSON-RPC). Tracks opened
 * documents and emits `textDocument/publishDiagnostics` for any document whose
 * content contains the marker "// ERR" — reporting a synthetic error — or
 * "// WARN" — reporting a synthetic warning. This lets us verify:
 *
 *   - initialize handshake (transport layer)
 *   - didOpen / didChange file-sync
 *   - server-pushed diagnostics flowing into LspManager's cache
 *   - hover / definition / symbols / completion / code-action requests
 *   - shutdown / exit
 *
 * Zero third-party deps (hand-rolled framing), so it runs anywhere.
 */

import { appendFileSync } from "node:fs";

// Documents currently open: uri -> { text, languageId, version }
const docs = new Map();

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function makeDiagnostics(uri) {
  const doc = docs.get(uri);
  if (!doc) return [];
  const out = [];
  const lines = doc.text.split("\n");
  lines.forEach((line, idx) => {
    const errCol = line.indexOf("// ERR");
    if (errCol >= 0) {
      out.push({
        range: { start: { line: idx, character: errCol }, end: { line: idx, character: errCol + 6 } },
        severity: 1,
        code: "mock-err",
        source: "mock-lsp",
        message: `Mock error: syntax problem (ERR) in ${uri}`,
      });
    }
    const warnCol = line.indexOf("// WARN");
    if (warnCol >= 0) {
      out.push({
        range: { start: { line: idx, character: warnCol }, end: { line: idx, character: warnCol + 7 } },
        severity: 2,
        code: "mock-warn",
        source: "mock-lsp",
        message: `Mock warning: unused marker (WARN) in ${uri}`,
      });
    }
  });
  return out;
}

function publishDiagnostics(uri) {
  notify("textDocument/publishDiagnostics", { uri, diagnostics: makeDiagnostics(uri) });
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;

  // Notifications
  if (id === undefined || id === null) {
    switch (method) {
      case "initialized":
        break;
      case "textDocument/didOpen": {
        const td = params?.textDocument;
        if (td) {
          docs.set(td.uri, { text: td.text, languageId: td.languageId, version: td.version });
          publishDiagnostics(td.uri);
        }
        break;
      }
      case "textDocument/didChange": {
        const td = params?.textDocument;
        const change = params?.contentChanges?.[0];
        if (td && change) {
          docs.set(td.uri, {
            text: change.text,
            languageId: docs.get(td.uri)?.languageId ?? "plaintext",
            version: td.version,
          });
          publishDiagnostics(td.uri);
        }
        break;
      }
      case "textDocument/didClose": {
        docs.delete(params?.textDocument?.uri);
        break;
      }
      case "exit":
        process.exit(0);
        break;
      case "$/cancelRequest": {
        // Recorded so a validator can assert the *host* cancelled a request it stopped waiting for
        // (otherwise "we cancelled the token" is an internal claim). Path comes from the environment;
        // with none set this is a no-op.
        const log = process.env.MOCK_LSP_CANCEL_LOG;
        if (log) {
          try {
            appendFileSync(log, `${JSON.stringify(msg)}\n`);
          } catch {
            // Best effort: a validator's log path may be gone.
          }
        }
        break;
      }
      default:
        break;
    }
    return;
  }

  // Requests
  switch (method) {
    case "initialize": {
      reply(id, {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          renameProvider: true,
          completionProvider: { triggerCharacters: ["."] },
          codeActionProvider: true,
        },
        serverInfo: { name: "mock-lsp", version: "0.0.1" },
      });
      break;
    }
    case "shutdown":
      reply(id, null);
      break;
    case "textDocument/hover": {
      const uri = params?.textDocument?.uri;
      const doc = docs.get(uri);
      if (!doc) return reply(id, null);
      const line = params?.position?.line ?? 0;
      const char = params?.position?.character ?? 0;
      const textLine = doc.text.split("\n")[line] ?? "";
      const word = textLine.slice(char, char + 12) || "?";
      reply(id, {
        contents: { kind: "markdown", value: `Mock hover for \`${word}\` (${uri})` },
      });
      break;
    }
    case "textDocument/definition": {
      const uri = params?.textDocument?.uri;
      reply(id, {
        uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      });
      break;
    }
    case "textDocument/documentSymbol": {
      const uri = params?.textDocument?.uri;
      const doc = docs.get(uri);
      if (!doc) return reply(id, []);
      const symbols = [];
      doc.text.split("\n").forEach((line, idx) => {
        const m = line.match(/function\s+([A-Za-z_$][\w$]*)/);
        if (m) {
          symbols.push({
            name: m[1],
            kind: 12,
            range: {
              start: { line: idx, character: line.indexOf(m[1]) },
              end: { line: idx, character: line.indexOf(m[1]) + m[1].length },
            },
            selectionRange: {
              start: { line: idx, character: line.indexOf(m[1]) },
              end: { line: idx, character: line.indexOf(m[1]) + m[1].length },
            },
          });
        }
      });
      reply(id, symbols);
      break;
    }
    case "textDocument/completion": {
      const uri = params?.textDocument?.uri;
      const doc = docs.get(uri);
      const line = params?.position?.line ?? 0;
      const textLine = doc ? (doc.text.split("\n")[line] ?? "") : "";
      const prefix = textLine.trimStart();
      const items = [];
      if (prefix.startsWith("mock.")) {
        items.push(
          { label: "mockMethod", kind: 2, detail: "Mock completion" },
          { label: "mockField", kind: 5, detail: "Mock field" }
        );
      }
      if (items.length === 0) {
        items.push(
          { label: "suggestMe", kind: 2, detail: "Mock default completion" },
          { label: "suggestYou", kind: 2, detail: "Mock default completion" }
        );
      }
      reply(id, items);
      break;
    }
    case "textDocument/references": {
      const uri = params?.textDocument?.uri;
      const doc = docs.get(uri);
      if (!doc) return reply(id, []);
      const line = params?.position?.line ?? 0;
      const textLine = doc.text.split("\n")[line] ?? "";
      const m = textLine.match(/\b([A-Za-z_$][\w$]*)\b/);
      if (!m) return reply(id, []);
      reply(id, [
        {
          uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: m[1].length } },
        },
      ]);
      break;
    }
    case "textDocument/codeAction": {
      reply(id, [
        {
          title: "Mock quick fix: ignore error",
          kind: "quickfix",
          diagnostics: [],
          edit: { changes: {} },
        },
      ]);
      break;
    }
    case "textDocument/prepareRename":
      reply(id, null);
      break;
    case "textDocument/rename": {
      reply(id, { changes: {} });
      break;
    }
    case "test/hang":
      // Deliberately unanswered: a server that received the request and will never reply. Only the
      // host's request deadline can settle a call like this.
      break;
    default:
      fail(id, -32601, `Mock LSP does not implement: ${method}`);
      break;
  }
}

// ---- stdin reader (Content-Length framing) ----
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.subarray(0, headerEnd).toString("utf-8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Drop malformed header
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;
    const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
    buffer = buffer.subarray(bodyStart + contentLength);
    try {
      handleMessage(JSON.parse(body));
    } catch {
      // Malformed JSON — ignore for mock
    }
  }
});

process.stdin.resume();
process.stderr.resume();

// Prevent accidental early exit.
setInterval(() => {}, 1000);
