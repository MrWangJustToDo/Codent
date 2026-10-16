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

import {
  buildDefaultSystemPrompt,
  CodentAgent,
  createDirectModelProvider,
  createRemoteProvider,
  getModelProvider,
  loadModels,
  registerCoreEnv,
  registerModelProvider,
  registerModelProviderForEntry,
  resolveModelConfig,
  resolveModelConfigFromProvider,
} from "@codent/core";
import { createNodeEnv } from "@codent/node";

import { createAcpClientEnv } from "./client-env.js";
import { resolveRoot } from "./paths.js";

import type {
  AcpAgentDefaults,
  AcpAgentOptions,
  AcpModelCatalogEntry,
  AcpSessionRuntime,
  AcpClientEnvFactoryContext,
} from "./agent.js";
import type { AgentSessionHost, ModelProvider, ModelStyle } from "@codent/core";

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
  modelCatalog?: AcpModelCatalogEntry[];
  /**
   * The entry `modelCatalog`'s active model came from. Carried so a session's connection can be
   * attributed to the right entry when a model id appears in several of them.
   */
  modelCatalogActiveIndex?: number;
  /**
   * Present only under `--client-env`: builds the per-session runtime whose env borrows the
   * client's fs/terminal. Its presence is what turns the flag on in `createAcpAgent`.
   */
  createSessionHost?: (context: AcpClientEnvFactoryContext) => Promise<AcpSessionRuntime>;
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
  let modelCatalog: AcpModelCatalogEntry[] | undefined;
  /** The entry that model came from — a model id shared by several entries stays resolvable. */
  let modelCatalogActiveIndex: number | undefined;

  if (options.model?.remoteProvider) {
    // Remote provider plane: the server holds the keys and supplies the model,
    // so no explicit `--model` is needed. Mirrors the TUI's remote-provider
    // branch in the release host — CoreEnv stays local, only the provider is
    // remote. `createRemoteProvider` lives in core (global fetch only).
    const remoteProvider = await createRemoteProvider(options.model.remoteProvider);
    provider = remoteProvider;
    registerModelProvider(provider);
    const fromProvider = await resolveModelConfigFromProvider({}, provider);
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
  } else {
    try {
      const loaded = await loadModels({ kind: "file" });
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
          // The catalog is the reason this file was read: keep the whole list, not just the
          // active entry, so `session/new` can advertise the models the user may switch to.
          modelCatalog = loaded.entries.map((loadedEntry, index) => ({
            index,
            style: loadedEntry.style,
            baseURL: loadedEntry.baseURL,
            ...(loadedEntry.apiKey ? { apiKey: loadedEntry.apiKey } : {}),
            models: [...loadedEntry.models],
          }));
          modelCatalogActiveIndex = loaded.active.entryIndex;
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
      }
    }
  }

  if (!model?.trim()) {
    throw new Error(
      "ACP host requires a model — pass --model (with --base-url / --api-key), set `.agents/config/models.json`, or set MODEL/BASE_URL/API_KEY in .env."
    );
  }

  const agent = await CodentAgent.create({ env, ...(provider ? { provider } : {}), ownsEnv: true });

  // `--client-env`: one runtime per session, each over a client-backed env whose fallback is the
  // local env above (which the boot runtime keeps alive — a per-session env only borrows it, so it
  // must NOT be destroyed by `dispose`).
  const createSessionHost = options.clientEnv
    ? async (context: AcpClientEnvFactoryContext): Promise<AcpSessionRuntime> => {
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
        const clientEnv = createAcpClientEnv({
          client: context.client,
          sessionId: context.sessionId,
          rootPath,
          // The boot runtime's own env, already resolved (`getEnv()` applies the defaults), so the
          // per-session env inherits the exact fs/path/exec behaviour this process would have used.
          fallback: agent.getEnv(),
          caps,
          log: (message) => process.stderr.write(`[codent-acp] ${message}\n`),
        });
        const sessionAgent = await CodentAgent.create({
          env: clientEnv,
          ...(provider ? { provider } : {}),
          // Borrowed fallback env: disposing this runtime must not tear down the local env that
          // every other session's fallback still depends on.
          ownsEnv: false,
        });
        return {
          host: sessionAgent.host,
          dispose: () => sessionAgent.dispose(),
          // Surfaced so the approval policy can ask this env the only question that matters:
          // would a write to this path actually leave the process?
          clientEnv,
        };
      }
    : undefined;

  return {
    host: agent.host,
    rootPath,
    ...(modelCatalog ? { modelCatalog } : {}),
    ...(modelCatalogActiveIndex !== undefined ? { modelCatalogActiveIndex } : {}),
    ...(createSessionHost ? { createSessionHost } : {}),
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
    ...(boot.modelCatalog ? { modelCatalog: boot.modelCatalog } : {}),
    ...(boot.modelCatalogActiveIndex !== undefined ? { modelCatalogActiveIndex: boot.modelCatalogActiveIndex } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(boot.createSessionHost ? { createSessionHost: boot.createSessionHost } : {}),
  };
}
