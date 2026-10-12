#!/usr/bin/env bash
# Negative-patch proof: each load-bearing websearch assertion must fail PRECISELY on its
# defect. Applies one mutation at a time, rebuilds, runs the validator, requires a failure
# whose message matches, and restores the file.
#
# Run: bash packages/core/scripts/negative-patch-websearch.sh
set -u
set -e
# Resolve the repo root (packages/core/scripts -> ../../..)
cd "$(cd "$(dirname "$0")/../../.." && pwd)" || exit 1
CORE="packages/core"
VALIDATOR="$CORE/src/agent/tools/websearch"

# Restore the current patch's backup if the script is interrupted mid-run.
backup=""
backup_target=""
restore() {
  if [ -n "$backup" ] && [ -n "$backup_target" ]; then
    cp "$backup" "$backup_target" 2>/dev/null || true
  fi
  # `if`, not `[ -n "$backup" ] && rm -f "$backup"`: with `set -e`, when `$backup` is empty
  # (the EXIT trap after the last case) the `&&` short-circuits and the function returns 1,
  # which aborts the EXIT trap with status 1 — masking the real exit code.
  if [ -n "$backup" ]; then rm -f "$backup"; fi
}
trap restore EXIT INT TERM

run_case() {
  local label="$1" file="$2" patch="$3" expect="$4" cmd="${5:-pnpm --filter @codent/core run validate:websearch-providers}"
  backup="$(mktemp)"
  backup_target="$file"
  cp "$file" "$backup"

  python3 -c "$patch" || {
    echo "PATCH FAILED (no-op?): $label"
    restore; backup=""; return 1
  }
  # A `str.replace` that finds no anchor silently no-ops, which then reads as
  # "validator PASSED" — a false negative in the *proof*. Treat an unchanged file
  # as a stale patch, not as a passing assertion.
  if cmp -s "$backup" "$file"; then
    echo "❌ $label: patch was a no-op (stale anchor) — update the patch string"
    restore; backup=""; backup_target=""
    return 1
  fi

  local out code
  if out="$($cmd 2>&1)"; then code=0; else code=$?; fi
  restore; backup=""; backup_target=""

  if [ "$code" -eq 0 ]; then
    echo "❌ $label: validator PASSED but should have failed"
    return 1
  fi
  if echo "$out" | grep -q "$expect"; then
    echo "✅ $label: failed on the right assertion"
    return 0
  fi
  echo "❌ $label: failed for the WRONG reason"
  echo "$out" | grep -E "AssertionError|Error:" | head -5
  return 1
}

fail=0

run_case "registry drop (parallel)" "$VALIDATOR/registry.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/registry.ts"; s=open(p).read(); s=s.replace("  { name: \"parallel\", create: () => parallelProvider },\n",""); open(p,"w").write(s)' \
  "registry order" || fail=1

run_case "key wiring dropped (tavily)" "$VALIDATOR/key-fields.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/key-fields.ts"; s=open(p).read(); s=s.replace("  tavily: \"tavilyApiKey\",\n",""); open(p,"w").write(s)' \
  "key fields are the single key-wiring source" || fail=1

run_case "spread removed" "$VALIDATOR/provider.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/provider.ts"; s=open(p).read(); s=s.replace("    if (available.length > 1 && this.sessionId) {\n      return available[hashToIndex(this.sessionId, available.length)];\n    }\n",""); open(p,"w").write(s)' \
  "spread by session id" || fail=1

run_case "tavily always available" "$VALIDATOR/providers/tavily.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/providers/tavily.ts"; s=open(p).read(); s=s.replace("  isAvailable(options?: SearchOptions): boolean {\n    return Boolean(options?.getApiKey?.(PROVIDER_NAME) ?? getProviderManager().getApiKey(PROVIDER_NAME));\n  },","  isAvailable(options?: SearchOptions): boolean {\n    return true;\n  },"); open(p,"w").write(s)' \
  "tavily must be unavailable" || fail=1

run_case "exa ignores its key" "$VALIDATOR/providers/exa.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/providers/exa.ts"; s=open(p).read(); s=s.replace("    const apiKey = options?.getApiKey?.(PROVIDER_NAME) ?? getProviderManager().getApiKey(PROVIDER_NAME);\n\n    const url = apiKey","    const apiKey = undefined;\n\n    const url = apiKey"); open(p,"w").write(s)' \
  "exa keyed transport" || fail=1

run_case "abort short-circuit removed" "$VALIDATOR/provider.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/provider.ts"; s=open(p).read(); s=s.replace("      if (options?.signal?.aborted) throw lastError;\n\n      for (const provider of this.providers) {","      for (const provider of this.providers) {",1); open(p,"w").write(s)' \
  "Missing expected rejection" || fail=1

run_case "keyed priority removed" "$VALIDATOR/provider.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/provider.ts"; s=open(p).read(); s=s.replace("    const keyed = available.find((p) => this.getApiKey(p.name));\n    if (keyed) return keyed;\n\n",""); open(p,"w").write(s)' \
  "keyed provider wins auto-selection" || fail=1

run_case "mcp isError ignored" "$VALIDATOR/providers/mcp-client.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/providers/mcp-client.ts"; s=open(p).read(); s=s.replace("    if (parsed?.result?.isError) {","    if (false) {"); open(p,"w").write(s)' \
  "isError" || fail=1

run_case "parallel malformed payload swallowed" "$VALIDATOR/providers/parallel.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/providers/parallel.ts"; s=open(p).read(); s=s.replace("    throw new Error(\"Parallel search returned a malformed payload\");","    return [];"); open(p,"w").write(s)' \
  "malformed payload" || fail=1

run_case "legacy key not normalized" "$CORE/src/models/config/models-config.ts" \
  'p="'"$CORE"'/src/models/config/models-config.ts"; s=open(p).read(); s=s.replace("  const { websearchProvider, ...rest } = toolConfig;\n  return {\n    ...config,","  const { websearchProvider, ...rest } = toolConfig;\n  return config;\n  // eslint-disable-next-line no-unreachable\n  return {\n    ...config,"); open(p,"w").write(s)' \
  "legacy websearchProvider is read as provider" || fail=1

run_case "explicit-unavailable not skipped" "$VALIDATOR/provider.ts" \
  'p="'"$CORE"'/src/agent/tools/websearch/provider.ts"; s=open(p).read(); s=s.replace("      if (explicit && (await this.isProviderAvailable(explicit))) {\n        return explicit;\n      }","      if (explicit) {\n        return explicit;\n      }"); open(p,"w").write(s)' \
  "unavailable provider is skipped" || fail=1

# Remote-session create must forward toolConfig (server plane). Patching the host to drop the
# field must make the live forwarding validator fail on the exact assertion.
run_case "remote host drops toolConfig" "packages/server/src/remote-session-host.ts" \
  'p="packages/server/src/remote-session-host.ts"; s=open(p).read(); s=s.replace("          ...(createOptions.toolConfig ? { toolConfig: createOptions.toolConfig } : {}),\n",""); open(p,"w").write(s)' \
  "the server-side agent must carry a websearch tool config" \
  "pnpm --filter @codent/server run validate:websearch-tool-config" || fail=1

if [ "$fail" -eq 0 ]; then echo "ALL NEGATIVE PATCHES PROVEN"; else echo "SOME PATCHES FAILED"; fi

# Each case rebuilt core from its temporary patch and only the SOURCE was restored, so
# `dist` is left built from the LAST mutation. Rebuild from the restored sources so a
# subsequent local `validate:*` run cannot fail against a deliberate defect. Not fatal:
# the proof above already ran against the right builds.
pnpm --filter @codent/core run build >/dev/null 2>&1 || true

exit "$fail"
