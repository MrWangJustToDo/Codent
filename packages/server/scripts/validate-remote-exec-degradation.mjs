/**
 * Validate that a remote CoreEnv degrades when the server predates `execFile`.
 *
 * Why this exists: `createRemoteEnv` is meant to advertise `execFile` only when the server can
 * serve it, and otherwise let the tools fall back to the string path (task 1.7 / the spec's
 * "degrade rather than break"). The mapping only covered `400 + code: "unsupported"`, so a server
 * from an earlier release — which 404s an unknown route with a plain-text body — made the call
 * *throw*, while `execFile` still looked present to `canExecArgs()`. The result was the worst of
 * both: no fallback, and a thrown error.
 *
 * Runs anywhere: it stands up a local HTTP server that mimics an old release and asserts the
 * contract, without needing a second checkout.
 *
 * The fake servers above answer the probe with canned responses, which is exactly the blind
 * spot that hid the second bug: the real probe once sent `file: ""`, and a *real* server turned
 * that into a Node `execFile("")` throw → `500` → the probe read it as "not unsupported" → the
 * capability was silently absent for every remote client. No fake could see it, because fakes
 * never run the real route. The last section therefore mounts the actual Hono `api` app over a
 * real HTTP server with a real `@codent/node` env, and asserts the probe's answer end to end.
 */

import { clearCoreEnv, registerCoreEnv } from "@codent/core";
import { createServer } from "node:http";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";
import { createRemoteEnv } from "../dist/client.mjs";

// The argv helper and the tool factory are internal, so they come from core's dev entry —
// deliberately outside the published export map. See core's dev.ts.
// Already a URL — `.href` is directly importable; no path conversion needed.
const devEntry = new URL("../../core/dist/dev.mjs", import.meta.url).href;
const { canExecArgs, createGlobTool } = await import(devEntry);

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`PASS  ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

const INFO = {
  rootPath: "/repo",
  platform: "linux",
  arch: "x64",
  homedir: "/home/user",
  sep: "/",
};

/**
 * Start a fake CoreEnv server. `execFileHandler` decides how `/api/command/exec-file` responds, so
 * each old-server shape can be exercised: a 404 with a plain-text body (an earlier release), a
 * 404 with HTML (a proxy in front), and a 500.
 */
async function withServer(execFileHandler, run) {
  const server = createServer((req, res) => {
    if (req.url?.includes("/api/env/info")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(INFO));
      return;
    }
    if (req.url?.includes("/api/command/exec-file")) {
      execFileHandler(res);
      return;
    }
    // The string path the tools must fall back to.
    if (req.url?.includes("/api/command/run")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stdout: "found-one\n", stderr: "", exitCode: 0, durationMs: 1 }));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await run(`http://localhost:${port}`);
  } finally {
    server.close();
  }
}

/** Old release: the route does not exist, so a plain-text 404 comes back. */
const notFound = (res) => {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not Found");
};

// ---------------------------------------------------------------------------
// an old server must not make execFile throw
// ---------------------------------------------------------------------------

await withServer(notFound, async (url) => {
  const env = await createRemoteEnv(url);

  // The capability must be absent, not present-and-throwing. `canExecArgs()` tests for the
  // function, so a defined function would send the tools down the argv path.
  check(
    "a pre-change server leaves execFile undefined (capability absent)",
    env.execFile === undefined,
    `typeof execFile = ${typeof env.execFile}`
  );

  // The contract that matters: the tools still work, through the string path.
  clearCoreEnv();
  registerCoreEnv(env);
  check(
    "canExecArgs() therefore reports the argv path as unavailable",
    canExecArgs(env) === false,
    "a defined function would make the tools take the argv path and throw"
  );

  const glob = await createGlobTool().execute({ pattern: "**/*.ts", path: "." }, { toolCallId: "t-old" });
  check(
    "glob still returns results against a pre-change server (string fallback)",
    glob.files.length > 0,
    `files=${JSON.stringify(glob.files)}`
  );
});

// ---------------------------------------------------------------------------
// a non-JSON error body must degrade the same way
// ---------------------------------------------------------------------------

await withServer(
  (res) => {
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<html><body>404</body></html>");
  },
  async (url) => {
    const env = await createRemoteEnv(url);
    check(
      "an HTML 404 body degrades instead of throwing (res.json() would fail)",
      env.execFile === undefined,
      `typeof execFile = ${typeof env.execFile}`
    );
  }
);

// ---------------------------------------------------------------------------
// a supported server still works, and real errors still surface
// ---------------------------------------------------------------------------

await withServer(
  (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ stdout: "hello\n", stderr: "", code: 0 }));
  },
  async (url) => {
    const env = await createRemoteEnv(url);
    const result = await env.execFile("/bin/echo", ["hello"], {});
    check(
      "a server that supports the route returns its result",
      result !== null && result.stdout === "hello\n",
      JSON.stringify(result)
    );
  }
);

await withServer(
  (res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal" }));
  },
  async (url) => {
    const env = await createRemoteEnv(url);
    let thrown = null;
    try {
      await env.execFile("/bin/true", [], {});
    } catch (error) {
      thrown = error;
    }
    check(
      "a genuine server error still surfaces (not silently degraded)",
      thrown !== null,
      "a 500 is a real failure, not a missing capability"
    );
  }
);

// ---------------------------------------------------------------------------
// the real route, end to end
// ---------------------------------------------------------------------------
//
// The canned fakes above answer the probe without running it, which is exactly how the
// `file: ""` probe bug stayed invisible: a real server turned the empty name into a Node
// `execFile("")` throw → `500` → the probe read that as "not unsupported" → the capability was
// silently absent for every remote client. This section mounts the actual Hono `api` app with
// a real `@codent/node` env so the probe travels the true path: zod validation, the route, the
// env, and Node's own spawn behaviour.

const { app } = await import("../dist/index.mjs");
const { createNodeEnv } = await import("@codent/node");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const tempRoot = mkdtempSync(join(tmpdir(), "codent-exec-probe-"));
const realEnv = createNodeEnv({ rootPath: tempRoot, sandbox: false });
clearCoreEnv();
registerCoreEnv(realEnv);

await (async () => {
  // Use @hono/node-server, the same adapter the real server ships with, and the same `app`
  // (CORS + the `/api` prefix) — not the bare `api` sub-router, whose routes would 404.
  const { serve } = await import("@hono/node-server");
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const url = `http://localhost:${address.port}`;
  try {
    const env = await createRemoteEnv(url);
    check(
      "the real route answers the probe as supported (execFile defined)",
      typeof env.execFile === "function",
      `typeof execFile = ${typeof env.execFile} — a 500 from the probe would silently disable argv execution for every remote client`
    );

    if (env.execFile) {
      const echo = process.platform === "win32" ? null : "/bin/echo";
      if (echo) {
        const result = await env.execFile(echo, ["probe-ok"]);
        check(
          "the real route executes a binary end to end",
          result.stdout.trim() === "probe-ok",
          JSON.stringify(result)
        );
      }
    }
  } finally {
    server.close();
    rmSync(tempRoot, TEMP_RM_OPTIONS);
  }
})();

console.log(
  failures === 0
    ? "\nvalidate-remote-exec-degradation: ok"
    : `\nvalidate-remote-exec-degradation FAILED (${failures} case(s))`
);
process.exit(failures === 0 ? 0 : 1);
