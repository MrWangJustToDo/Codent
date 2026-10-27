/**
 * Local bootstrap for the ACP host — the same model-config pipeline as the CLI's
 * local mode and the IM bridge:
 *
 *  1. CoreEnv plane: local workspace fs/shell (`createNodeEnv`, `SANDBOX_ENV`).
 *  2. Provider plane: `.agents/config/models.json` (via `loadModels`) or `.env`
 *     (MODEL / MODEL_STYLE / BASE_URL / API_KEY), then `registerModelProvider`.
 *  3. Session plane: a `CodentAgent` runtime (own env + provider + manager + host).
 *
 * `cwd` MUST be the workspace root: the local CoreEnv is built from it (`createNodeEnv`),
 * so an ACP client should spawn `codent acp` inside the workspace it wants the agent to see.
 *
 * With `--client-env` the local env stops being the whole story: each session gets a CoreEnv whose
 * filesystem and argv execution are borrowed from the ACP client (see `client-env.ts`), with the
 * local env kept as the fallback for everything the client cannot serve. That env is per-session
 * (every client request carries a `sessionId`), so the runtime is per-session too.
 */

import { RequestError } from "@agentclientprotocol/sdk";
import {
  buildDefaultSystemPrompt,
  CodentAgent,
  createDirectModelProvider,
  getModelProvider,
  loadModels,
  registerCoreEnv,
  registerModelProvider,
  registerModelProviderForEntry,
  resolveModelConfig,
  resolveModelConfigFromProvider,
} from "@codent/core";
import { createNodeEnv } from "@codent/node";
import { stat as statPath } from "node:fs/promises";

import { createAcpClientEnv } from "./client-env.js";
import { resolveRoot } from "./paths.js";

import type { AcpAgentDefaults, AcpAgentOptions, AcpSessionRuntime, AcpClientEnvFactoryContext } from "./agent.js";
import type {
  AgentSessionHost,
  ModelProvider,
  ModelStyle,
  ModelCatalogRead,
  LoadedModelEntry,
  SessionMeta,
} from "@codent/core";

function parseModelStyle(value: string | undefined): ModelStyle | undefined {
  return value === "openai" || value === "anthropic" ? value : undefined;
}

/**
 * Explicit model connection for a directly-configured launch
 * (`codent acp --model … --base-url … --api-key …`). When `model` is set it is
 * authoritative and the on-disk `.agents/config/models.json` is skipped.
 */
export interface AcpModelOverride {
  model?: string;
  style?: ModelStyle;
  baseURL?: string;
  apiKey?: string;
  /** Remote model provider URL (`--remote-provider` / REMOTE_PROVIDER). When
   *  set, the provider server holds the LLM keys and supplies the model —
   *  orthogonal to the local CoreEnv, so no explicit `model` is required. */
  remoteProvider?: string;
}

export interface LocalAcpBootstrap {
  host: AgentSessionHost;
  defaults: AcpAgentDefaults;
  rootPath: string;
  /**
   * The selectable models from `.agents/config/models.json`, when that file was the source.
   *
   * Absent on the explicit-flags path (`--model …`) and on the `.env` fallback, which is what
   * makes the ACP model selector disappear there: a selector offering exactly one value would be
   * a fake choice. The list is process-wide (one config file), while the *current* model is
   * per-session — see `sessionConfigOptions` in `agent.ts`.
   */
  /** The runtime's model read (the ONE `loadModels` result) — the host projects it. */
  models?: ModelCatalogRead;
  /** The entry the resolved default model came from — seeds a new session's recorded entry. */
  modelsDefaultEntryIndex?: number;
  /**
   * Build a runtime for one session's workspace root. Always present: `cwd` is the session root in
   * ACP, so even without `--client-env` a session whose `cwd` differs needs its own CoreEnv.
   */
  createSessionHost?: (context: AcpClientEnvFactoryContext) => Promise<AcpSessionRuntime>;
  /** Enumerate persisted sessions for a `session/list` root other than the process default. */
  listPersistedSessionsAt?: (rootPath: string) => Promise<SessionMeta[]>;
}

/** Register CoreEnv + model provider and return a local host + defaults. */
export async function bootstrapLocalAcp(
  options: {
    cwd?: string;
    sandbox?: "local" | "native";
    model?: AcpModelOverride;
    /** `--client-env`: build each session's env from the ACP client's fs/terminal capabilities. */
    clientEnv?: boolean;
  } = {}
): Promise<LocalAcpBootstrap> {
  // Normalized to absolute HERE, at the boundary that accepts a caller-supplied `cwd`: everything
  // downstream assumes an absolute root (see `paths.ts`), and a relative one would quietly make
  // `toWirePath` resolve against `process.cwd()` — the very fallback that file forbids. The other
  // boundary that takes a root is `createAcpAgent({ rootPath })`, which uses the same helper.
  const rootPath = resolveRoot(options.cwd);
  const sandboxMode = options.sandbox ?? (process.env.SANDBOX_ENV === "native" ? "native" : "local");
  const env = createNodeEnv({ rootPath, sandbox: sandboxMode !== "native" });
  registerCoreEnv(env);

  let provider: ModelProvider | undefined;
  let model: string | undefined;
  let style: ModelStyle | undefined;
  let baseURL: string | undefined;
  let apiKey: string | undefined;
  let modelInfo: AcpAgentDefaults["modelInfo"];
  // Built only on the `models.json` path: the flags path deliberately skips that file, and the
  // `.env` fallback has no list at all — so neither can offer a choice.
  /** The one model CATALOG every plane produces; carried by the runtime and projected by the host. */
  let models: ModelCatalogRead | undefined;
  /** The entry that plane's DEFAULT model came from — a seed for a new session, not a selection. */
  let modelsDefaultEntryIndex: number | undefined;
  /** The runtime's read is the catalog; `loaded.active` is only the default a new session is seeded with. */
  const catalogOf = (loaded: { entries: LoadedModelEntry[] }): ModelCatalogRead => ({ entries: loaded.entries });
  /**
   * The flags / `.env` planes: the model is decided outside `models.json`, so the read is ONE entry naming
   * it. That is what lets both model surfaces exist (single fixed value) instead of vanishing.
   */
  const singleModelRead = (c: {
    model: string;
    style: ModelStyle;
    baseURL?: string;
    apiKey?: string;
  }): ModelCatalogRead => ({
    entries: [
      {
        type: "direct",
        style: c.style,
        baseURL: c.baseURL ?? "",
        ...(c.apiKey ? { apiKey: c.apiKey } : {}),
        models: [c.model],
      },
    ],
  });

  if (options.model?.remoteProvider) {
    // Remote provider plane: the server holds the keys and supplies the model,
    // so no explicit `--model` is needed. Mirrors the TUI's remote-provider
    // branch in the release host — CoreEnv stays local, only the provider is
    // remote. `createRemoteProvider` lives in core (global fetch only).
    // ONE pipeline: `loadModels({ kind: "provider" })` asks `/api/provider/info` and builds the entry the
    // client needs (proxy baseURL + sentinel key) *with its selectable list*. The previous branch called
    // `createRemoteProvider` directly, got a connection and no list — which is why this plane had no model
    // selector at all until the host grew a fallback.
    const loaded = await loadModels({ kind: "provider", serverUrl: options.model.remoteProvider });
    if (!loaded) throw new Error(`The provider server at ${options.model.remoteProvider} returned no model info`);
    await registerModelProviderForEntry(loaded);
    provider = getModelProvider();
    const fromProvider = await resolveModelConfigFromProvider({}, provider);
    models = catalogOf(loaded);
    modelsDefaultEntryIndex = loaded.active.entryIndex;
    model = fromProvider.connection.model;
    style = fromProvider.connection.style;
    baseURL = fromProvider.connection.baseURL;
    apiKey = fromProvider.connection.apiKey;
    modelInfo = fromProvider.modelInfo;
  } else if (options.model?.model?.trim()) {
    // Explicit CLI override: the flags are authoritative and the on-disk models.json is
    // skipped — same isolation as the TUI's `--model` startup.
    const { connection } = await resolveModelConfig({
      model: options.model.model,
      style: options.model.style,
      baseURL: options.model.baseURL,
      apiKey: options.model.apiKey,
    });
    provider = createDirectModelProvider({
      model: connection.model,
      style: connection.style,
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
    });
    registerModelProvider(provider);
    model = connection.model;
    style = connection.style;
    baseURL = connection.baseURL;
    apiKey = connection.apiKey;
    models = singleModelRead({
      model: connection.model,
      style: connection.style,
      baseURL: connection.baseURL,
      apiKey: connection.apiKey,
    });
    modelsDefaultEntryIndex = 0;
  } else {
    try {
      const loaded = await loadModels({ kind: "file", env });
      if (loaded) {
        const entry = loaded.entries[loaded.active.entryIndex];
        const activeModel = loaded.active.model ?? entry?.models[0] ?? "";
        if (entry && activeModel) {
          await registerModelProviderForEntry(loaded);
          provider = getModelProvider();
          const fromProvider = await resolveModelConfigFromProvider({}, provider);
          model = fromProvider.connection.model;
          style = fromProvider.connection.style;
          baseURL = fromProvider.connection.baseURL;
          apiKey = fromProvider.connection.apiKey;
          modelInfo = fromProvider.modelInfo;
          models = catalogOf(loaded);
          modelsDefaultEntryIndex = loaded.active.entryIndex;
        }
      }
    } catch {
      // Corrupt/unreadable models.json — fall back to `.env`.
    }

    if (!model) {
      const { connection } = await resolveModelConfig({
        model: process.env.MODEL ?? process.env.model ?? "",
        style: parseModelStyle(process.env.MODEL_STYLE ?? process.env.STYLE),
        baseURL: process.env.BASE_URL ?? process.env.MODEL_BASE_URL,
        apiKey: process.env.API_KEY ?? "",
      });
      if (connection.model?.trim()) {
        provider = createDirectModelProvider({
          model: connection.model,
          style: connection.style,
          baseURL: connection.baseURL,
          apiKey: connection.apiKey,
        });
        registerModelProvider(provider);
        model = connection.model;
        style = connection.style;
        baseURL = connection.baseURL;
        apiKey = connection.apiKey;
        modelInfo = undefined;
        models = singleModelRead({
          model: connection.model,
          style: connection.style,
          baseURL: connection.baseURL,
          apiKey: connection.apiKey,
        });
        // Same single entry as the flag plane: record it, or a session can only first-match a
        // duplicated model id when it advertises the selector.
        modelsDefaultEntryIndex = 0;
      }
    }
  }

  if (!model?.trim()) {
    throw new Error(
      "ACP host requires a model — pass --model (with --base-url / --api-key), set `.agents/config/models.json`, or set MODEL/BASE_URL/API_KEY in .env."
    );
  }

  const agent = await CodentAgent.create({
    env,
    ...(provider ? { provider } : {}),
    ...(models ? { models } : {}),
    ownsEnv: true,
  });

  // One runtime per session. Without `--client-env` it is still needed when the session's `cwd`
  // differs from the process default: ACP's `cwd` is the session workspace root, so its `.agents`,
  // relative paths and tools must be rooted there. The default root reuses the boot runtime, so a
  // client that never sends another `cwd` pays nothing.
  const createSessionHost = async (context: AcpClientEnvFactoryContext): Promise<AcpSessionRuntime> => {
    const isDefaultRoot = context.rootPath === rootPath;

    // ACP's `cwd` is a real directory. Refuse an unusable one here, before any session or env is
    // created: a root that does not exist would otherwise produce a session whose every read
    // fails later (and whose instruction loader silently reports "no docs").
    if (!isDefaultRoot) {
      let info;
      try {
        info = await statPath(context.rootPath);
      } catch {
        throw RequestError.invalidParams(undefined, `cwd is not an accessible directory: ${context.rootPath}`);
      }
      if (!info.isDirectory()) {
        throw RequestError.invalidParams(undefined, `cwd is not a directory: ${context.rootPath}`);
      }
    }

    // No per-session env needed: the default root and no client-backed fs.
    if (!options.clientEnv && isDefaultRoot) return { host: agent.host, dispose: async () => undefined };

    // A non-default root needs its own runtime even without `--client-env`. Build it first so
    // `getEnv()` gives us the resolved fallback the client-backed env (when enabled) borrows.
    const localAgent =
      options.clientEnv && isDefaultRoot
        ? undefined
        : await CodentAgent.create({
            env: createNodeEnv({ rootPath: context.rootPath, sandbox: sandboxMode !== "native" }),
            ...(provider ? { provider } : {}),
            ...(models ? { models } : {}),
            ownsEnv: true,
          });

    if (!options.clientEnv) {
      // `localAgent` is defined here: the default-root case returned above.
      return {
        host: localAgent!.host,
        dispose: () => localAgent!.dispose(),
      };
    }

    const caps = {
      readTextFile: Boolean(context.clientCapabilities?.fs?.readTextFile),
      writeTextFile: Boolean(context.clientCapabilities?.fs?.writeTextFile),
      terminal: Boolean(context.clientCapabilities?.terminal),
    };
    // The capability matrix and every fallback decision are logged (no values, just the shape):
    // a tool route that looks wrong is nearly always a capability the client never declared.
    process.stderr.write(
      `[codent-acp] client-env capabilities: ` +
        `readTextFile=${caps.readTextFile} writeTextFile=${caps.writeTextFile} terminal=${caps.terminal}\n`
    );
    const fallback = localAgent ? localAgent.getEnv() : agent.getEnv();
    const clientEnv = createAcpClientEnv({
      client: context.client,
      sessionId: context.sessionId,
      // The SESSION root, not the process default: `.agents/**` and out-of-workspace routing are
      // judged against the workspace this session actually serves.
      rootPath: context.rootPath,
      // The session's local env (the boot env for the default root), already resolved (`getEnv()`
      // applies the defaults), so the client-backed env inherits this process's fs/path/exec
      // behaviour for everything it does not delegate.
      fallback,
      caps,
      log: (message) => process.stderr.write(`[codent-acp] ${message}\n`),
    });
    const sessionAgent = await CodentAgent.create({
      env: clientEnv,
      ...(provider ? { provider } : {}),
      ...(models ? { models } : {}),
      // The client-backed env borrows its fallback: disposing this runtime must not tear down an
      // env another session (or the boot runtime) still depends on. `localAgent` is ours.
      ownsEnv: false,
    });
    return {
      host: sessionAgent.host,
      dispose: async () => {
        await sessionAgent.dispose();
        if (localAgent) await localAgent.dispose();
      },
      // Surfaced so the approval policy can ask this env the only question that matters:
      // would a write to this path actually leave the process?
      clientEnv,
    };
  };

  // `session/list` for a root other than the default. A list request has no session, so there is
  // no per-session runtime to borrow: build a short-lived one over that root and release it.
  const listPersistedSessionsAt = agent.host.listPersistedSessions
    ? async (root: string): Promise<SessionMeta[]> => {
        if (root === rootPath) return (await agent.host.listPersistedSessions?.()) ?? [];
        const rootEnv = createNodeEnv({ rootPath: root, sandbox: sandboxMode !== "native" });
        const rootAgent = await CodentAgent.create({
          env: rootEnv,
          ...(provider ? { provider } : {}),
          ...(models ? { models } : {}),
          ownsEnv: true,
        });
        try {
          return (await rootAgent.host.listPersistedSessions?.()) ?? [];
        } finally {
          await rootAgent.dispose();
        }
      }
    : undefined;

  return {
    host: agent.host,
    rootPath,
    // Read back from the runtime: the ONE source, not the local variable that fed it.
    ...(agent.readModels() ? { models: agent.readModels()! } : {}),
    ...(modelsDefaultEntryIndex !== undefined ? { modelsDefaultEntryIndex } : {}),
    createSessionHost,
    ...(listPersistedSessionsAt ? { listPersistedSessionsAt } : {}),
    defaults: {
      model,
      ...(style ? { modelStyle: style } : {}),
      ...(baseURL ? { modelBaseURL: baseURL } : {}),
      ...(apiKey ? { modelApiKey: apiKey } : {}),
      ...(modelInfo ? { modelInfo } : {}),
      systemPrompt: await buildDefaultSystemPrompt(),
    },
  };
}

/** Build the full option set by bootstrapping locally. */
export async function bootstrapAcpAgent(
  options: {
    cwd?: string;
    sandbox?: "local" | "native";
    version?: string;
    model?: AcpModelOverride;
    /** `--client-env`: borrow the client's fs/terminal for each session. */
    clientEnv?: boolean;
  } = {}
): Promise<AcpAgentOptions> {
  const boot = await bootstrapLocalAcp(options);
  return {
    host: boot.host,
    defaults: boot.defaults,
    rootPath: boot.rootPath,
    ...(boot.models ? { models: boot.models } : {}),
    ...(boot.modelsDefaultEntryIndex !== undefined ? { modelsDefaultEntryIndex: boot.modelsDefaultEntryIndex } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(boot.createSessionHost ? { createSessionHost: boot.createSessionHost } : {}),
    ...(boot.listPersistedSessionsAt ? { listPersistedSessionsAt: boot.listPersistedSessionsAt } : {}),
  };
}
