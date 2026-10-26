/**
 * Validation for LSP tool:after interceptors (args parsing + modifiedResult injection).
 *
 * Run: pnpm --filter @codent/core run validate:lsp-interceptor
 */

import assert from "node:assert/strict";

import {
  applyDiagnosticsToToolAfterPayload,
  createExtensionsMiddleware,
  ExtensionRunner,
  extractToolPath,
  parseToolCallArgs,
} from "../dist/dev.mjs";

assert.deepEqual(parseToolCallArgs('{"path":"src/a.ts","edits":[]}'), { path: "src/a.ts", edits: [] });
assert.equal(extractToolPath('{"path":"packages/core/x.ts"}'), "packages/core/x.ts");
assert.equal(extractToolPath({ path: "b.ts" }), "b.ts");
assert.equal(extractToolPath("not-json"), undefined);

const payload = {
  toolName: "edit_file",
  args: '{"path":"a.ts"}',
  result: { path: "a.ts", replacements: 1 },
  durationMs: 1,
};
applyDiagnosticsToToolAfterPayload(payload, "\n\n⚠ LSP: 1 error(s) in a.ts:\na.ts:1:1 error: oops");
assert.equal(payload.modifiedResult._lspDiagnostics.includes("oops"), true);
assert.equal(payload.result._lspDiagnostics, undefined, "original result unchanged");

const runner = new ExtensionRunner({
  onRegisterTool: () => {},
  cwd: "/workspace",
  getCoreEnv: () => ({ rootPath: "/workspace" }),
});

await runner.loadExtension({
  id: "lsp-like",
  name: "LSP-like",
  version: "1.0.0",
  activate(ctx) {
    ctx.registerInterceptor("tool:after:edit_file", (event) => {
      const path = extractToolPath(event.payload.args);
      assert.equal(path, "packages/core/src/utils/generate-id.ts");
      applyDiagnosticsToToolAfterPayload(event.payload, "\n\n⚠ LSP: injected");
    });
  },
});

const middleware = createExtensionsMiddleware({
  getExtensionRunner: () => runner,
  getSessionId: () => "sess-test",
  emitEvent: () => {},
});

const toolResult = { path: "a.ts", replacements: 1 };
await middleware.onAfterToolCall?.(undefined, {
  ok: true,
  toolName: "edit_file",
  duration: 3,
  result: toolResult,
  toolCallId: "call-1",
  toolCall: {
    toolCallId: "call-1",
    function: { arguments: JSON.stringify({ path: "packages/core/src/utils/generate-id.ts", edits: [] }) },
  },
});

const phaseResults = [
  { toolCallId: "call-1", toolName: "edit_file", result: { path: "a.ts", replacements: 1 }, duration: 3 },
];
await middleware.onToolPhaseComplete?.(undefined, {
  toolCalls: [],
  results: phaseResults,
  needsApproval: [],
  needsClientExecution: [],
});

assert.equal(phaseResults[0].result._lspDiagnostics, "⚠ LSP: injected");

console.log("lsp-interceptor validation passed");
