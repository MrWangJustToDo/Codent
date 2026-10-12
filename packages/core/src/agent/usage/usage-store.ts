/**
 * usage-store.ts - Disk IO for the global usage history store.
 *
 * Every real LLM call (main loop, subagent runs, side queries) is appended as
 * one JSONL record to `.agents/usage/usage-<year>.jsonl`. The record locks in
 * the model id and the cost computed with that model's own pricing at call
 * time, so global aggregates stay correct across model switching and
 * capability-based subagent routing.
 *
 * Mirrors the SessionStore split: pure CoreEnv-backed IO, no agent state —
 * {@link UsageHistoryService} (managers/services) owns the write policy.
 */

import { getEnv, type ResolvedCoreEnv } from "../../env";
import { totalTokensOf } from "../../runtime-types/token-usage.js";

import type { TokenUsage } from "../../runtime-types/token-usage.js";

// ============================================================================
// Constants
// ============================================================================

/** Directory for global usage history: `.agents/usage/`. */
export const USAGE_DIR = ".agents/usage";
export const USAGE_FILE_PREFIX = "usage-";
export const USAGE_FILE_SUFFIX = ".jsonl";

/** Record format version (readers skip unknown versions). */
export const USAGE_RECORD_VERSION = 1;

// ============================================================================
// Types
// ============================================================================

/** One JSONL record = one actual LLM call with its own model + cost locked in. */
export interface UsageRecord {
  v: number;
  /** Epoch ms of the call completion. */
  ts: number;
  /** Local-timezone day key `YYYY-MM-DD` — the contribution-graph bucket. */
  date: string;
  /** Agent (managed) id that made the call. */
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** Input for recording one LLM call (tokens + optional precomputed cost). */
export interface UsageRecordInput {
  /** Owning agent id; side queries without an agent context default to "unknown". */
  agentId?: string;
  model?: string;
  usage: TokenUsage;
  /** Cost computed with the model's own pricing at call time (0 when unknown). */
  costUsd?: number;
  /** Completion timestamp; defaults to now. */
  ts?: number;
}

export interface DailyUsageBucket {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  calls: number;
}

export interface ModelUsageTotal {
  model: string;
  totalTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
}

export interface UsageHistoryResult {
  daily: DailyUsageBucket[];
  models: ModelUsageTotal[];
  /** Records skipped due to unknown version / malformed lines. */
  skipped: number;
}

// ============================================================================
// Paths + day keys
// ============================================================================

export function getUsageLogPath(year: number): string {
  return `${USAGE_DIR}/${USAGE_FILE_PREFIX}${year}${USAGE_FILE_SUFFIX}`;
}

/** Local-timezone `YYYY-MM-DD` day key for a timestamp. */
export function toDayKey(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function buildRecord(input: UsageRecordInput): Omit<UsageRecord, "v"> | null {
  const ts = input.ts ?? Date.now();
  const usage = input.usage;
  // Not `usage.totalTokens`: that field is written by every producer of a `TokenUsage`,
  // and the per-call ones build it as `input + output`, which drops the cached prompt.
  // Computing it here from the parts keeps the global graph on the same reading as the
  // session's own totals.
  const totalTokens = totalTokensOf(usage);
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null;
  return {
    ts,
    date: toDayKey(ts),
    agentId: input.agentId ?? "unknown",
    model: input.model ?? "unknown",
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    totalTokens,
    costUsd: Number.isFinite(input.costUsd) ? Math.max(0, input.costUsd!) : 0,
  };
}

// ============================================================================
// UsageStore
// ============================================================================

/**
 * Append-only JSONL store for global LLM usage records (`.agents/usage/`).
 * State-free like SessionStore — all durable state lives on disk.
 */
export class UsageStore {
  /** Workspace env this store persists through; resolved lazily (ambient) when omitted. */
  private readonly env?: ResolvedCoreEnv;

  constructor(env?: ResolvedCoreEnv) {
    this.env = env;
  }

  private get fs() {
    return (this.env ?? getEnv()).fs;
  }

  /**
   * Append one usage record. Returns false (no-op) when the env fs does not
   * implement appendFile, or when the record has no tokens to count.
   */
  async append(input: UsageRecordInput): Promise<boolean> {
    const record = buildRecord(input);
    if (!record) return false;
    const fs = this.fs;
    if (!fs.appendFile) return false;
    const path = getUsageLogPath(new Date(record.ts).getFullYear());
    if (!(await fs.exists(USAGE_DIR))) {
      await fs.mkdir(USAGE_DIR);
    }
    if (!(await fs.exists(path))) {
      await fs.writeFile(path, "");
    }
    const line: UsageRecord = { v: USAGE_RECORD_VERSION, ...record };
    await fs.appendFile(path, JSON.stringify(line) + "\n");
    return true;
  }

  /**
   * Read usage records for the last `weeks` weeks (ending today, local
   * timezone) and aggregate into per-day buckets + per-model totals.
   */
  async readHistory(weeks: number): Promise<UsageHistoryResult> {
    const fs = this.fs;
    const result: UsageHistoryResult = { daily: [], models: [], skipped: 0 };
    const files = await this.listLogFiles();
    if (files.length === 0) return result;

    const end = startOfToday();
    const since = end - weeks * 7 * 24 * 60 * 60 * 1000;

    const dailyMap = new Map<string, DailyUsageBucket>();
    const modelMap = new Map<string, ModelUsageTotal>();

    for (const name of files) {
      const path = `${USAGE_DIR}/${name}`;
      let content: string;
      try {
        content = await fs.readFile(path);
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let raw: Partial<UsageRecord>;
        try {
          raw = JSON.parse(trimmed) as Partial<UsageRecord>;
        } catch {
          result.skipped++;
          continue;
        }
        if (!raw || raw.v !== USAGE_RECORD_VERSION || typeof raw.ts !== "number") {
          result.skipped++;
          continue;
        }
        if (raw.ts < since || raw.ts > end + 24 * 60 * 60 * 1000) continue;

        const date = typeof raw.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : toDayKey(raw.ts);
        const totalTokens = raw.totalTokens ?? 0;
        const costUsd = raw.costUsd ?? 0;
        const model = raw.model ?? "unknown";

        let day = dailyMap.get(date);
        if (!day) {
          day = { date, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, calls: 0 };
          dailyMap.set(date, day);
        }
        day.inputTokens += raw.inputTokens ?? 0;
        day.outputTokens += raw.outputTokens ?? 0;
        day.totalTokens += totalTokens;
        day.costUsd += costUsd;
        day.calls += 1;

        let m = modelMap.get(model);
        if (!m) {
          m = { model, totalTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };
          modelMap.set(model, m);
        }
        m.totalTokens += totalTokens;
        m.outputTokens += raw.outputTokens ?? 0;
        m.costUsd += costUsd;
        m.calls += 1;
      }
    }

    result.daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    result.models = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    return result;
  }

  /** List existing usage log files (year descending). */
  private async listLogFiles(): Promise<string[]> {
    const fs = this.fs;
    if (!(await fs.exists(USAGE_DIR))) return [];
    const entries = await fs.readdir(USAGE_DIR);
    return entries
      .filter((e) => e.type === "file" && e.name.startsWith(USAGE_FILE_PREFIX) && e.name.endsWith(USAGE_FILE_SUFFIX))
      .map((e) => e.name)
      .sort()
      .reverse();
  }
}

function startOfToday(): number {
  const now = new Date();
  now.setHours(23, 59, 59, 999);
  return now.getTime();
}
