// Types
export type { LogLevel, LogCategory, LogEntry } from "./types.js";

// Schemas
// The entry schemas are the log extension's (they mirror the log policy it enforces), so they
// live in `agent/log/`. Re-exported here only for the barrel's existing consumers.
export { logLevelSchema, logCategorySchema, logEntrySchema } from "../log/schemas.js";

// AgentLog class
export { AgentLog, generateLogId, MAX_PENDING_LOG_ENTRIES } from "./agent-log.js";

// Crash/exit lifecycle guards (active-log registry + process handlers)
export {
  installAgentLogProcessGuards,
  registerActiveAgentLog,
  unregisterActiveAgentLog,
  flushActiveAgentLogsSync,
  registerExtensionExitFlush,
  flushExtensionExitFlushesSync,
} from "./lifecycle-guards.js";
