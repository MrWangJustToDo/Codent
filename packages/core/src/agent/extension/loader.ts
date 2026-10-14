/**
 * ExtensionLoader — discover and load extensions from factories and filesystem dirs.
 */

import { getEnv, type ResolvedCoreEnv } from "../../env";
import { toError } from "../../utils/errors.js";

import { isExtensionModuleFile, pathToFileUrl, resolveExtensionDir } from "./paths.js";

import type { ExtensionAPI, ExtensionFactory } from "./types.js";

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
}

export interface ExtensionLoadResult {
  loaded: ExtensionAPI[];
  errors: Error[];
}

export interface DiscoveredExtensionFile {
  id: string;
  absPath: string;
}

/**
 * Normalize a module's default export into an {@link ExtensionAPI}.
 * Supports ExtensionAPI objects, ExtensionFactory, or `activate(ctx)` functions.
 */
export async function normalizeExtensionExport(moduleExport: unknown, fallbackId: string): Promise<ExtensionAPI> {
  const raw =
    moduleExport && typeof moduleExport === "object" && "default" in moduleExport
      ? (moduleExport as { default: unknown }).default
      : moduleExport;

  if (raw && typeof raw === "object" && typeof (raw as ExtensionFactory).create === "function") {
    return (raw as ExtensionFactory).create();
  }

  if (raw && typeof raw === "object" && typeof (raw as ExtensionAPI).activate === "function") {
    const api = raw as ExtensionAPI;
    return {
      ...api,
      id: api.id || fallbackId,
      name: api.name || fallbackId,
      version: api.version || "0.0.0",
      description: api.description || "",
    };
  }

  if (typeof raw === "function") {
    const activateFn = raw as (ctx: unknown) => unknown;
    return {
      id: fallbackId,
      name: fallbackId,
      version: "0.0.0",
      description: "",
      activate: async (ctx) => {
        await activateFn(ctx);
      },
    };
  }

  throw new Error(
    `Extension "${fallbackId}" default export must be an ExtensionAPI, ExtensionFactory, or activate function`
  );
}

export class ExtensionLoader {
  private factories = new Map<string, ExtensionFactory>();

  /** Owning runtime's env, so discovery reads the runtime root. Ambient when omitted. */
  constructor(private readonly env?: ResolvedCoreEnv) {}

  registerFactory(id: string, factory: ExtensionFactory): void {
    this.factories.set(id, factory);
  }

  hasFactory(id: string): boolean {
    return this.factories.has(id);
  }

  async loadFromFactories(ids: string[]): Promise<ExtensionLoadResult> {
    const loaded: ExtensionAPI[] = [];
    const errors: Error[] = [];

    for (const id of ids) {
      const factory = this.factories.get(id);
      if (!factory) {
        errors.push(new Error(`Extension factory not found: ${id}`));
        continue;
      }

      try {
        const api = await factory.create();
        loaded.push(api);
      } catch (err) {
        const error = toError(err);
        errors.push(error);
      }
    }

    return { loaded, errors };
  }

  async loadFromConfigs(ids: string[]): Promise<ExtensionLoadResult> {
    const registeredIds: string[] = [];
    for (const id of ids) {
      if (this.factories.has(id)) {
        registeredIds.push(id);
      }
    }
    return this.loadFromFactories(registeredIds);
  }

  /**
   * List loadable extension files under the given directories (in order).
   * Missing or inaccessible directories (e.g. home path outside CoreEnv workspace) are skipped.
   */
  async discoverFiles(dirs: string[]): Promise<{ files: DiscoveredExtensionFile[]; errors: Error[] }> {
    const env = this.env ?? getEnv();
    const files: DiscoveredExtensionFile[] = [];
    const errors: Error[] = [];
    const seenIds = new Set<string>();

    for (const dir of dirs) {
      const absDir = resolveExtensionDir(dir, this.env);
      try {
        const exists = await env.fs.exists(absDir);
        if (!exists) continue;

        const stat = await env.fs.stat(absDir);
        if (!stat.isDirectory) continue;

        const entries = await env.fs.readdir(absDir);
        for (const entry of entries) {
          if (entry.type !== "file" || !isExtensionModuleFile(entry.name)) continue;

          const id = env.path.basename(entry.name, env.path.extname(entry.name));
          if (seenIds.has(id)) {
            // Later dirs override earlier discovery for the same id
            const idx = files.findIndex((f) => f.id === id);
            if (idx >= 0) files.splice(idx, 1);
          }
          seenIds.add(id);
          files.push({ id, absPath: env.path.join(absDir, entry.name) });
        }
      } catch (err) {
        const error = toError(err);
        errors.push(new Error(`Skip extension dir "${absDir}": ${error.message}`));
      }
    }

    return { files, errors };
  }

  /**
   * Dynamically import discovered files and normalize exports to {@link ExtensionAPI}.
   */
  async loadFromDirectories(dirs: string[]): Promise<ExtensionLoadResult> {
    const { files, errors: discoverErrors } = await this.discoverFiles(dirs);
    const loaded: ExtensionAPI[] = [];
    const errors = [...discoverErrors];

    for (const file of files) {
      try {
        if (file.absPath.toLowerCase().endsWith(".ts")) {
          // Node needs a TS loader (e.g. --import tsx). Fail with a clear message if missing.
        }
        const href = pathToFileUrl(file.absPath);
        const mod = await import(/* @vite-ignore */ href);
        const api = await normalizeExtensionExport(mod, file.id);
        loaded.push(api);
      } catch (err) {
        const error = toError(err);
        const hint = file.absPath.toLowerCase().endsWith(".ts")
          ? " (TypeScript extensions require a TS loader such as tsx: node --import tsx …)"
          : "";
        errors.push(new Error(`Failed to load extension "${file.id}" from ${file.absPath}: ${error.message}${hint}`));
      }
    }

    return { loaded, errors };
  }
}
