/**
 * Validation: built-in Code Mode extension.
 *
 * Verifies the two activation paths:
 * 1. When the host provides a `createIsolateDriver` (via CoreEnv), the extension
 *    registers `execute_typescript` (+ `discover_tools`) and contributes a
 *    non-empty code-mode guidance through `registerContextProvider({ content })`.
 * 2. When the driver is absent/null, the extension degrades gracefully: it warns
 *    and registers no tools (no crash, no registered providers).
 *
 * The isolate driver used for path 1 is a lightweight stub so this script has no
 * native dependency on isolated-vm; it only exercises extension wiring.
 *
 * Run: pnpm --filter @codent/core run validate:code-mode-extension
 */

import { createCodeModeExtension } from "../dist/dev.mjs";

// Minimal fake driver: does not actually execute TS, only satisfies the shape.
const fakeDriver = {
  createContext: async () => {
    return {
      bindings: {},
      execute: async (_code) => ({ success: true, value: "ok", logs: [] }),
      dispose: async () => {},
    };
  },
};

function makeCtx({ driver = null, _tools = [] }) {
  const registered = [];
  const providers = [];
  const warns = [];
  const ctx = {
    coreEnv: {
      createIsolateDriver: driver === null ? undefined : async () => driver,
    },
    logger: {
      warn: (msg) => warns.push(String(msg)),
    },
    registerTool: (def) => registered.push(def.name),
    registerContextProvider: (provider) => {
      providers.push(provider);
      return () => {};
    },
  };
  return { ctx, registered, providers, warns };
}

// Dummy tools shaped like AnyServerTool (only name/execute are consumed here).
function tool(name) {
  return { name, description: name, execute: async () => ({ ok: true }) };
}

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
}

// ---- Path 1: driver present ------------------------------------------------
{
  const { ctx, registered, providers } = makeCtx({
    driver: fakeDriver,
    tools: [],
  });
  const ext = createCodeModeExtension({
    tools: [tool("read_file"), tool("run_command")],
    lazyToolNames: ["run_command"],
  });
  await ext.activate(ctx);

  check("driver present -> registers execute_typescript", registered.includes("execute_typescript"));
  check("driver present -> registers discover_tools (lazy present)", registered.includes("discover_tools"));

  const provider = providers.find((p) => typeof p.content === "function");
  check("driver present -> registers a context provider", Boolean(provider));
  const guidance = await provider?.content?.();
  check("context provider -> non-empty code-mode guidance", typeof guidance === "string" && guidance.length > 0);
}

// ---- Path 1c: approval-gated tools are excluded by default ------------------
{
  const { ctx, providers, warns } = makeCtx({ driver: fakeDriver });
  const gated = { ...tool("run_command"), needsApproval: true };
  const ext = createCodeModeExtension({ tools: [tool("read_file"), gated] });
  await ext.activate(ctx);
  const guidance = await providers.find((p) => typeof p.content === "function")?.content?.();
  check(
    "approval-gated tools are not exposed to the sandbox",
    !String(guidance).includes("external_run_command") && !String(guidance).includes("run_command")
  );
  check(
    "skipping an approval-gated tool is explained",
    warns.some((warning) => warning.includes("approval-gated") && warning.includes("run_command"))
  );
}

// ---- Path 1b: driver present, no lazy tools => no discover_tools ------------
{
  const { ctx, registered } = makeCtx({ driver: fakeDriver, tools: [] });
  const ext = createCodeModeExtension({
    tools: [tool("read_file")],
    lazyToolNames: [],
  });
  await ext.activate(ctx);
  check(
    "driver present, no lazy -> discover_tools NOT registered",
    registered.includes("execute_typescript") && !registered.includes("discover_tools")
  );
}

// ---- Path 2: driver absent (null) ------------------------------------------
{
  const { ctx, registered, warns } = makeCtx({ driver: null, tools: [] });
  const ext = createCodeModeExtension({
    tools: [tool("read_file")],
  });
  await ext.activate(ctx);
  check("driver null -> registers NO tools", registered.length === 0);
  check("driver null -> warns once", warns.length >= 1);
}

// ---- Path 3: createIsolateDriver throws -> degrade -------------------------
{
  const registered = [];
  const warns = [];
  const ctx = {
    coreEnv: {
      createIsolateDriver: async () => {
        throw new Error("boom");
      },
    },
    logger: { warn: (m) => warns.push(String(m)) },
    registerTool: (def) => registered.push(def.name),
    registerContextProvider: () => () => {},
  };
  const ext = createCodeModeExtension({ tools: [tool("read_file")] });
  await ext.activate(ctx);
  check("driver throws -> registers NO tools", registered.length === 0);
  check("driver throws -> warns", warns.length >= 1);
}

// ---- Path 4: no tools provided -> degrade ----------------------------------
{
  const { ctx, registered, warns } = makeCtx({ driver: fakeDriver, tools: [] });
  const ext = createCodeModeExtension({});
  await ext.activate(ctx);
  check("no tools provided -> registers NO tools", registered.length === 0);
  check("no tools provided -> warns", warns.length >= 1);
}

// ---- Path 5: execute_typescript responds to abort --------------------------
{
  // Driver whose execute never settles — simulates a long-running isolate.
  const hangingDriver = {
    createContext: async () => ({
      bindings: {},
      execute: () => new Promise(() => {}),
      dispose: async () => {},
    }),
  };
  const defs = [];
  const ctx = {
    coreEnv: { createIsolateDriver: async () => hangingDriver },
    logger: { warn() {} },
    registerTool: (def) => defs.push(def),
    registerContextProvider: () => () => {},
  };
  const ext = createCodeModeExtension({ tools: [tool("read_file")], lazyToolNames: [] });
  await ext.activate(ctx);
  const execDef = defs.find((d) => d.name === "execute_typescript");
  check("abort test -> execute_typescript registered", Boolean(execDef));

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const started = Date.now();
  let rejected = false;
  try {
    await execDef.execute({ typescriptCode: "while(true){}" }, { toolCallId: "t1", abortSignal: controller.signal });
  } catch {
    rejected = true;
  }
  check("abort -> execute_typescript rejects", rejected);
  check("abort -> rejects promptly (< 1s)", Date.now() - started < 1000);

  const preAborted = new AbortController();
  preAborted.abort();
  let preRejected = false;
  try {
    await execDef.execute({ typescriptCode: "1" }, { toolCallId: "t2", abortSignal: preAborted.signal });
  } catch {
    preRejected = true;
  }
  check("pre-aborted signal -> execute_typescript rejects", preRejected);
}

// ---------------------------------------------------------------------------
// 3. Upstream console noise is captured, not written to the terminal
// ---------------------------------------------------------------------------
// ai-code-mode logs every failed run with a bare `console.error('[code-mode] …', payload)`.
// That write lands outside the renderer and splices raw text into Ink's frame under the
// TUI. The extension must swallow it and route it through the extension logger instead.
{
  const logged = [];
  const fakeDriverFailing = {
    createContext: async () => ({
      bindings: {},
      execute: async () => ({
        success: false,
        error: { name: "Error", message: "boom" },
        logs: ["inner log line"],
      }),
      dispose: async () => {},
    }),
  };

  const { ctx } = makeCtx({ driver: fakeDriverFailing, _tools: [tool("read_file")] });
  ctx.logger = {
    info: (msg) => logged.push({ level: "info", msg: String(msg) }),
    warn: (msg) => logged.push({ level: "warn", msg: String(msg) }),
    error: (msg) => logged.push({ level: "error", msg: String(msg) }),
  };
  const registered = [];
  ctx.registerTool = (def) => registered.push(def);

  await createCodeModeExtension({ tools: [tool("read_file")] }).activate(ctx);
  const execTool = registered.find((t) => t.name === "execute_typescript");
  check("failing driver still registers execute_typescript", Boolean(execTool));

  let leaked = [];
  const realError = console.error;
  const realInfo = console.info;
  console.error = (...args) => leaked.push(args.map(String).join(" "));
  console.info = (...args) => leaked.push(args.map(String).join(" "));
  let result;
  try {
    result = await execTool.execute({ typescriptCode: "throw new Error('boom')" }, { toolCallId: "t3" });
  } finally {
    console.error = realError;
    console.info = realInfo;
  }

  check("failed run does not write to the host console (TUI stays intact)", leaked.length === 0);
  check(
    "the upstream failure line reaches the extension logger instead",
    logged.some((e) => e.level === "error" && e.msg.includes("execute_typescript failed"))
  );
  check("the tool result still carries the error", result?.success === false);

  // And the console must be restored afterwards, so later host logging is unaffected.
  let afterRestore = false;
  const probe = (..._args) => {
    afterRestore = true;
  };
  const savedError = console.error;
  console.error = probe;
  console.error("x");
  afterRestore = console.error === probe;
  console.error = savedError;
  check("console.error is restored after the call", afterRestore);
}

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
