/**
 * Fail if forbidden symbols appear on the published `@codent/core` entry.
 *
 * Run: pnpm --filter @codent/core run validate:core-public-exports
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = path.join(root, "dist/index.mjs");

const DENY = [
  "AgentLog",
  "TodoManager",
  "SessionStore",
  "AgentChatController",
  "autoCompact",
  "applyCompactionResult",
  "buildCanonicalModelMessages",
  "estimateTokens",
  "runSideTextQuery",
  "resolveTextAdapterForManaged",
  "ExtensionRunner",
  "ExtensionLoader",
  "getDefaultExtensionDirs",
  "DEFAULT_EXTENSION_DIR",
  "TaskRunState",
  "AgentStreamHub",
  "LspManager",
];

const mod = await import(pathToFileURL(indexPath).href);
const leaked = DENY.filter((name) => name in mod);

assert.equal(leaked.length, 0, `Forbidden public exports found: ${leaked.join(", ")}`);

// Presentation is now descriptor-based: `getToUI` was removed with the
// `toUI`/`display` extension fields (unify-tool-presentation-in-core, "no aliases
// kept"). Assert the replacements are published instead of the deleted lookup.
//
// The compaction-summary markers and predicates are here for the opposite reason to `DENY`: they
// LOOK internal (they name the `[CONVERSATION SUMMARY]` wire format), but they are pure
// constants/functions and they answer one question — "is this row a compaction summary?" — that
// the app's transcript, ACP's `session/load` replay and the compaction chain all must agree on.
// The two alternatives are both worse: a per-host copy is the drift this replaced (`@codent/app`
// kept a full copy under a "must stay in sync" comment), and every host importing them by deep
// path is banned by `@codent/app`'s `validate:core-imports`. So they belong on the public entry,
// exactly like `isContextUIMessage` above them.
for (const name of [
  "agentManager",
  "createLocalAgentSessionHost",
  "createRemoteProvider",
  "REMOTE_PROVIDER_API_KEY",
  "resolveModelConfigFromProvider",
  "buildDefaultSystemPrompt",
  "isActiveStatus",
  "getBuiltinToolPresentation",
  "presentationFromInfo",
  "keepsCompactRow",
  "computeToolDisplay",
  "previewEdit",
  "generateId",
  "CONVERSATION_SUMMARY_START",
  "CONVERSATION_SUMMARY_END",
  "extractCompactionSummaryBody",
  "formatCompactionSummaryContent",
]) {
  assert.ok(name in mod, `Expected public export missing: ${name}`);
}

console.log("core-public-exports validation passed");
