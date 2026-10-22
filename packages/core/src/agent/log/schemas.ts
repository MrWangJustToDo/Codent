import { z } from "zod";

import { AGENT_PROFILE_IDS } from "../../runtime-types/agent-profile.js";

/**
 * Log **entry schemas** — the validation boundary of the log extension, not of the seam.
 *
 * These live in `agent/log/` (not `agent/agent-log/`, where they were written) because the only
 * runtime consumer is `jsonl-file-sink.ts`, which validates every entry before writing it — an
 * artefact of log *policy*, which the extension owns. Placing them here is what keeps the two log
 * domains one-directional at the value level:
 *
 * - `agent/log/` → `agent-log/`: **types only** (`LogEntry` et al.), so the edge is erased.
 * - `agent/agent-log/` → `agent/log/`: the sink and this schema, which is the direction the policy
 *   dependency already runs.
 *
 * While the schemas sat under `agent-log/`, `agent/log/` held two value edges into that domain
 * (`jsonl-file-sink → schemas`, `extension → lifecycle-guards`) against one value edge back
 * (`agent-log → jsonl-file-sink`) — a directory-level cycle, even though no module-level path ever
 * closed (the schema and type modules are leaves). The `agent-log/` barrel re-exports these so
 * existing consumers keep resolving; new code SHOULD import them from here.
 */

// ============================================================================
// Zod Schemas
// ============================================================================

const logLevels = ["debug", "info", "warn", "error"] as const;
export const logLevelSchema = z.enum(logLevels);

const logCategories = [
  "agent",
  "chat",
  "llm",
  "tool",
  "approval",
  "compaction",
  "todo",
  "skill",
  "memory",
  "hooks",
  "system",
  // Kept in sync with the `LogCategory` union in ./types.ts — the list is
  // declared twice, and a category missing here is rejected by
  // `logEntrySchema` at write time (the entry silently never lands).
  "side-query",
] as const;
export const logCategorySchema = z.enum(logCategories);

export const logEntrySchema = z.strictObject({
  scope: z.strictObject({
    profile: z.enum(AGENT_PROFILE_IDS),
    taskCallId: z.string().optional(),
  }),
  id: z.string(),
  timestamp: z.number(),
  level: logLevelSchema,
  category: logCategorySchema,
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z
    .strictObject({
      name: z.string(),
      message: z.string(),
      stack: z.string().optional(),
    })
    .optional(),
  tags: z.array(z.string()).optional(),
  run: z.string().optional(),
  event: z.string().optional(),
});
