import { chat } from "@tanstack/ai";

import { extractRunErrorMessage } from "../../agent/stream/stream-errors.js";
import { sharedUsageHistory } from "../../agent/usage/usage-history-service.js";
import { calculateCost, extractTanStackUsage, type TokenUsage } from "../../runtime-types/token-usage.js";
import { errorMessage } from "../../utils/errors.js";
import { truncateText } from "../../utils/text-truncation.js";
import { maxTokensOption } from "../max-tokens-option.js";
import { applySideQueryOutputFloor } from "../side-query-budget.js";

import { extractJsonDocument, renderSchemaContract } from "./schema-prompt.js";
import { isStructuredOutputComplete } from "./structured-output-chunk.js";

import type { TextAdapterConfig } from "./adapter-factory.js";
import type { InferSchemaType, SchemaInput } from "@tanstack/ai";

// ============================================================================
// Types
// ============================================================================

/**
 * A fact a side query reports to the timeline.
 *
 * Two shapes, not a log line: which mode it ran in (with the reason, when the mode was *chosen*) and
 * whether it failed (with the raw excerpt, which is the only evidence of what the model actually
 * said). The owner publishes these as `side-query:*`; the port itself decides nothing about
 * recording — it may not even have a bus (a model-level unit test), which is why the sink is optional.
 */
export type SideQueryEvent =
  | { type: "side-query:mode"; purpose: string; mode: string; reason: string; model?: string }
  | {
      type: "side-query:error";
      purpose: string;
      mode: string;
      error: string;
      model?: string;
      durationMs?: number;
      rawExcerpt?: string;
      fallback?: string;
    };

/** Sink for {@link SideQueryEvent} facts. */
export type SideQueryTelemetry = (event: SideQueryEvent) => void;

/** One message in a side query's conversation. */
export interface SideQueryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SideTextQueryOptions {
  systemPrompt?: string;
  /** Single user turn. Ignored when {@link SideTextQueryOptions.messages} is provided. */
  userPrompt?: string;
  /**
   * Full conversation for the query, in order. Takes precedence over `userPrompt`.
   *
   * Exists for callers that need more than one turn (an extension refining a classification, a
   * summarizer given a transcript); the single-prompt form stays the common case. One of the two
   * must be present.
   */
  messages?: readonly SideQueryMessage[];
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /**
   * Whether to disable model reasoning/thinking for this lightweight call.
   * Defaults to `true` — memory selection and title generation don't need CoT.
   */
  disableThinking?: boolean;
  /**
   * Optional telemetry sink. The port is otherwise silent: a failed side query used to leave no
   * trace anywhere, and one caller (`session-service` title generation) swallowed it with a bare
   * `catch {}`.
   *
   * `complete` is reported only when the mode was **chosen** (declared capability, fallback) rather
   * than the implicit common case — a successful query on the expected path writes nothing, so there
   * is still no line per title/summary/memory-selection. Failures always report.
   */
  onEvent?: SideQueryTelemetry;
  /**
   * What this query is for, for attribution: `title`, `summary`, `memory-select`, `memory-extract`,
   * `memory-consolidate`, `extension:<id>`. Defaults to `side-query`.
   */
  purpose?: string;
}

export interface SideTextQueryResult {
  text: string;
  usage?: TokenUsage;
  /** Wall-clock duration of the underlying LLM call (ms). */
  durationMs: number;
}

/** Options for a structured one-shot query — `schema` selects this overload. */
export interface StructuredQueryOptions<TSchema extends SchemaInput> extends SideTextQueryOptions {
  schema: TSchema;
}

export interface StructuredQueryResult<T> {
  /** The model's response, parsed and validated against the requested schema. */
  data: T;
  /** The raw response text, before parsing (useful for diagnostics). */
  raw: string;
  usage?: TokenUsage;
  /** Wall-clock duration of the underlying LLM call (ms). */
  durationMs: number;
}

/**
 * Log category for every entry this port reports. Dedicated, not a caller's: the same port serves
 * memory, titles, and summaries, so filing under any one of them would misattribute the others.
 */
const SIDE_QUERY_LOG_CATEGORY = "side-query";

/** Cap on the raw-response excerpt attached to a failure warning. */
const RAW_EXCERPT_LIMIT = 500;

type QueryMode = "structured" | "text";

/**
 * What a failure record carries.
 *
 * `fallback` is set on a failure that triggers a retry in the other mode, so the
 * one record for that attempt says both what happened and what is being tried
 * next — instead of a second "retrying" entry that would restate the same failure.
 */
interface FailureContext {
  mode: QueryMode;
  /** Raw response excerpt, when the failure has one. */
  raw?: string;
  /** The mode this failure is about to be retried in. */
  fallback?: QueryMode;
}

// ============================================================================
// Side text query
// ============================================================================

/** One-shot text generation via TanStack `chat()`. */
export function runSideTextQuery(
  textAdapter: TextAdapterConfig,
  options: SideTextQueryOptions
): Promise<SideTextQueryResult>;
/**
 * One-shot structured generation via TanStack `chat({ outputSchema })`.
 *
 * The same port as the text form, selected by `schema` — a second function would
 * duplicate the abort plumbing, the thinking-disable mapping, and the usage
 * accounting, which are the only non-trivial parts.
 */
export function runSideTextQuery<TSchema extends SchemaInput>(
  textAdapter: TextAdapterConfig,
  options: StructuredQueryOptions<TSchema>
): Promise<StructuredQueryResult<InferSchemaType<TSchema>>>;
export async function runSideTextQuery<TSchema extends SchemaInput>(
  textAdapter: TextAdapterConfig,
  options: SideTextQueryOptions & { schema?: TSchema }
): Promise<SideTextQueryResult | StructuredQueryResult<InferSchemaType<TSchema>>> {
  return options.schema
    ? runStructuredQuery(textAdapter, { ...options, schema: options.schema })
    : runTextQuery(textAdapter, options);
}

/**
 * Run a structured query, choosing its mechanism against declared model capability.
 *
 * Three paths, and each one exists for a measured reason (models.dev: 54.6% of
 * entries declare `structured_output`, 14.5% declare it **false**, 30.8% are silent):
 *
 * | Declared | Path | Why |
 * |---|---|---|
 * | present, or unknown | structured, then one text retry on failure | the common case; a declared-support-but-broken endpoint is covered by the retry |
 * | positively absent | text only | a decision, not a guess — the structured request is known to be unsupported, and its failure mode varies by provider (a 400, or a silent no-event) |
 *
 * A schema that cannot be rendered as a text contract needs text mode to work, so
 * it is checked before the mode is chosen rather than after a structured failure —
 * otherwise the retry would throw from where the caller expects a fallback.
 */
async function runStructuredQuery<TSchema extends SchemaInput>(
  textAdapter: TextAdapterConfig,
  options: StructuredQueryOptions<TSchema>
): Promise<StructuredQueryResult<InferSchemaType<TSchema>>> {
  assertObjectRootSchema(options.schema);

  const declaredUnsupported = textAdapter.structuredOutput === "unsupported";
  // Fail a schema the renderer cannot express before any request is issued, on
  // every path — it is a caller bug, not a capability question.
  const contract = renderSchemaContract(options.schema);

  if (declaredUnsupported) {
    reportModeDecision(textAdapter, options, "text", "the model's capabilities declare no structured output");
    return runTextModeQuery(textAdapter, options, contract);
  }

  try {
    return await runStructuredModeQuery(textAdapter, options, { fallback: "text" });
  } catch (structuredError) {
    // The fallback exists for the case no metadata can rule out: a model that
    // *declares* support and whose endpoint nevertheless rejects or silently
    // ignores the request. The structured failure has already been recorded, with
    // `fallback: "text"` on it, so nothing is restated here.
    try {
      const fallback = await runTextModeQuery(textAdapter, options, contract);
      // The structured attempt was billed even though it failed; its usage belongs to this call.
      return { ...fallback, usage: sumUsage(billedUsage(structuredError), fallback.usage) };
    } catch (textError) {
      // Both reasons, because the log is optional: a caller with no `log` would
      // otherwise see only the text-mode reason and never learn that the model was
      // asked for structured output first — the single most useful fact about the
      // failure.
      throw withUsage(
        new Error(
          `structured attempt failed: ${reasonOf(structuredError)}; ` +
            `text fallback also failed: ${reasonOf(textError)}`
        ),
        sumUsage(billedUsage(structuredError), billedUsage(textError))
      );
    }
  }
}

function reasonOf(error: unknown): string {
  return errorMessage(error);
}

/** Usage already billed by an attempt that failed (the port attaches it to the thrown error). */
function billedUsage(error: unknown): TokenUsage | undefined {
  return (error as { usage?: TokenUsage }).usage;
}

/**
 * Sum the usage of two attempts of one logical query.
 *
 * The structured attempt can be billed and still fail (no completion event, a value the schema
 * rejects); the text fallback then bills again. Returning only the fallback's usage made the first
 * attempt the one LLM call a session never paid for.
 */
function sumUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
    ...(a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }
      : {}),
  };
}

/**
 * Attach already-billed usage to a failure.
 *
 * A structured call can be billed and still fail (no completion event, or a value the schema rejects);
 * a caller that only sees the error would attribute nothing and a systematically failing caller would
 * spend tokens invisibly. The property is additive and typed at the caller.
 */
function withUsage<T extends Error>(error: T, usage: TokenUsage | undefined): T {
  if (usage) (error as T & { usage?: TokenUsage }).usage = usage;
  return error;
}

/**
 * The conversation to send: the caller's messages when given, else the single user prompt.
 *
 * Both entry points are optional on the type, so this is where "one of them must exist" is enforced —
 * a query with neither would otherwise send an empty conversation and get an empty answer.
 */
function queryMessages(options: SideTextQueryOptions): Array<{ role: "user" | "assistant"; content: string }> {
  if (options.messages && options.messages.length > 0) {
    return options.messages.map((message) => ({ role: message.role, content: message.content }));
  }
  if (typeof options.userPrompt === "string" && options.userPrompt.length > 0) {
    return [{ role: "user", content: options.userPrompt }];
  }
  throw new Error("runSideTextQuery requires `userPrompt` or a non-empty `messages` list");
}

// ============================================================================
// Text branch
// ============================================================================

async function runTextQuery(
  textAdapter: TextAdapterConfig,
  options: SideTextQueryOptions
): Promise<SideTextQueryResult> {
  const startTime = Date.now();
  const query = createQueryRequest(textAdapter, options);
  try {
    const stream = chat({
      adapter: textAdapter.adapter,
      messages: queryMessages(options),
      systemPrompts: options.systemPrompt ? [options.systemPrompt] : undefined,
      ...query.request,
    });

    let text = "";
    let usage: TokenUsage | undefined;

    for await (const chunk of stream) {
      if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta) {
        text += chunk.delta;
      }
      if (chunk.type === "RUN_FINISHED" && chunk.usage) {
        usage = extractTanStackUsage(chunk.usage);
        recordUsage(textAdapter, usage);
      }
      if (chunk.type === "RUN_ERROR") {
        throw new Error(
          sideQueryError(extractRunErrorMessage(chunk), textAdapter, options, startTime, { mode: "text" })
        );
      }
    }

    return { text: text.trim(), usage, durationMs: Date.now() - startTime };
  } finally {
    // Release the abort mirror: the run's signal outlives this query.
    query.dispose();
  }
}

// ============================================================================
// Structured branch
// ============================================================================

/**
 * Reject a top-level non-object schema before the request is built.
 *
 * **This is why the guard exists.** The Anthropic adapter has no
 * `structuredOutputStream`, so `chat({ outputSchema, stream: true })` falls back
 * to its forced-tool `structuredOutput()`, which builds the tool's `input_schema`
 * from the schema's **properties**:
 *
 * ```ts
 * input_schema: { type: "object", properties: outputSchema.properties ?? {}, required: outputSchema.required ?? [] }
 * ```
 *
 * A top-level `array` (or any schema without `properties`) therefore degrades to
 * `{ type: "object", properties: {}, required: [] }` — an empty object the model
 * fills with whatever key it likes. The reply is never an array, so validation
 * fails on **every** call, deterministically. That is exactly how memory
 * extraction returned zero memories for two days while every attempt logged a
 * schema error: the failure looked like a flaky model, not a broken request.
 *
 * The guard turns that silent 100%-failure mode into one loud call-site error.
 * `object` is the contract every provider can honour, so a top-level array is a
 * bug in the caller, not a capability the port should absorb.
 */
function assertObjectRootSchema(schema: SchemaInput): void {
  const root = (schema as { "~standard"?: { jsonSchema?: { input?: () => unknown } } })[
    "~standard"
  ]?.jsonSchema?.input?.();
  // A raw JSON Schema the caller passed through has no `~standard`; nothing to check.
  if (!root || typeof root !== "object") return;
  const type = (root as { type?: unknown }).type;
  if (type === undefined || type === "object") return;
  throw new Error(
    `runSideTextQuery requires a top-level object schema, received \`${JSON.stringify(type)}\`. ` +
      "The provider's structured-output request is built from the schema's `properties`, so a " +
      "non-object root is sent as an empty object and its response can never validate — every call " +
      "fails. Wrap the payload in an object key (e.g. `z.object({ items: z.array(...) })`)."
  );
}

/** The structured mechanism. Throws on any failure — the caller decides on the fallback. */
async function runStructuredModeQuery<TSchema extends SchemaInput>(
  textAdapter: TextAdapterConfig,
  options: StructuredQueryOptions<TSchema>,
  failureContext: { fallback?: QueryMode }
): Promise<StructuredQueryResult<InferSchemaType<TSchema>>> {
  const startTime = Date.now();

  // `stream: true` is required, not stylistic. The `Promise<T>` form of
  // `chat({ outputSchema })` returns only the parsed object — it never surfaces
  // the adapter's token usage — and it is not iterable. Requesting the stream
  // keeps usage (from `RUN_FINISHED`) and keeps this function's shape familiar.
  const query = createQueryRequest(textAdapter, options);
  const stream = queryStream(query, (request) =>
    chat({
      adapter: textAdapter.adapter,
      messages: queryMessages(options),
      systemPrompts: options.systemPrompt ? [options.systemPrompt] : undefined,
      outputSchema: options.schema,
      stream: true as const,
      ...request,
    })
  );

  let text = "";
  let capture: { object: unknown; raw: string } | null = null;
  let usage: TokenUsage | undefined;

  for await (const chunk of stream) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta) {
      text += chunk.delta;
    }
    // The object arrives as a CUSTOM event, already normalized by the engine
    // (optional-field null widening undone). Validation is still ours to do —
    // the streaming path deliberately does not validate, unlike `Promise<T>`.
    if (isStructuredOutputComplete(chunk)) {
      capture = { object: chunk.value.object, raw: chunk.value.raw };
    }
    if (chunk.type === "RUN_FINISHED" && chunk.usage) {
      usage = extractTanStackUsage(chunk.usage);
      recordUsage(textAdapter, usage);
    }
    if (chunk.type === "RUN_ERROR") {
      throw new Error(
        sideQueryError(extractRunErrorMessage(chunk), textAdapter, options, startTime, {
          mode: "structured",
          ...failureContext,
        })
      );
    }
  }

  const durationMs = Date.now() - startTime;

  if (!capture) {
    const reason = "no structured-output completion event was emitted";
    throw withUsage(
      new Error(
        sideQueryError(reason, textAdapter, options, startTime, {
          mode: "structured",
          raw: text,
          ...failureContext,
        })
      ),
      usage
    );
  }

  // Narrow for the closure below: `capture` is reassigned inside the loop, so TS
  // cannot carry the non-null narrowing past the await points on its own.
  const result = capture;

  // Validate explicitly. The schema may also transform (clamping a range,
  // normalizing a timestamp), and the transformed value is what callers must
  // receive — returning the raw object would silently drop every transform.
  const validation = validateAgainstSchema(options.schema, result.object);
  if (!validation.ok) {
    const reason = `response failed schema validation: ${validation.issue}`;
    throw withUsage(
      new Error(
        sideQueryError(reason, textAdapter, options, startTime, {
          mode: "structured",
          raw: result.raw,
          ...failureContext,
        })
      ),
      usage
    );
  }

  return {
    data: validation.value as InferSchemaType<TSchema>,
    raw: result.raw,
    usage,
    durationMs,
  };
}

/**
 * Validate with the Standard Schema surface when the caller passed one.
 *
 * Returns the transformed value on success — a schema's transforms are part of
 * its contract (clamping a range, normalizing a timestamp), so discarding
 * `result.value` would hand callers a value the schema never approved.
 *
 * A plain JSON Schema has no validator attached, so it is accepted as-is: the
 * provider already constrained the shape, and rejecting it here would make the
 * port unusable with raw JSON Schemas.
 */
function validateAgainstSchema(schema: SchemaInput, value: unknown): ValidationOutcome {
  const standard = (schema as { "~standard"?: { validate?: (input: unknown) => unknown } })["~standard"];
  if (!standard?.validate) return { ok: true, value };

  const result = standard.validate(value) as
    { value?: unknown; issues?: ReadonlyArray<ValidationIssue> } | Promise<unknown>;
  if (result instanceof Promise) {
    return { ok: false, issue: "schema produced an async validation result, which this port does not support" };
  }
  const issues = result.issues;
  if (issues && issues.length > 0) {
    return { ok: false, issue: issues.map(formatIssue).join("; ") };
  }
  return { ok: true, value: "value" in result ? result.value : value };
}

type ValidationOutcome = { ok: true; value: unknown } | { ok: false; issue: string };

interface ValidationIssue {
  message?: string;
  /** Standard Schema's location of the offending value, e.g. `[1, "body"]`. */
  path?: ReadonlyArray<PropertyKey>;
}

/**
 * Render one issue with its path.
 *
 * The message alone ("expected string, received undefined") does not say *which*
 * entry failed, so a 20-entry array whose second item is malformed reads the
 * same as one whose last item is. That location is the only diagnostic a
 * background extraction gets, so dropping it makes a schema failure
 * indistinguishable from a model that simply returned nothing.
 */
function formatIssue(issue: ValidationIssue): string {
  const message = issue.message ?? "invalid";
  const path = issue.path;
  if (!path || path.length === 0) return message;
  return `${path.map(String).join(".")}: ${message}`;
}

// ============================================================================
// Text mode (constrained by a rendered schema contract)
// ============================================================================

/**
 * Ask for the schema's shape in prose, then locate a complete JSON document in the
 * reply and validate it with the caller's schema.
 *
 * This is the path for a model that cannot do structured output, so it must not
 * weaken the contract to compensate: the parsed value goes through the **same**
 * {@link validateAgainstSchema} as the structured path, transforms included, so a
 * caller cannot observe which mechanism ran. What is given up is provider-side
 * enforcement, and the rendered contract in the prompt is what replaces it.
 *
 * A reply with no single complete JSON document — or with two, or with one that
 * fails validation — is a failure. Nothing is repaired or partially accepted.
 */
async function runTextModeQuery<TSchema extends SchemaInput>(
  textAdapter: TextAdapterConfig,
  options: StructuredQueryOptions<TSchema>,
  contract: string
): Promise<StructuredQueryResult<InferSchemaType<TSchema>>> {
  const startTime = Date.now();
  const systemPrompt = options.systemPrompt ? `${options.systemPrompt}\n\n${contract}` : contract;

  const query = createQueryRequest(textAdapter, options);
  const stream = queryStream(query, (request) =>
    chat({
      adapter: textAdapter.adapter,
      messages: queryMessages(options),
      systemPrompts: [systemPrompt],
      ...request,
    })
  );

  let text = "";
  let usage: TokenUsage | undefined;

  for await (const chunk of stream) {
    if (chunk.type === "TEXT_MESSAGE_CONTENT" && chunk.delta) {
      text += chunk.delta;
    }
    if (chunk.type === "RUN_FINISHED" && chunk.usage) {
      usage = extractTanStackUsage(chunk.usage);
      recordUsage(textAdapter, usage);
    }
    if (chunk.type === "RUN_ERROR") {
      throw new Error(sideQueryError(extractRunErrorMessage(chunk), textAdapter, options, startTime, { mode: "text" }));
    }
  }

  const durationMs = Date.now() - startTime;
  const extracted = extractJsonDocument(text);
  if (!extracted) {
    const reason = "no complete JSON document was found in the reply";
    throw withUsage(
      new Error(sideQueryError(reason, textAdapter, options, startTime, { mode: "text", raw: text })),
      usage
    );
  }

  const validation = validateAgainstSchema(options.schema, extracted.value);
  if (!validation.ok) {
    const reason = `response failed schema validation: ${validation.issue}`;
    throw withUsage(
      new Error(sideQueryError(reason, textAdapter, options, startTime, { mode: "text", raw: extracted.raw })),
      usage
    );
  }

  return {
    data: validation.value as InferSchemaType<TSchema>,
    raw: extracted.raw,
    usage,
    durationMs,
  };
}

// ============================================================================
// Mode reporting
// ============================================================================

/** Report the mode a query ran in, when that mode was a decision rather than the default. */
function reportModeDecision<TSchema extends SchemaInput>(
  textAdapter: TextAdapterConfig,
  options: StructuredQueryOptions<TSchema>,
  mode: QueryMode,
  reason: string
): void {
  options.onEvent?.({
    type: "side-query:mode",
    purpose: options.purpose ?? SIDE_QUERY_LOG_CATEGORY,
    mode,
    reason,
    model: textAdapter.model,
  });
}

// ============================================================================
// Shared helpers
// ============================================================================

/** Request options shared by both branches, plus the teardown that detaches the abort mirror. */
interface QueryRequestOptions {
  request: {
    abortController: AbortController;
    debug: false;
    promptCache: "none";
    modelOptions: Record<string, unknown>;
    reasoning?: "off";
  };
  /**
   * Detach the abort mirror.
   *
   * `{ once: true }` only removes the listener when the abort fires — a normally completed query left
   * one listener on a signal that lives for the whole run. At 20 completions per run that crosses
   * Node's default 10-listener threshold, and the resulting `MaxListenersExceededWarning` on stderr
   * corrupts a full-screen TUI. Callers release it in a `finally`.
   */
  dispose: () => void;
}

function createQueryRequest(
  textAdapter: TextAdapterConfig,
  options: Pick<SideTextQueryOptions, "abortSignal" | "maxOutputTokens" | "disableThinking">
): QueryRequestOptions {
  const abortController = new AbortController();
  let detach: (() => void) | undefined;
  if (options.abortSignal) {
    const source = options.abortSignal;
    if (source.aborted) {
      abortController.abort(source.reason);
    } else {
      const onAbort = () => abortController.abort(source.reason);
      source.addEventListener("abort", onAbort, { once: true });
      detach = () => source.removeEventListener("abort", onAbort);
    }
  }

  const disableThinking = options.disableThinking ?? true;

  return {
    request: {
      abortController,
      debug: false,
      // TanStack 0.69+ enables automatic prompt caching by default. Side queries are
      // one-shot and our cache policy belongs to the main agent's middleware.
      promptCache: "none" as const,
      ...(disableThinking && textAdapter.reasoning ? { reasoning: "off" as const } : {}),
      modelOptions: {
        // The cap goes through the thinking-aware floor: `max_tokens` bounds thinking AND the
        // answer, so a job-sized cap starves the answer on a reasoning model. See
        // `side-query-budget.ts` for the measurements behind the number.
        ...maxTokensOption(textAdapter.modelStyle, applySideQueryOutputFloor(options.maxOutputTokens)),
      },
    },
    dispose: () => detach?.(),
  };
}

/**
 * Wrap a query's stream so the abort mirror is released however the stream ends.
 *
 * Prefer this over a bare `chat()`: the run's signal outlives the query, so an undetached listener is
 * one leak per side query (see {@link createQueryRequest}).
 */
async function* queryStream<T>(
  query: QueryRequestOptions,
  create: (request: QueryRequestOptions["request"]) => AsyncIterable<T>
): AsyncIterable<T> {
  try {
    yield* create(query.request);
  } finally {
    query.dispose();
  }
}

/**
 * Report a failure and return its message for the caller to throw.
 *
 * A `RUN_ERROR` is a stream chunk rather than a throw, so without this the
 * failure never reaches a catch block anywhere in the process — which is how a
 * failed title generation previously left no trace.
 */
function sideQueryError(
  message: string,
  textAdapter: TextAdapterConfig,
  options: SideTextQueryOptions,
  startTime: number,
  context: FailureContext
): string {
  options.onEvent?.({
    type: "side-query:error",
    purpose: options.purpose ?? SIDE_QUERY_LOG_CATEGORY,
    mode: context.mode,
    error: message,
    model: textAdapter.model,
    durationMs: Date.now() - startTime,
    // The raw reply is truncated here rather than at the recorder: this port is the only place that
    // knows which slice is evidence and which is the whole response.
    ...(context.raw ? { rawExcerpt: excerpt(context.raw) } : {}),
    ...(context.fallback ? { fallback: context.fallback } : {}),
  });
  return message;
}

function recordUsage(textAdapter: TextAdapterConfig, usage: TokenUsage | undefined): void {
  if (!usage) return;
  sharedUsageHistory.record({
    agentId: "side-query",
    model: textAdapter.model,
    usage,
    costUsd: textAdapter.pricing ? calculateCost(usage, textAdapter.pricing) : 0,
  });
}

function excerpt(raw: string): string {
  const trimmed = raw.trim();
  return truncateText(trimmed, RAW_EXCERPT_LIMIT);
}
