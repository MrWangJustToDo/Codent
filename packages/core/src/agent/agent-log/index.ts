// Types
export type { LogLevel, LogCategory, LogEntry } from "./types.js";

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
