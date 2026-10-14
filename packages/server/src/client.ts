/**
 * Lightweight CoreEnv client that connects to a CoreEnv HTTP server via Hono RPC.
 *
 * Only imports `hono/client` and `@codent/core` types — no server dependencies.
 *
 * LLM provider is orthogonal — use {@link createRemoteProvider} separately when
 * keys should stay on a remote provider server.
 *
 * @example
 * ```typescript
 * import { registerCoreEnv, registerModelProvider } from "@codent/core";
 * import { createRemoteEnv, createRemoteProvider } from "@codent/server/client";
 *
 * registerCoreEnv(await createRemoteEnv("http://localhost:3100"));
 * registerModelProvider(await createRemoteProvider("http://localhost:3100"));
 * ```
 */

import { ExecutionError, FileError, defaultPath } from "@codent/core";
import { hc } from "hono/client";

import type { AppType } from ".";
import type {
  CommandJobStatus,
  CommandResult,
  CoreEnv,
  CoreEnvExecResult,
  CoreEnvFs,
  CoreEnvFsStat,
  CoreEnvPath,
  FileEntry,
  McpProcessHandle,
  McpStdioTransportConfig,
  RunCommandOptions,
  StartCommandHandle,
  StartCommandOptions,
} from "@codent/core";

export { createRemoteProvider } from "./remote-provider.js";
export { createRemoteAgentSessionHost } from "./remote-session-host.js";

type Client = ReturnType<typeof hc<AppType>>;

// ============================================================================
// Error Deserialization
// ============================================================================

interface ErrorPayload {
  error: true;
  name: string;
  code: string;
  message: string;
  path?: string;
}

function isErrorPayload(data: unknown): data is ErrorPayload {
  return typeof data === "object" && data !== null && (data as Record<string, unknown>).error === true;
}

function deserializeError(payload: ErrorPayload): Error {
  if (payload.name === "FileError") {
    return new FileError(payload.code as never, payload.message, payload.path);
  }
  if (payload.name === "ExecutionError") {
    return new ExecutionError(payload.code as never, payload.message);
  }
  return new Error(payload.message);
}

async function unwrap<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    if (isErrorPayload(payload)) throw deserializeError(payload);
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return (await response.json()) as T;
}

// ============================================================================
// Remote CoreEnvFs
// ============================================================================

function createRemoteFs(client: Client): CoreEnvFs {
  return {
    readFile: (async (path: string, encoding?: string) => {
      if (encoding === "buffer") {
        const res = await client.fs.readFile.$post({ json: { path, encoding: "base64" } });
        const data = await unwrap<{ content: string }>(res);
        const binary = atob(data.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }
      const wireEncoding = encoding === "utf8" || encoding === "base64" ? encoding : undefined;
      const res = await client.fs.readFile.$post({ json: { path, encoding: wireEncoding } });
      const data = await unwrap<{ content: string }>(res);
      return data.content;
    }) as CoreEnvFs["readFile"],

    /**
     * Byte-window read over the wire, so a tail-anchored consumer does not download the file.
     *
     * This is the difference between `/resume` costing a few KB and costing every session log
     * whole (217 MB in this workspace): `list()` only needs each log's last line, and without
     * this the client had no way to ask for less than all of it.
     */
    readFileRange: async (path: string, start: number, end: number) => {
      const res = await client.fs.readFile.$post({ json: { path, start, end } });
      const data = await unwrap<{ content: string }>(res);
      return data.content;
    },

    stat: async (path: string): Promise<CoreEnvFsStat> => {
      const res = await client.fs.stat.$post({ json: { path } });
      const data = await unwrap<{ isDirectory: boolean; isFile: boolean; size: number; mtime: string }>(res);
      return { ...data, mtime: new Date(data.mtime) };
    },

    readdir: async (path: string): Promise<FileEntry[]> => {
      const res = await client.fs.readdir.$post({ json: { path } });
      const data = await unwrap<{
        entries: Array<{ name: string; type: "file" | "directory"; size?: number; modified?: string }>;
      }>(res);
      return data.entries.map((e) => ({
        name: e.name,
        type: e.type,
        size: e.size,
        modified: e.modified ? new Date(e.modified) : undefined,
      }));
    },

    writeFile: async (path: string, content: string | Uint8Array): Promise<void> => {
      if (typeof content === "string") {
        const res = await client.fs.writeFile.$post({ json: { path, content } });
        await unwrap(res);
        return;
      }
      let binary = "";
      for (let i = 0; i < content.length; i++) binary += String.fromCharCode(content[i]!);
      const res = await client.fs.writeFile.$post({
        json: { path, content: btoa(binary), encoding: "base64" },
      });
      await unwrap(res);
    },

    mkdir: async (path: string): Promise<void> => {
      const res = await client.fs.mkdir.$post({ json: { path } });
      await unwrap(res);
    },

    exists: async (path: string): Promise<boolean> => {
      const res = await client.fs.exists.$post({ json: { path } });
      const data = await unwrap<{ exists: boolean }>(res);
      return data.exists;
    },

    remove: async (path: string): Promise<void> => {
      const res = await client.fs.remove.$post({ json: { path } });
      await unwrap(res);
    },

    appendFile: async (path: string, content: string): Promise<void> => {
      const res = await client.fs.appendFile.$post({ json: { path, content } });
      await unwrap(res);
    },

    rename: async (oldPath: string, newPath: string): Promise<void> => {
      const res = await client.fs.rename.$post({ json: { oldPath, newPath } });
      await unwrap(res);
    },
  };
}

// ============================================================================
// createRemoteEnv
// ============================================================================

function serializeRunOptions(options?: RunCommandOptions) {
  if (!options) return undefined;
  const { onStdout: _, onStderr: __, ...rest } = options;
  return rest;
}

/**
 * Ask the server whether it implements the argv-execution route.
 *
 * The probe sends a binary name that cannot exist (`codent-probe-…`, namespaced so it cannot
 * collide with anything on the server's PATH). This is what makes the answer trustworthy on a
 * *real* current server, not just on the fakes a validator stands up:
 *
 *   - a server with the route resolves the request through its env; a missing binary is a
 *     normal outcome there, so the route answers `200` with `missing: true` and support is
 *     confirmed
 *   - a server from an earlier release has no route: `404` with a plain-text body, so
 *     `res.json()` fails
 *   - a proxy or a different service answers with HTML, or anything else in the 4xx range
 *     that means "no such route"
 *
 * An earlier probe sent `file: ""`, which a real server turned into a Node `execFile("")`
 * throw → a `500` — read here as "not unsupported", so the capability was silently absent for
 * every remote client. A `5xx` is deliberately NOT treated as "unsupported": that is a working
 * server failing, and silently degrading would hide it. Only "this server does not have the
 * route" counts.
 */
async function probeExecFileSupport(client: ReturnType<typeof hc<AppType>>, baseUrl: string): Promise<boolean> {
  try {
    const res = await client.command["exec-file"].$post({
      json: { file: "codent-probe-exec-file-absent", args: [] },
    });
    if (res.ok) return true;
    // A server that knows the route but rejects this probe (a 400 for a bad file name, say)
    // still has the route, which is all this needs to establish.
    if (res.status === 400) {
      const payload = (await res.json().catch(() => null)) as { code?: string } | null;
      return payload?.code !== "unsupported";
    }
    return false;
  } catch {
    // A transport-level failure (DNS, connection refused, HTML body) is not evidence of
    // support, and must not break env creation.
    console.warn(`[server] could not probe argv execution at ${baseUrl}; falling back to shell commands`);
    return false;
  }
}

/**
 * Create a {@link CoreEnv} that delegates to a remote CoreEnv HTTP server via Hono RPC.
 *
 * Synchronous utilities (`path`, `byteLength`, `base64*`) use core defaults locally.
 * Only I/O operations (fs, commands, fetch) are proxied over HTTP.
 *
 * @param serverUrl - Base URL of the CoreEnv server (e.g. `"http://localhost:3100"`)
 */
export async function createRemoteEnv(serverUrl: string): Promise<CoreEnv> {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  const client = hc<AppType>(`${baseUrl}/api`);

  const infoRes = await client.env.info.$get();
  const info = await unwrap<{ rootPath: string; platform: string; arch: string; homedir: string; sep?: string }>(
    infoRes
  );

  const serverSep = info.sep || "/";

  // Probe once whether the server can execute an argv directly, and only advertise `execFile`
  // when it can.
  //
  // The previous version always defined `execFile` and mapped only `400 + code:"unsupported"`
  // to `null`. A server from an earlier release answers an unknown route with a `404` and a
  // plain-text body, so `res.json()` failed and the error propagated out of the call: the tools
  // saw a function to feature-detect, took the argv path, and threw instead of falling back to
  // the string path — the opposite of the "degrade rather than break" contract.
  //
  // Probing up front means the capability is a property of the env rather than a question asked
  // per call, which is also what `canExecArgs()` assumes when it checks for the function.
  const supportsExecFile = await probeExecFileSupport(client, baseUrl);

  const path: CoreEnvPath =
    serverSep === "/"
      ? defaultPath
      : {
          ...defaultPath,
          getSep: () => serverSep,
          isAbsolute: (p) => p.startsWith(serverSep) || defaultPath.isAbsolute(p),
        };

  // Track MCP stdio sessions created by this env, so getMCPTransportProcess
  // can issue a remote kill when the process manager cleans up.
  const transportSessions = new WeakMap<object, string>();

  return {
    rootPath: info.rootPath,

    path,

    getPlatform: async () => info.platform,
    getArch: async () => info.arch,
    getEnv: async () => {
      const res = await client.env.vars.$get();
      return await unwrap<Record<string, string | undefined>>(res);
    },
    homedir: async () => info.homedir,

    fs: createRemoteFs(client),

    runCommand: async (command: string, options?: RunCommandOptions): Promise<CommandResult> => {
      // The signal goes on the REQUEST, not in the body: aborting it (Esc) closes the connection, which is
      // what the server turns into a kill for its child process. Without this a remote search kept running
      // to its own deadline after the user had stopped looking at it.
      const res = await client.command.run.$post(
        { json: { command, options: serializeRunOptions(options) } },
        // `init` is Hono's RequestInit passthrough — only `signal` here, so nothing Hono sets is overridden.
        { init: { signal: options?.signal } }
      );
      const result = await unwrap<CommandResult>(res);
      // HTTP `/run` is request/response only — no chunk streaming. Deliver the full
      // buffers once so callers that accumulate via onStdout/onStderr (run_command tool)
      // still see output. Mid-run streaming remains unavailable over remote CoreEnv.
      if (result.stdout) options?.onStdout?.(result.stdout);
      if (result.stderr) options?.onStderr?.(result.stderr);
      return result;
    },

    exec: async (command: string, options?): Promise<CoreEnvExecResult> => {
      const res = await client.command.exec.$post({ json: { command, options } });
      return await unwrap<CoreEnvExecResult>(res);
    },

    // Argument-vector execution over the same transport as the other command primitives.
    //
    // Undefined when the probed capability is missing, so `canExecArgs()` is false and the tools
    // take the string path. Defined only when the server really has the route, so a call cannot
    // throw the way it did when the function always existed.
    execFile: supportsExecFile
      ? ((async (file: string, args: string[], options?): Promise<CoreEnvExecResult | null> => {
          const res = await client.command["exec-file"].$post(
            {
              json: { file, args, options: { cwd: options?.cwd, timeout: options?.timeout, env: options?.env } },
            },
            // See the sibling above: the request's abort is what reaches the server's child process.
            { init: { signal: options?.signal } }
          );
          if (!res.ok) {
            // The capability was probed at construction, so an `unsupported` answer here is a
            // server that changed underneath us. Returning null keeps the tools' existing
            // fallback behaviour instead of turning it into an exception; the other calls have
            // already had their chance by this point, so this is the graceful ending.
            const payload = (await res.json().catch(() => null)) as { code?: string } | null;
            if (payload?.code === "unsupported" || res.status === 404) return null;
            return await unwrap<CoreEnvExecResult>(res);
          }
          return await unwrap<CoreEnvExecResult>(res);
        }) as CoreEnv["execFile"])
      : undefined,

    startCommand: async (command: string, options?: StartCommandOptions): Promise<StartCommandHandle> => {
      const res = await client.command.start.$post({
        json: { command, options: { cwd: options?.cwd, env: options?.env } },
      });
      const { id, pid } = await unwrap<{ id: string; pid?: number }>(res);

      // Background polling loop: fetches incremental output from server
      // and feeds it to the local callbacks so the in-process JobRegistry
      // (used by get_command_output / kill_command) stays populated.
      let pollActive = true;
      let sinceStdout = 0;
      let sinceStderr = 0;

      const pollLoop = async () => {
        while (pollActive) {
          try {
            const outRes = await client.command.output.$post({
              json: { id, sinceStdout, sinceStderr },
            });
            const data = await unwrap<{
              status: CommandJobStatus;
              stdout: string;
              stderr: string;
              exitCode: number | null;
              running: boolean;
            }>(outRes);

            if (data.stdout && options?.onStdout) {
              options.onStdout(data.stdout);
              sinceStdout += data.stdout.length;
            }
            if (data.stderr && options?.onStderr) {
              options.onStderr(data.stderr);
              sinceStderr += data.stderr.length;
            }
            if (!data.running) {
              options?.onExit?.(data.exitCode);
              pollActive = false;
              break;
            }
          } catch {
            if (pollActive) {
              try {
                // Check if job still exists — 404 means already cleaned up
                const checkRes = await client.command.output.$post({ json: { id, sinceStdout, sinceStderr } });
                if (!checkRes.ok) {
                  pollActive = false;
                  break;
                }
              } catch {
                pollActive = false;
                break;
              }
            }
            break;
          }

          if (pollActive) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      };

      // Fire-and-forget: tool callbacks will be fed as output arrives
      pollLoop();

      return {
        pid,
        kill: async () => {
          pollActive = false;
          await fetch(`${baseUrl}/api/command/${id}`, { method: "DELETE" });
        },
      };
    },

    fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : undefined);
      const headers: Record<string, string> = {};
      const rawHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
      if (rawHeaders) {
        if (rawHeaders instanceof Headers) {
          rawHeaders.forEach((v, k) => {
            headers[k] = v;
          });
        } else if (Array.isArray(rawHeaders)) {
          for (const [k, v] of rawHeaders) headers[k] = v;
        } else {
          Object.assign(headers, rawHeaders);
        }
      }
      const body = typeof init?.body === "string" ? init.body : undefined;

      // Forward the caller's AbortSignal onto the RPC call. Without it a provider's
      // timeout (or a user cancel) could not abort the remote proxy request: the local
      // timer fires but the `await` never rejects, so a hung upstream held the search
      // past its deadline. Aborting the RPC aborts `c.req.raw.signal` server-side, which
      // the fetch route wires to its own outbound request.
      const res = await client.fetch.proxy.$post(
        {
          json: { url, method, headers: Object.keys(headers).length > 0 ? headers : undefined, body },
        },
        { init: { signal: init?.signal } }
      );
      const data = await unwrap<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: string;
        encoding?: "text" | "base64";
      }>(res);

      let responseBody: BodyInit;
      if (data.encoding === "base64") {
        const binary = atob(data.body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        responseBody = bytes;
      } else {
        responseBody = data.body;
      }

      return new Response(responseBody, {
        status: data.status,
        statusText: data.statusText,
        headers: data.headers,
      });
    },

    getMimeType: async (filePath: string) => {
      const res = await client.fs.mimeType.$post({ json: { path: filePath } });
      const data = await unwrap<{ mimeType: string | false }>(res);
      return data.mimeType;
    },

    destroy: async () => {
      try {
        const res = await client.env.destroy.$post();
        await unwrap<{ ok: boolean }>(res);
      } catch {
        // Server may already be gone
      }
    },

    // =============================================================================
    // MCP Stdio Transport (proxy via HTTP to the remote server)
    // =============================================================================
    // We track transports in a WeakMap so getMCPTransportProcess can look up
    // the session ID and issue a remote cleanup.
    createMCPStdioTransport: (config: McpStdioTransportConfig) => {
      const apiUrl = `${baseUrl}/api/mcp`;

      // sessionId is stored in closure (not on the transport object) to keep
      // the transport shape compatible with @ai-sdk/mcp MCPTransport interface.
      let sessionId: string | null = null;

      // Helper: performs HTTP POST and dispatches responses via onmessage
      const performSend = async (sid: string, msg: unknown): Promise<void> => {
        const res = await fetch(`${apiUrl}/${sid}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`MCP message failed: ${res.status} ${text}`);
        }
        const data = await res.json();
        if (!data.responses) return;
        for (const response of data.responses as unknown[]) {
          transport.onmessage?.(response);
        }
      };

      const transport: {
        start(): Promise<void>;
        send(message: unknown): Promise<void>;
        close(): Promise<void>;
        onclose?: () => void;
        onerror?: (error: Error) => void;
        onmessage?: (message: unknown) => void;
      } = {
        async start() {
          const res = await fetch(`${apiUrl}/init`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(config),
          });
          if (!res.ok) {
            const text = await res.text();
            throw new Error(`MCP init failed: ${res.status} ${text}`);
          }
          const data = await res.json();
          sessionId = data.id;
          transportSessions.set(transport, data.id);
        },

        send(message: unknown): Promise<void> {
          // Send the message via HTTP. The returned promise:
          // - Resolves once the HTTP request completes (responses dispatched via onmessage)
          // - Rejects if the HTTP request fails (propagated to request() promise)
          // Errors are also forwarded to onerror for uncaught error handling.
          const sid = sessionId;
          if (!sid) throw new Error("MCP transport not started");
          const promise = performSend(sid, message);
          promise.catch((err: unknown) => {
            transport.onerror?.(err instanceof Error ? err : new Error(String(err)));
          });
          return promise;
        },

        async close() {
          const sid = sessionId;
          if (sid) {
            try {
              await fetch(`${apiUrl}/${sid}`, { method: "DELETE" });
            } catch {
              // Server may already be gone
            }
            sessionId = null;
          }
          transport.onclose?.();
        },
      };

      return transport;
    },

    getMCPTransportProcess: (transport: unknown): McpProcessHandle | undefined => {
      const sid = transportSessions.get(transport as object);
      if (!sid) return undefined;
      return {
        killed: false,
        kill: () => {
          fetch(`${baseUrl}/api/mcp/${sid}`, { method: "DELETE" }).catch(() => {});
          return true;
        },
      };
    },
  };
}
