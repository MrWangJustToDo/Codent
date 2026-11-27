/**
 * The closed set of interceptor hook names.
 *
 * Observer events are a typed registry (`AGENT_EVENT_META`): a typo in an `observe(type)` argument
 * fails to compile, and a new event has to be declared before anyone can subscribe. Interceptor
 * hooks had neither guarantee, and the failure is the dangerous one: `registerInterceptor` took a
 * bare `string`, so an extension that wrote `tool:befor:run_command` (or a family name this build
 * does not dispatch) registered a handler that could never fire. For a `tool:before:*` guard that
 * is a silent FAIL-OPEN — the code looks like it denies the call and the call runs.
 *
 * So the family names are a closed set here, the per-tool suffix is a template literal, and the
 * runner refuses an unknown hook at registration (it writes a warning naming the known hooks). A
 * JavaScript extension cannot be type-checked, which is exactly why the runtime check exists.
 *
 * A per-tool pattern may end in `*`: `interceptorMatches` treats a trailing `*` as a prefix match,
 * so `tool:before:*` and `tool:before:run_*` are both legitimate registrations.
 *
 * The `*` must be LAST. `interceptorMatches` has no other wildcard form, so `tool:before:*_command`
 * used to pass this check and then never match anything — the same silent fail-open this module
 * exists to prevent, one layer down.
 */

/** Hooks that are a single fixed name (no per-tool suffix). */
const STATIC_INTERCEPTOR_HOOKS = ["before_agent_start", "session:bootstrap", "session:shutdown"] as const;

export type StaticInterceptorHook = (typeof STATIC_INTERCEPTOR_HOOKS)[number];

/** Per-tool hook families; the name after the colon is a tool name (or a `prefix*` pattern). */
export type ToolInterceptorFamily = "tool:before" | "tool:after" | "tool:error";

export type InterceptorHook = StaticInterceptorHook | `${ToolInterceptorFamily}:${string}`;

const TOOL_HOOK_PATTERN = /^tool:(?:before|after|error):/;

/** Whether `value` names a hook the runtime dispatches (the runtime arm of {@link InterceptorHook}). */
export function isInterceptorHook(value: string): value is InterceptorHook {
  if ((STATIC_INTERCEPTOR_HOOKS as readonly string[]).includes(value)) return true;
  const prefix = TOOL_HOOK_PATTERN.exec(value);
  if (!prefix) return false;
  const suffix = value.slice(prefix[0].length);
  if (suffix.length === 0) return false;
  // `interceptorMatches` only understands a TRAILING `*` (prefix match). A `*` anywhere else would
  // register a handler that can never fire — a silent fail-open for a `tool:before:*` guard.
  const body = suffix.endsWith("*") ? suffix.slice(0, -1) : suffix;
  return !body.includes("*");
}

/** Human-readable list for a refusal message. */
export const INTERCEPTOR_HOOK_HELP =
  "before_agent_start, session:bootstrap, session:shutdown, or tool:before|after|error:<tool name> " +
  "(a per-tool name may be a `prefix*` pattern; the `*` must be LAST)";
