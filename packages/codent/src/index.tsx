#!/usr/bin/env node
/**
 * `codent-cli` — self-contained release host entry.
 *
 * Thin shell over {@link bootstrapCliHost}. The shared host logic (TUI, args,
 * ACP intercept, provider/env planes) lives in `@codent/cli`'s server-free
 * `host` entry; this file only supplies the release identity. No
 * `@codent/server/client` factories are injected, so the remote env/session
 * planes are unavailable here (with a clear error) while `--remote-provider`
 * still works — `createRemoteProvider` lives in core, global fetch only.
 *
 * Default `NODE_ENV` to `production` BEFORE the host loads. The renderer
 * (`@my-react/react`, `@my-react/react-terminal`) chooses its development or
 * production build at module-load time by reading `process.env.NODE_ENV`, and an
 * ESM module body only runs after all of its static imports have been evaluated
 * — so a static `import { bootstrapCliHost } from "@codent/cli/host"` would
 * already have pulled the development build in. That is why the host is loaded
 * dynamically, once the default is in place. A `.env` entry cannot do this job
 * either: `bootstrapCliHost` loads it with dotenv (which never overrides a value
 * that is already set) long after the renderer resolved. This is a default, not
 * an override — an explicit `NODE_ENV` in the calling shell still wins (an
 * empty value counts as unset).
 */
process.env.NODE_ENV ||= "production";

const { bootstrapCliHost } = await import("@codent/cli/host");

await bootstrapCliHost({
  productName: "codent",
});

export {};
