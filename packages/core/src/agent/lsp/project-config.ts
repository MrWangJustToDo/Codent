import type { LspManager, LspServerConfigRecord } from "./lsp-manager.js";
import type { ExtensionContext } from "../extension/types.js";

/** Project-level LSP config — loaded from `.lsp.json` in the workspace root. */
export interface ProjectLspConfig {
  autoStart?: string[];
  lombokJar?: string;
  servers?: Record<string, LspServerConfigRecord>;
  autoInjectDiagnostics?: boolean | string[];
}

/** Load `.lsp.json` from the project root (best-effort, never throws). */
export async function loadProjectConfig(ctx: ExtensionContext, manager: LspManager): Promise<ProjectLspConfig | null> {
  try {
    const configPath = ctx.coreEnv.path?.join(ctx.cwd, ".lsp.json") ?? `${ctx.cwd}/.lsp.json`;
    const content = await ctx.coreEnv.fs.readFile(configPath, "utf-8").catch(() => null);
    if (!content) return null;
    const parsed = JSON.parse(content as string) as ProjectLspConfig;
    if (typeof parsed !== "object" || parsed === null) return null;

    if (parsed.servers) {
      for (const [lang, conf] of Object.entries(parsed.servers)) {
        manager.setServerConfig(lang, {
          command: conf.command,
          args: conf.args ?? [],
          env: conf.env,
          initializationOptions: conf.initializationOptions,
          settings: conf.settings,
        });
      }
    }
    if (parsed.lombokJar && parsed.lombokJar !== "auto") {
      manager.setLombokJar(parsed.lombokJar);
    }
    return parsed;
  } catch {
    return null;
  }
}
