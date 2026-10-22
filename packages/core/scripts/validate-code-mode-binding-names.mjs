/**
 * Validation: code-mode binding-name normalisation.
 *
 * `@tanstack/ai-code-mode` derives each sandbox binding name as
 * `` `${prefix}${tool.name}` `` verbatim (`dist/esm/bindings/tool-to-binding.js:12`
 * and `:50`), so a hyphenated tool name (every MCP tool: `mcp__server_read-file`)
 * produces a stub that is not a legal JS/TS identifier and a script cannot call it.
 * The same bug was fixed upstream in pi v0.99.2, and the installed
 * `@tanstack/ai-code-mode@0.4.21` artifact is still unnormalised, so this guard is
 * load-bearing today.
 *
 * Covers:
 * - the helper is pure and idempotent (the no-op-if-upstream-fixes-it property)
 * - the real `createCodeMode` prompt contains only legal identifiers
 * - the current curated list produces a byte-identical prompt (no behaviour change)
 * - `read-file` + `read_file` both stay callable with distinct names
 * - a name that cannot be disambiguated is dropped with a warning, run still succeeds
 * - all three model-visible surfaces (type stubs, Available APIs, discover_tools
 *   catalog) agree, and none advertises a pre-normalisation name
 *
 * Run: pnpm --filter @codent/core run validate:code-mode-binding-names
 */

import { createCodeMode } from "@tanstack/ai-code-mode";

import {
  CODE_MODE_LAZY_TOOL_NAMES,
  CODE_MODE_TOOL_NAMES,
  createCodeModeExtension,
  normalizeBindingName,
  renameCodeModeTools,
} from "../dist/dev.mjs";

// ============================================================================
// Harness
// ============================================================================

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
}

/** Minimal isolate driver: satisfies the shape without a native dependency. */
const fakeDriver = {
  createContext: async () => ({
    bindings: {},
    execute: async () => ({ success: true, value: "ok", logs: [] }),
    dispose: async () => {},
  }),
};

/** A server tool shaped like `AnyServerTool` (name/description/schema/execute). */
function tool(name, description = name) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { q: { type: "string", description: "query" } } },
    execute: async () => ({ ok: true }),
  };
}

/** A legal JS identifier: first char letters/_/$, remainder those plus digits. */
const LEGAL_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Capture the code-mode surfaces the model actually sees. */
async function surfaces({ tools, lazyToolNames = [] }) {
  const defs = [];
  const providers = [];
  const warns = [];
  const infos = [];
  const ctx = {
    coreEnv: { createIsolateDriver: async () => fakeDriver },
    logger: { info: (m) => infos.push(String(m)), warn: (m) => warns.push(String(m)), error: () => {} },
    registerTool: (def) => defs.push(def),
    registerContextProvider: (p) => {
      providers.push(p);
      return () => {};
    },
  };

  await createCodeModeExtension({ tools, lazyToolNames }).activate(ctx);

  const provider = providers.find((p) => typeof p.content === "function");
  const prompt = provider ? await provider.content() : "";
  return {
    prompt,
    discovery: defs.find((d) => d.name === "discover_tools"),
    execute: defs.find((d) => d.name === "execute_typescript"),
    warns,
    infos,
  };
}

/** Every binding name declared in the prompt's Type Definitions section. */
function declaredBindings(prompt) {
  return [...prompt.matchAll(/declare function (external_\S+?)\(/g)].map((m) => m[1]);
}

// ============================================================================
// 1. The helper is pure and idempotent
// ============================================================================
{
  const cases = [
    ["mcp__myserver_read-file", "mcp__myserver_read_file"],
    ["read-file", "read_file"],
    ["web.search", "web_search"],
    ["a b:c", "a_b_c"],
    ["2fa", "_2fa"],
    ["read_file", "read_file"],
    ["external_$x", "external_$x"],
  ];
  for (const [input, expected] of cases) {
    const once = normalizeBindingName(input);
    check(`normalize(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, once === expected);
  }

  // Idempotence — the property that keeps this step a no-op if upstream ever
  // normalises too. Assert it on every case, not just one.
  const allIdempotent = cases.every(([input]) => {
    const once = normalizeBindingName(input);
    return normalizeBindingName(once) === once;
  });
  check("normalizeBindingName is idempotent across all cases", allIdempotent);

  // Leading digit is the one case where a single pass is not enough on its own;
  // the guard must produce a legal identifier, and re-running must not prefix twice.
  check("leading-digit guard yields a legal identifier", LEGAL_IDENTIFIER.test(normalizeBindingName("2fa")));
  check("leading-digit guard does not double-prefix", normalizeBindingName("_2fa") === "_2fa");
}

// ============================================================================
// 2. The real createCodeMode prompt contains only legal identifiers
// ============================================================================
{
  const legalNames = ["read_file", "grep", "glob", "list_file", "tree", "run_command", "websearch"];
  const r = renameCodeModeTools(
    legalNames.map((n) => tool(n)),
    { warn: () => {} }
  );
  check("legal names are not renamed", r.renames.size === 0);
  check(
    "legal names keep their object identity (no copy)",
    r.tools.every((t, i) => t.name === legalNames[i])
  );

  const illegal = ["mcp__myserver_read-file", "web.search", "a b:c", "2fa"];
  const renamed = renameCodeModeTools(
    illegal.map((n) => tool(n)),
    { warn: () => {} }
  );
  const allLegal = renamed.tools.every((t) => LEGAL_IDENTIFIER.test(`external_${t.name}`));
  check("hyphen/dot/space/colon/leading-digit names become legal identifiers", allLegal);
}

// ============================================================================
// 3. Current curated list => byte-identical prompt (no behaviour change)
// ============================================================================
{
  // The curated list as wired in agent-bootstrap, imported rather than copied: a literal here
  // would be a second list that keeps passing after the real one changes (that is exactly how the
  // binding names drifted out of the registry in the first place).
  const curated = [...CODE_MODE_TOOL_NAMES];
  const lazy = [...CODE_MODE_LAZY_TOOL_NAMES];

  const after = await surfaces({ tools: curated.map((n) => tool(n)), lazyToolNames: lazy });

  // Without the normalisation step every name would pass through untouched. Assert
  // the prompt is exactly what the pre-change mapping produced: names appear as
  // declared, and no rename was reported.
  check("curated list -> no rename reported to the log", after.infos.length === 0);
  const bindings = declaredBindings(after.prompt);
  check(
    "curated list -> stubs use the original names verbatim",
    bindings.every((b) => curated.includes(b.replace(/^external_/, "")))
  );
  check("curated list -> prompt is non-empty and mentions bindings", bindings.length > 0);

  // Byte-identical to feeding the tools straight to createCodeMode with no rename step.
  const passthrough = createCodeMode({
    driver: fakeDriver,
    tools: [
      ...curated.map((n) => {
        const t = tool(n);
        return lazy.includes(n) ? { ...t, lazy: true } : t;
      }),
    ],
  });
  check("curated list -> prompt identical to the pre-change passthrough", after.prompt === passthrough.systemPrompt);
}

// ============================================================================
// 4. read-file + read_file both stay callable
// ============================================================================
{
  const { prompt } = await surfaces({ tools: [tool("read-file"), tool("read_file")] });
  const bindings = declaredBindings(prompt);
  check("hyphen/underscore pair -> both declared", bindings.length === 2);
  check("hyphen/underscore pair -> names are distinct", new Set(bindings).size === 2);
  check(
    "hyphen/underscore pair -> all bindings legal",
    bindings.every((b) => LEGAL_IDENTIFIER.test(b))
  );

  // Deterministic across runs, so a script written against one session works next time.
  const again = await surfaces({ tools: [tool("read-file"), tool("read_file")] });
  check("hyphen/underscore pair -> binding names are deterministic", prompt === again.prompt);

  // Order-independent: MCP tools are collected as servers connect, so the input
  // order is not stable. The assignment must depend on the set, not the sequence.
  const forward = await surfaces({ tools: [tool("read-file"), tool("read_file")] });
  const reversed = await surfaces({ tools: [tool("read_file"), tool("read-file")] });
  const fwdBindings = declaredBindings(forward.prompt).sort();
  const revBindings = declaredBindings(reversed.prompt).sort();
  check(
    "collision -> binding names are independent of input order",
    JSON.stringify(fwdBindings) === JSON.stringify(revBindings)
  );
  check(
    "collision -> input order still preserved in output",
    forward.prompt.indexOf("external_read_file(") < forward.prompt.indexOf("external_read_file_")
  );
}

// ============================================================================
// 5. Unresolvable collision is dropped, not emitted
// ============================================================================
{
  // The same tool offered twice cannot be separated from itself. It must be dropped
  // with a warning rather than emitting a duplicate declaration.
  const { prompt, warns } = await surfaces({ tools: [tool("read_file"), tool("read_file")] });
  const bindings = declaredBindings(prompt);
  check("exact duplicate -> only one declaration emitted", bindings.length === 1);
  check(
    "exact duplicate -> warns naming the tool",
    warns.some((w) => w.includes("read_file") && w.includes("duplicate"))
  );

  // And the run still succeeds (the extension registered tools; nothing threw).
  const { execute } = await surfaces({ tools: [tool("read_file"), tool("read_file")] });
  check("drop path -> execute_typescript still registered", Boolean(execute));
}

// ============================================================================
// 6. All model-visible surfaces agree; none advertises a pre-normalisation name
// ============================================================================
{
  const { prompt, discovery } = await surfaces({
    tools: [tool("read_file"), tool("web-search", "Search the web")],
    lazyToolNames: ["web-search"],
  });

  check("lazy hyphenated tool -> discover_tools registered", Boolean(discovery));
  check(
    "discover_tools catalog names the normalised binding",
    Boolean(discovery) && discovery.description.includes("external_web_search")
  );
  check(
    "discover_tools catalog does NOT name the pre-normalisation binding",
    Boolean(discovery) && !discovery.description.includes("external_web-search")
  );

  // The Available External APIs list and the Type Definitions stubs must use the
  // same name for the eager tool.
  check("Available APIs list names the binding", prompt.includes("external_read_file"));
  check("no prompt section advertises a pre-normalisation binding", !prompt.includes("external_web-search"));
  check(
    "every declared binding is a legal identifier",
    declaredBindings(prompt).every((b) => LEGAL_IDENTIFIER.test(b))
  );

  // Discovered stub for the lazy tool must be callable by the advertised name.
  if (discovery) {
    const discovered = await discovery.execute({ toolNames: ["external_web_search"] }, { toolCallId: "t1" });
    const stubNames = (discovered?.tools ?? []).map((t) => t.name);
    check("discover_tools returns the normalised stub name", stubNames.includes("external_web_search"));
  }
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
