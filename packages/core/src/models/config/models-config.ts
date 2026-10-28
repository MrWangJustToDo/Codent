/**
 * Unified model configuration — the single source of truth for LLM settings.
 *
 * A `models.json` file lives at `.agents/config/models.json` and has
 * two sections:
 * - `global`: runtime-wide settings. Today that is `toolConfig` only (websearch secrets and the
 *   preferred provider), applied when a file-backed host creates an agent. Runtime knobs such as
 *   `maxIterations` / `mcpConfigPath` / `systemPrompt` are NOT read from this file — they belong to
 *   the CLI/env plane (`--max-iterations` / `--mcp-config` / `--system`, `MAX_ITERATIONS`, …).
 *   They used to be declared here and were silently ignored; they are gone from the schema so a
 *   user cannot write a setting that does nothing. Pure environment / server items (SERVER_PORT,
 *   ROOT_PATH, ...) stay in `.env`.
 * - `models[]`: a list of provider entries. Two kinds:
 *   - `direct`      — local keys + baseURL + optional `models[]` id list
 *   - `remote-provider` — a single server URL that holds keys / proxies traffic
 *
 * Local and remote hosts resolve this through ONE pipeline
 * ({@link resolveModelsConfig}): the only difference is where the raw config is
 * read from — a local file vs the server's `GET /api/provider/info`. The result
 * is loaded into memory ({@link loadModels}) and used to initialize the session.
 */

import { z } from "zod";

import { getEnv, resolveCoreEnv } from "../../env";
import { registerModelProvider } from "../../provider/model-provider-registry.js";
import { createDirectModelProvider } from "../../provider/model-provider.js";
import {
  createRemoteProvider,
  fetchProviderInfo,
  REMOTE_PROVIDER_API_KEY,
  serverAdvertisedModels,
} from "../../provider/remote-model-provider.js";
import { writeFileAtomic } from "../../utils/atomic-write.js";
import { AGENT_DATA_DIR } from "../../utils/workspace-paths.js";

import { selectModel } from "./model-selection.js";

import type { CoreEnv, ResolvedCoreEnv } from "../../env";
import type { ModelInfo, ModelStyle } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

export const MODELS_CONFIG_DIR = `${AGENT_DATA_DIR}/config`;
export const MODELS_CONFIG_FILE = "models.json";

// ============================================================================
// Zod schema
// ============================================================================

const modelStyleSchema = z.enum(["openai", "anthropic"]);

const globalSchema = z.object({
  toolConfig: z
    .object({
      braveApiKey: z.string().optional(),
      exaApiKey: z.string().optional(),
      parallelApiKey: z.string().optional(),
      tavilyApiKey: z.string().optional(),
      provider: z.string().optional(),
      /** Legacy name for `provider`; read for backward compatibility, rewritten as `provider`. */
      websearchProvider: z.string().optional(),
    })
    .optional(),
});

const directEntrySchema = z.object({
  type: z.literal("direct"),
  style: modelStyleSchema,
  baseURL: z.string().min(1),
  apiKey: z.string().optional(),
  models: z.array(z.string().min(1)).optional(),
});

const remoteProviderEntrySchema = z.object({
  type: z.literal("remote-provider"),
  url: z.string().min(1),
});

const modelsConfigSchema = z.object({
  global: globalSchema.optional(),
  models: z.array(z.union([directEntrySchema, remoteProviderEntrySchema])).min(1),
  active: z
    .object({
      entryIndex: z.number().int().nonnegative(),
      model: z.string().optional(),
    })
    .optional(),
});

// ============================================================================
// Types
// ============================================================================

export interface ModelsConfigGlobal {
  /**
   * Websearch secrets / preference, applied to the agent's `AgentToolConfig` at creation.
   * `provider` is the preferred provider name; `websearchProvider` is the legacy spelling
   * and is mapped onto `provider` on read (see {@link normalizeGlobalToolConfig}).
   *
   * Two hosts read it, and both merge it UNDER their own env-derived value with one shared helper
   * (`mergeModelsConfigToolConfig` over `websearchToolConfigFromEnv`, `agent/tools/tool-config.ts`):
   * the TUI config load (`packages/app/src/hooks/use-config.ts`) and `codent acp`
   * (`packages/acp/src/bootstrap.ts`). The env spelling is the same list in both hosts
   * (`BRAVE_API_KEY` / `EXA_API_KEY` / `PARALLEL_API_KEY` / `TAVILY_API_KEY` /
   * `WEBSEARCH_PROVIDER`); a per-host copy is how a key that worked in one stayed dead in the other.
   * The remote-session server deliberately does not read this block — its sessions are configured
   * by the create request body (or its own `.env`) — and it strips the block from
   * `/api/provider/info` because it holds secrets.
   */
  toolConfig?: {
    braveApiKey?: string;
    exaApiKey?: string;
    parallelApiKey?: string;
    tavilyApiKey?: string;
    provider?: string;
    /** @deprecated use `provider` */
    websearchProvider?: string;
  };
}

export interface DirectModelsConfigEntry {
  type: "direct";
  style: ModelStyle;
  baseURL: string;
  apiKey?: string;
  models?: string[];
}

export interface RemoteProviderConfigEntry {
  type: "remote-provider";
  url: string;
}

export type ModelsConfigEntry = DirectModelsConfigEntry | RemoteProviderConfigEntry;

export interface ModelsConfigActive {
  /** Index into `models[]` of the last-used entry. */
  entryIndex: number;
  /**
   * Last-selected model id within that entry.
   *
   * Written by the config editor's save path only. `/models` updates the in-memory selection (and
   * the SESSION's persisted `model`) without rewriting this file, so after a restart a NEW session
   * starts from the file's last save rather than the last `/models` choice. That is the current
   * behaviour; persisting the selection would need a new writer.
   */
  model?: string;
}

export interface ModelsConfig {
  global?: ModelsConfigGlobal;
  models: ModelsConfigEntry[];
  active?: ModelsConfigActive;
}

/** Loaded, validated config — the in-memory source for model resolution. */
export interface ModelsConfigSource {
  kind: "file" | "provider" | "session";
  /** File mode: `.agents/config/models.json` under this root (default: CoreEnv rootPath). */
  rootPath?: string;
  /**
   * File mode: the owning runtime's env. Ambient only when omitted (the single-runtime host
   * compatibility seam); a server hosting several workspaces must pass it.
   */
  env?: CoreEnv;
  /** Provider mode: provider-proxy base URL exposing `GET /api/provider/info`.
   *  Session mode: agent-server base URL exposing `GET /api/agent/models`. */
  serverUrl?: string;
}

/** A single resolved, selectable provider entry in memory. */
export interface LoadedModelEntry {
  /**
   * - `direct`  — client-side connection (style + baseURL + apiKey in the host process).
   * - `remote`  — routes through a remote-provider proxy (`/api/provider/*`).
   * - `session` — resolved by the hosting Agent-Session server (remote-session
   *   plane): the list is served by `GET /api/agent/models` and `model.set`
   *   carries no baseURL/apiKey — the server resolves the connection itself.
   */
  type: "direct" | "remote" | "session";
  style: ModelStyle;
  baseURL: string;
  apiKey?: string;
  /** Selectable model ids (direct: `entry.models`; remote: server's list). */
  models: string[];
  /**
   * Remote entries only: the model the provider server serves (its `/api/provider/info`
   * `model`). It is the FALLBACK for a selection the entry does not offer — the client picks
   * from {@link LoadedModelEntry.models} and `selectModel` drops a pick outside it — so
   * {@link loadModels} reports `active.model` as the selection when it is selectable and as
   * this model otherwise. Absent when the server declares none.
   */
  servedModel?: string;
}

/** Fully-loaded models config: schema + per-entry connection + active selection. */
export interface LoadedModelsState {
  config: ModelsConfig;
  entries: LoadedModelEntry[];
  active: ModelsConfigActive;
}

// ============================================================================
// Parse / validate
// ============================================================================

export function parseModelsConfig(raw: string): ModelsConfig {
  return normalizeGlobalToolConfig(validateModelsConfig(JSON.parse(raw)));
}

/**
 * Map the legacy `global.toolConfig.websearchProvider` spelling onto `provider`.
 *
 * The key was renamed to match the runtime `WebsearchToolConfig.provider`, but existing
 * `models.json` files still carry the old name; reading it here means a file written
 * before the rename keeps working, and the next save emits `provider` only. Returns a new
 * object — the input is not mutated.
 */
export function normalizeGlobalToolConfig(config: ModelsConfig): ModelsConfig {
  const toolConfig = config.global?.toolConfig;
  if (!toolConfig?.websearchProvider) return config;
  const { websearchProvider, ...rest } = toolConfig;
  return {
    ...config,
    global: { ...config.global, toolConfig: { ...rest, provider: rest.provider ?? websearchProvider } },
  };
}

/**
 * Same rename as {@link normalizeGlobalToolConfig}, for a **raw** (unvalidated) `global`
 * block. The write path carries `global` across by reference to preserve unknown keys, so it
 * must normalize explicitly or a legacy `websearchProvider` survives every save. Returns a
 * new object when it renames; the input is not mutated.
 */
export function normalizeRawGlobalToolConfig(global: unknown): unknown {
  if (!global || typeof global !== "object" || Array.isArray(global)) return global;
  const block = global as Record<string, unknown>;
  const toolConfig = block.toolConfig;
  if (!toolConfig || typeof toolConfig !== "object" || Array.isArray(toolConfig)) return global;
  const tc = toolConfig as Record<string, unknown>;
  if (tc.websearchProvider === undefined) return global;
  const { websearchProvider, ...rest } = tc;
  const provider = rest.provider ?? websearchProvider;
  return { ...block, toolConfig: { ...rest, ...(provider !== undefined ? { provider } : {}) } };
}

/**
 * Validate an already-parsed document. Unknown keys are stripped — see
 * {@link RawModelsConfig} for why that matters to writers.
 */
function validateModelsConfig(data: unknown): ModelsConfig {
  const parsed = modelsConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid models.json: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data as ModelsConfig;
}

// ============================================================================
// Raw file access (round-trip preserving)
// ============================================================================

/**
 * The on-disk document before validation: the known shape plus **every key the
 * schema does not know about** (`$schema`, a hand-written `headers` on an entry,
 * a `global` setting a newer build reads, …).
 *
 * `parseModelsConfig` strips unknown keys — zod objects drop what they do not
 * declare — which is right for *reading* a config (nothing downstream can use an
 * undeclared field) and destructive for *writing* one: a writer that validated
 * first would silently delete everything it cannot represent. Cast to
 * {@link ModelsConfig} to read the known fields typed; never hand a raw document
 * to `saveModelsConfig` by accident — a round trip is what preserves the rest.
 */
export type RawModelsConfig = ModelsConfig & Record<string, unknown>;

function modelsConfigPaths(
  rootPath?: string,
  env?: CoreEnv
): { env: ResolvedCoreEnv; dir: string; configPath: string } {
  // Injected env wins; the ambient registry is the compatibility seam for hosts that call this
  // without a runtime in scope (single-runtime CLI). Under a server hosting several workspaces the
  // ambient read/write would target whichever root was registered last — a credentials-bearing
  // file, so the runtime must pass its own env.
  const resolved = env ? resolveCoreEnv(env) : getEnv();
  const base = rootPath ?? resolved.rootPath;
  const dir = resolved.path.join(base, MODELS_CONFIG_DIR);
  return { env: resolved, dir, configPath: resolved.path.join(dir, MODELS_CONFIG_FILE) };
}

/**
 * Read `.agents/config/models.json` without validating or stripping it.
 *
 * Returns the parsed JSON as-is (unknown keys included), or `null` when the file
 * does not exist. Throws on malformed JSON: callers deciding whether a config
 * exists want {@link loadModelsConfigFromFile}; callers about to rewrite the file
 * want this one, so what they did not touch survives.
 */
export async function readModelsConfigFile(rootPath?: string, env?: CoreEnv): Promise<RawModelsConfig | null> {
  const { env: resolved, configPath } = modelsConfigPaths(rootPath, env);
  const exists = await resolved.fs.exists(configPath);
  if (!exists) return null;
  return JSON.parse(await resolved.fs.readFile(configPath)) as RawModelsConfig;
}

/**
 * Write a document to `.agents/config/models.json`.
 *
 * Takes `unknown` deliberately: the round-trip case must be allowed to write back
 * keys this package's types do not declare. Validation belongs to the producer
 * (`parseModelsConfig` for a draft), not to the writer.
 */
export async function writeModelsConfigFile(config: unknown, rootPath?: string, env?: CoreEnv): Promise<void> {
  const { env: resolved, dir, configPath } = modelsConfigPaths(rootPath, env);
  const dirExists = await resolved.fs.exists(dir);
  if (!dirExists) await resolved.fs.mkdir(dir);
  // Crash-safe: a torn write would leave invalid JSON, and the next launch would discard the
  // whole config (including every provider entry and the websearch toolConfig).
  await writeFileAtomic(resolved.fs, configPath, JSON.stringify(config, null, 2));
}

// ============================================================================
// File I/O (local mode)
// ============================================================================

export async function loadModelsConfigFromFile(rootPath?: string, env?: CoreEnv): Promise<ModelsConfig | null> {
  const raw = await readModelsConfigFile(rootPath, env);
  if (raw === null) return null;
  return normalizeGlobalToolConfig(validateModelsConfig(raw));
}

/**
 * Persist a **validated** config.
 *
 * Writes exactly what it is given, so a caller that took a validated document
 * through a round trip must have used {@link readModelsConfigFile} rather than
 * {@link loadModelsConfigFromFile} — otherwise unknown keys were already stripped
 * before this saw them. Rewriting callers should prefer
 * {@link writeModelsConfigFile} with a round-tripped raw document.
 */
export async function saveModelsConfig(config: ModelsConfig, rootPath?: string, env?: CoreEnv): Promise<void> {
  await writeModelsConfigFile(config, rootPath, env);
}

// ============================================================================
// Remote provider info (server mode)
// ============================================================================

export async function resolveModelsConfigFromProvider(serverUrl: string): Promise<ModelsConfig> {
  const info = await fetchProviderInfo(serverUrl);
  // A provider source ALWAYS routes through the server proxy: keys stay on the
  // server and the client must never talk to an upstream directly. Collapsing
  // the server's config (if any) into one remote-provider entry is what keeps
  // `registerModelProviderForEntry` registering a remote-mode provider —
  // returning the server's raw direct entries would leak its apiKey to the
  // client and bypass the proxy (empty streams when the client's network
  // cannot reach the upstream). loadModelEntries expands this entry into the
  // selectable list (union of the server's direct-entry models + its env
  // model) via /api/provider/info.
  return {
    models: [{ type: "remote-provider", url: serverUrl.replace(/\/+$/, "") }],
    active: {
      entryIndex: 0,
      // Fallback only: `loadModels` overrides this with the model the provider serves
      // (`LoadedModelEntry.servedModel`) whenever the server declares one, because that
      // is the model every proxied request carries. Kept for a server that names none.
      ...(info.config?.active?.model ? { model: info.config.active.model } : {}),
    },
  };
}

// ============================================================================
// Remote session models (agent-session plane)
// ============================================================================

/** `GET /api/agent/models` shape served by the Agent-Session plane (sanitized). */
interface AgentModelsResponse {
  entries: { style: ModelStyle; models: string[] }[];
  active?: ModelsConfigActive;
}

async function fetchAgentModels(serverUrl: string): Promise<AgentModelsResponse> {
  const baseUrl = serverUrl.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/api/agent/models`);
  if (!res.ok) {
    throw new Error(`Agent-session server unavailable at ${baseUrl}/api/agent/models (HTTP ${res.status}).`);
  }
  return (await res.json()) as AgentModelsResponse;
}

// ============================================================================
// Unified resolve
// ============================================================================

/**
 * Resolve the models config through one pipeline. Local and remote only differ
 * in where the raw config comes from — both produce the same {@link ModelsConfig}.
 *
 * @returns the config, or `null` when a local file mode config does not exist.
 */
export async function resolveModelsConfig(source: ModelsConfigSource): Promise<ModelsConfig | null> {
  if (source.kind === "provider" && source.serverUrl) {
    return resolveModelsConfigFromProvider(source.serverUrl);
  }
  return loadModelsConfigFromFile(source.rootPath, source.env);
}

// ============================================================================
// Load into memory
// ============================================================================

export async function loadModelEntries(config: ModelsConfig): Promise<LoadedModelEntry[]> {
  const entries: LoadedModelEntry[] = [];
  for (const entry of config.models) {
    if (entry.type === "direct") {
      entries.push({
        type: "direct",
        style: entry.style,
        baseURL: entry.baseURL,
        apiKey: entry.apiKey,
        models: entry.models ?? [],
      });
      continue;
    }
    // remote-provider: ask the server for its connection + selectable list. The allowlist is the
    // shared `serverAdvertisedModels` — its ids ∪ its recorded `active.model` ∪ the served model —
    // so this list and bootstrap's `selectModel` cannot disagree about what the proxy accepts.
    const info = await fetchProviderInfo(entry.url);
    const baseUrl = entry.url.replace(/\/+$/, "");
    const remoteModels = [...serverAdvertisedModels(info)];
    entries.push({
      type: "remote",
      style: info.style,
      baseURL: `${baseUrl}${info.basePath}`,
      apiKey: REMOTE_PROVIDER_API_KEY,
      models: remoteModels,
      ...(info.model ? { servedModel: info.model } : {}),
    });
  }
  return entries;
}

/**
 * Resolve + validate + load into memory, picking the active entry/model.
 *
 * One pipeline for all hosts — only the source differs:
 * - `file`     — local `.agents/config/models.json`.
 * - `provider` — remote-provider proxy (`GET /api/provider/info`); entries carry
 *   the proxy baseURL + sentinel key because the CLIENT builds the adapter.
 * - `session`  — remote agent-session server (`GET /api/agent/models`, sanitized).
 *   Entries carry NO connection: the agent runs server-side and `model.set`
 *   resolves credentials there. Callers must not register a ModelProvider for
 *   session entries and must not write them into `config.model` mid-session.
 */
export async function loadModels(source: ModelsConfigSource): Promise<LoadedModelsState | null> {
  if (source.kind === "session" && source.serverUrl) {
    const data = await fetchAgentModels(source.serverUrl);
    const entries: LoadedModelEntry[] = data.entries.map((e) => ({
      type: "session" as const,
      style: e.style,
      baseURL: "",
      models: e.models,
    }));
    if (entries.length === 0) return null;
    const active: ModelsConfigActive =
      data.active && data.active.entryIndex < entries.length ? data.active : { entryIndex: 0 };
    return { config: { models: [], active }, entries, active };
  }
  const config = await resolveModelsConfig(source);
  if (!config) return null;
  const entries = await loadModelEntries(config);
  let active: ModelsConfigActive = config.active ?? { entryIndex: 0 };
  // A hand-edited / stale file can point past the entry list (a deleted entry). The schema has no
  // upper bound, and `registerModelProviderForEntry` throws `No model entry at index N` — which a
  // host's single `catch {}` then turned into "discard the whole config". Heal to the first entry.
  if (!Number.isInteger(active.entryIndex) || active.entryIndex < 0 || active.entryIndex >= entries.length) {
    active = { ...active, entryIndex: 0 };
  }
  // The recorded selection is the client's choice, so it stands — unless the entry does not offer
  // it. Then the entry's served model is what a request will carry (`selectModel` applies the same
  // rule on the wire), and reporting the un-offered id would make the host display (footer / help)
  // and the `/models` "(current)" marker name a model this client never sends.
  const activeEntry = entries[active.entryIndex];
  if (activeEntry) {
    const selection = selectModel({
      requested: active.model,
      fallback: activeEntry.servedModel,
      allowed: activeEntry.models,
    });
    if (selection.model && selection.model !== active.model) active = { ...active, model: selection.model };
  }
  return { config, entries, active };
}

/**
 * Every model id the runtime's catalog advertises, or `undefined` when it advertises none.
 *
 * This is the allowlist a *session* checks a model against when it adopts a selection it did not
 * make itself (a resumed session's persisted model — see `ManagedAgent.applyPersistedModel`).
 * The union across entries is deliberate: the catalog says which ids this runtime can run, and
 * which entry serves the running one is the session's separate decision.
 */
export function selectableModelIds(
  catalog: { entries: readonly Pick<LoadedModelEntry, "models">[] } | null | undefined
): readonly string[] | undefined {
  if (!catalog) return undefined;
  const ids = new Set<string>();
  for (const entry of catalog.entries) for (const id of entry.models) if (id) ids.add(id);
  return ids.size > 0 ? [...ids] : undefined;
}

// ============================================================================
// Provider registration for an entry
// ============================================================================

/**
 * Register the model provider that corresponds to the active entry so agent
 * creation resolves models through it. Re-registering the module-level provider
 * at runtime is supported, which is what makes mid-session entry switches work.
 */
export async function registerModelProviderForEntry(state: LoadedModelsState): Promise<ModelStyle> {
  const entry = state.entries[state.active.entryIndex];
  if (!entry) throw new Error(`No model entry at index ${state.active.entryIndex}`);
  const configEntry = state.config.models[state.active.entryIndex];
  const activeModel = state.active.model ?? entry.models[0] ?? "";

  if (entry.type === "remote") {
    const url = configEntry?.type === "remote-provider" ? configEntry.url : "";
    registerModelProvider(await createRemoteProvider(url));
    return entry.style;
  }

  registerModelProvider(
    createDirectModelProvider({
      model: activeModel,
      style: entry.style,
      baseURL: entry.baseURL,
      apiKey: entry.apiKey,
    })
  );
  return entry.style;
}

/** Resolve modelInfo for a model id (via models.dev) — used by `/models` switching. */
export async function resolveModelInfoFromModelsDev(
  modelId: string,
  style?: ModelStyle
): Promise<ModelInfo | undefined> {
  const { lookupModelFromModelsDev } = await import("../../provider/models-dev/lookup.js");
  return lookupModelFromModelsDev(modelId, style);
}
