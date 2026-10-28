/**
 * The CLI's command-line parser, pinned.
 *
 * This is the seam that silently dropped input: `--sandbox=native` was stored under a flag *named*
 * `sandbox=native`, so the host kept the default, and `--max-iteration` (typo) was accepted into a
 * map nothing read. The parser is now Node's strict `util.parseArgs`, so each of those is a
 * throw — and this file is what keeps it that way (the CLI had no validator at all, which is why
 * the drop went unnoticed).
 *
 * Run: pnpm --filter @codent/cli run validate:cli-args
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Ambient config would leak into the flag/env precedence assertions below.
const SAVED_ENV = {};
for (const key of [
  "MODEL",
  "model",
  "MODEL_STYLE",
  "STYLE",
  "BASE_URL",
  "MODEL_BASE_URL",
  "API_KEY",
  "MAX_ITERATIONS",
  "maxIterations",
  "MAX_CONCURRENT_TASKS",
  "maxConcurrentTasks",
  "MCP_CONFIG_PATH",
  "REMOTE_ENV",
  "REMOTE_PROVIDER",
  "REMOTE_SESSION",
  "SANDBOX_ENV",
  "BRAVE_API_KEY",
  "EXA_API_KEY",
  "PARALLEL_API_KEY",
  "TAVILY_API_KEY",
  "WEBSEARCH_PROVIDER",
]) {
  SAVED_ENV[key] = process.env[key];
  delete process.env[key];
}
process.env.MODEL = "env-model";
process.env.API_KEY = "env-key";

const { parseCliArgs, isHelpRequested, isVersionRequested } = await import("../dist/args.mjs");

// ---------------------------------------------------------------------------
// 1. Defaults (no flags, no relevant env beyond MODEL/API_KEY)
// ---------------------------------------------------------------------------

{
  const config = parseCliArgs([]);
  assert.equal(config.maxIterations, 50, "the one default constant (DEFAULT_AGENT_MAX_ITERATIONS)");
  assert.equal(config.initialPrompt, "", "no positional ⇒ no prompt");
  assert.equal(config.continueSession, false);
  assert.equal(config.clientEnv, false);
  assert.equal(config.sandbox, undefined, "no flag ⇒ the host applies env > local");
  assert.equal(config.resumeSession, "");
  assert.equal(config.modelExplicit, false, "env-only model is not an explicit flag");
  assert.equal(config.model, "env-model");
}

// ---------------------------------------------------------------------------
// 2. `--flag=value` and `--flag value` are the same flag
// ---------------------------------------------------------------------------

{
  assert.equal(parseCliArgs(["--sandbox=native"]).sandbox, "native");
  assert.equal(parseCliArgs(["--sandbox", "native"]).sandbox, "native");
  assert.equal(parseCliArgs(["--sandbox="]).sandbox, "", "an empty value stays empty so the host rejects it");
  assert.equal(parseCliArgs(["--max-iterations=30"]).maxIterations, 30);
  assert.equal(parseCliArgs(["--max-iterations", "30"]).maxIterations, 30);
  assert.equal(
    parseCliArgs(["--max-iterations=200"]).maxIterations,
    200,
    "range is the host's check, not the parser's"
  );
}

// ---------------------------------------------------------------------------
// 3. Input that used to be dropped is now an ERROR
// ---------------------------------------------------------------------------

for (const [argv, why] of [
  [["--max-iteration", "30"], "a typo'd flag is unknown"],
  [["--bogus"], "an unknown flag is unknown"],
  [["--max-iterations", "-1"], "a leading `-` value is ambiguous, not the next flag"],
  [["--sandbox"], "a value-taking flag with no value"],
  [["--system"], "same for --system"],
]) {
  assert.throws(() => parseCliArgs(argv), Error, why);
}

// A negative number still parses when it is unambiguously attached to its flag.
assert.equal(parseCliArgs(["--max-iterations=-1"]).maxIterations, -1);

// ---------------------------------------------------------------------------
// 4. Positionals: joined prompt, and `--` protects a prompt that starts with `-`
// ---------------------------------------------------------------------------

assert.equal(parseCliArgs(["fix", "the", "bug"]).initialPrompt, "fix the bug", "positionals are space-joined");
assert.equal(
  parseCliArgs(["--", "--fix the bug"]).initialPrompt,
  "--fix the bug",
  "`--` ends flag parsing, so a prompt may start with `-`"
);
assert.equal(parseCliArgs(["--sandbox", "native", "do", "it"]).initialPrompt, "do it");
assert.equal(
  parseCliArgs(["--sandbox", "native", "--", "--literal"]).sandbox,
  "native",
  "flags before `--` still apply"
);

// ---------------------------------------------------------------------------
// 5. `--resume` / `-r` keep their optional-value (picker) semantics
// ---------------------------------------------------------------------------

assert.equal(parseCliArgs(["-r"]).resumeSession, "__picker__", "bare -r opens the picker");
assert.equal(parseCliArgs(["--resume"]).resumeSession, "__picker__");
assert.equal(parseCliArgs(["-r", "ses_123"]).resumeSession, "ses_123");
assert.equal(parseCliArgs(["--resume", "ses_123"]).resumeSession, "ses_123");
assert.equal(parseCliArgs(["-r", "-c"]).resumeSession, "__picker__", "followed by another flag ⇒ picker");
assert.equal(parseCliArgs(["-r", "-c"]).continueSession, true, "…and the next flag still parses");

// ---------------------------------------------------------------------------
// 6. Short aliases, grouping, and the legacy long spellings
// ---------------------------------------------------------------------------

{
  const config = parseCliArgs(["-m", "cli-model", "-s", "be terse", "-k", "k1", "-u", "http://u", "-R", "http://env"]);
  assert.equal(config.model, "cli-model");
  assert.equal(config.modelExplicit, true, "an explicit model flag is reported as such");
  assert.equal(config.systemPrompt, "be terse");
  assert.equal(config.apiKey, "k1");
  assert.equal(config.baseURL, "http://u");
  assert.equal(config.remoteEnv, "http://env");
  assert.equal(parseCliArgs(["-cv"]).continueSession, true, "grouped short booleans");
  assert.equal(parseCliArgs(["-cv"]).clientEnv, false, "…v is --version, not --client-env");
  assert.equal(parseCliArgs(["--baseURL", "http://legacy"]).baseURL, "http://legacy");
  assert.equal(parseCliArgs(["--extension-dir", "a,b"]).extensionDirs.length, 2, "legacy singular spelling");
  assert.equal(parseCliArgs(["--max-concurrent-tasks", "7"]).maxConcurrentTasks, 7);
}

// ---------------------------------------------------------------------------
// 7. Help/version win over an invalid command line (they are raw scans)
// ---------------------------------------------------------------------------

assert.equal(isHelpRequested(["--help"]), true);
assert.equal(isHelpRequested(["-h"]), true);
assert.equal(isHelpRequested(["--help", "--bogus"]), true, "help must render even when another flag is wrong");
assert.equal(isHelpRequested(["--sandbox"]), false);
assert.equal(isVersionRequested(["--version"]), true);
assert.equal(isVersionRequested(["-v"]), true);
assert.equal(isVersionRequested(["-cv"]), false, "grouped shorts are not a version request");

// ---------------------------------------------------------------------------
// 8. Flag > env > default, unchanged by the parser swap
// ---------------------------------------------------------------------------

process.env.MAX_ITERATIONS = "12";
assert.equal(parseCliArgs([]).maxIterations, 12, "env supplies the budget");
assert.equal(parseCliArgs(["--max-iterations", "33"]).maxIterations, 33, "flag wins over env");
process.env.REMOTE_ENV = "http://from-env";
assert.equal(parseCliArgs([]).remoteEnv, "http://from-env");
assert.equal(parseCliArgs(["--remote-env", "http://flag"]).remoteEnv, "http://flag");
process.env.BRAVE_API_KEY = "env-brave";
assert.equal(parseCliArgs([]).toolConfig?.websearch?.braveApiKey, "env-brave", "env websearch keys reach toolConfig");

// ---------------------------------------------------------------------------
// 9. The real bin: parser errors exit 1 BEFORE any TUI render
// ---------------------------------------------------------------------------

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.mjs");
// A clean child env: section 8 leaves MAX_ITERATIONS / REMOTE_ENV / BRAVE_API_KEY set, and
// spreading this process's env would make the host try that remote plane (exit 1 before help).
const CHILD_ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  MODEL: "m",
  API_KEY: "k",
  SANDBOX_ENV: "native",
};
for (const [argv, expected] of [
  [["--bogus"], /Unknown option/],
  [["--max-iteration", "30"], /Unknown option/],
  [["--sandbox=bogus"], /must be "local"/],
  [["--sandbox="], /requires a value/],
  [["--max-iterations=200"], /between 1 and 100/],
]) {
  const run = spawnSync(process.execPath, [bin, ...argv], {
    encoding: "utf8",
    timeout: 20_000,
    env: CHILD_ENV,
  });
  assert.equal(run.status, 1, `${argv.join(" ")} exits 1`);
  assert.match(run.stderr, expected, `${argv.join(" ")} prints the parser/host message`);
}

// `--help` wins over an invalid command line (it reads host defaults, not the flags).
{
  const run = spawnSync(process.execPath, [bin, "--help", "--bogus"], {
    encoding: "utf8",
    timeout: 30_000,
    env: CHILD_ENV,
  });
  assert.equal(run.status, 0, "help wins over a typo'd flag");
  assert.match(run.stdout, /Codent/, "…and the help screen is what renders");
}

for (const [key, value] of Object.entries(SAVED_ENV)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

console.log("cli-args validation passed");
