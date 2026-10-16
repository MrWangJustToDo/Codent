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
 */
import { bootstrapCliHost } from "@codent/cli/host";

await bootstrapCliHost({
  productName: "codent",
});
