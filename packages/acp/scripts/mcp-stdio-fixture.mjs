#!/usr/bin/env node
/**
 * A minimal MCP stdio server, as a test fixture.
 *
 * Exists so a validation can prove a stdio MCP server really CONNECTS through a given `CoreEnv`
 * (handshake + `tools/list`), instead of only proving that a spawn failure is not the
 * "transport unavailable" guard. Hermetic: newline-delimited JSON-RPC on stdin/stdout, one tool,
 * no dependencies, no child processes of its own.
 *
 * The protocol version is echoed from the client's `initialize` request rather than pinned here —
 * a fixture that hard-codes a version fails the handshake the first time the client revs, which
 * would read as a broken transport.
 *
 * Usage (the command a validator puts in `mcpServers`):
 *   node scripts/mcp-stdio-fixture.mjs
 */

const TOOL_NAME = "ping";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function handle(message) {
  // Notifications carry no id and must never be answered — a reply to one is a protocol error. A
  // `null` id is a request (JSON-RPC 1.0 style) rather than a notification, so it is answered.
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "codent-mcp-fixture", version: "0.0.0" },
      });
      return;
    case "tools/list":
      result(message.id, {
        tools: [
          {
            name: TOOL_NAME,
            description: "Reply with pong. A fixture tool, not a real capability.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });
      return;
    case "tools/call":
      // An unknown tool is an error, not a pong: a fixture that answers everything would make a
      // "calling a missing tool fails" assertion pass for the wrong reason.
      if (message.params?.name !== TOOL_NAME) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32602, message: `no such tool: ${message.params?.name}` },
        });
        return;
      }
      result(message.id, { content: [{ type: "text", text: "pong" }] });
      return;
    case "ping":
      result(message.id, {});
      return;
    default:
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no such method: ${message.method}` } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      // Diagnostics go to stderr, which is the only channel available: stdout is the protocol and a
      // fixture that crashes here would report a transport failure instead of a protocol one.
      process.stderr.write(`[mcp-stdio-fixture] unparseable line: ${error?.message ?? error}\n`);
    }
  }
});
// The client closes stdin when it is done; exiting then is what a well-behaved server does.
process.stdin.on("end", () => process.exit(0));
