/**
 * The server's own `models.json` (`.agents/config/models.json`), read on demand.
 *
 * Two routes need it — `/api/provider/info` (advertise the process's provider entries) and
 * `POST /api/agent` (the provider catalog a remote-session client picks from) — and each carried
 * its own copy of "import core lazily, read the file, swallow the error". `@codent/core` stays a
 * DYNAMIC import so the CoreEnv-only entry does not pull the agent runtime (and its TanStack types)
 * into the published bundle.
 */
async function loadCore() {
  return import("@codent/core");
}

export async function loadServerModelsConfig(): Promise<import("@codent/core").ModelsConfig | null> {
  const { loadModelsConfigFromFile } = await loadCore();
  try {
    return await loadModelsConfigFromFile();
  } catch {
    return null;
  }
}
