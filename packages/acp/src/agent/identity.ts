/**
 * What this host calls itself.
 *
 * One constant, because the protocol reads it in three places that must agree: `agentInfo.name`,
 * the name prefix of every session this process creates, and the prefix of the synthetic message
 * ids a command/notice reply carries.
 */

export const AGENT_NAME = "codent";

/** Reported as `agentInfo.version` when the embedding host supplies none. */
export const DEFAULT_VERSION = "0.0.1";
