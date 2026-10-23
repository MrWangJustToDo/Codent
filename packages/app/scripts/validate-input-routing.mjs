/**
 * Fail if the app re-introduces cross-screen keyboard handling.
 *
 * A keystroke must reach the handlers of exactly one screen. The renderer gives no way to claim a
 * key (handler return values are discarded, there is no `stopPropagation`, registration order is not
 * stable), so exclusivity has to be structural: every screen wraps itself in an `InputScope`, and
 * every handler registers through the one primitive that turns that scope into `isActive`.
 *
 * The only exception is the process exit chord (`useExitInput`), which matches `ctrl+c` — a chord no
 * surface handler claims.
 *
 * Run: pnpm --filter @codent/app run validate:input-routing
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "../../..");
const srcRoot = join(scriptDir, "../src");

/** The only module allowed to touch `useInput` — everything else names a surface. */
const PRIMITIVE = "hooks/input/use-surface-input.ts";

/** The one component allowed to call `useAgentKeybindings` (it renders inside the `main` scope). */
const KEYBINDINGS_HOST = "components/ChatKeybindings.tsx";
const KEYBINDINGS_DEFINITION = "hooks/use-agent-keybindings.ts";

/** Removed by this change; a reappearance means the old convention came back. */
const FORBIDDEN_SYMBOLS = ["isAnyPanelOpen", "panelJustClosed", "PANEL_SURFACES", "lastClosedAt", "CLOSE_DEBOUNCE_MS"];

/** Named hook → the surface it must delegate to, and the file that is allowed to define it. */
const SURFACE_HOOKS = new Map([
  ["useMainInput", { surface: "main", file: "hooks/input/use-main-input.ts" }],
  ["useWorkspacePanelInput", { surface: "workspace", file: "hooks/input/use-workspace-panel-input.ts" }],
  ["useTaskPanelInput", { surface: "task", file: "hooks/input/use-task-panel-input.ts" }],
  ["useExtensionPanelInput", { surface: "extension", file: "hooks/input/use-extension-panel-input.ts" }],
]);

/** A screen's handlers may not reach another screen's store. (`main` may act on panels: its chords open them.) */
const FOREIGN_STORES = new Map([
  ["workspace", ["useSubagentPanel", "useExtensionPanel", "useConfigEditor"]],
  ["task", ["useWorkspacePanel", "useExtensionPanel", "useConfigEditor"]],
  ["extension", ["useWorkspacePanel", "useSubagentPanel", "useConfigEditor"]],
]);

/** Host files that render an input-owning screen directly must provide its scope. */
const HOST_ROOTS = ["packages/cli/src", "packages/codent/src"];
const SCOPED_SCREENS = ["<ConfigEditor", "<SessionPicker", "<SubagentPanel", "<WorkspacePanel", "<ExtensionPanel"];

function walkTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Drop comments before matching, preserving line numbers.
 *
 * Only *full-line* comments are dropped: this change's rationale is about the removed symbols, so
 * the prose keeps naming them, and a plain grep would fail on the documentation. Whole-line
 * stripping also avoids the trap of a `/*` inside a string literal (`"image/*"`) swallowing the
 * code that follows it.
 */
function stripComments(text) {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      const isComment = trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
      return isComment ? "" : line;
    })
    .join("\n");
}

/** The body of the `index`-th `<InputScopeProvider>` element, by brace-free tag-depth scan. */
function scopeBlocks(text) {
  const blocks = [];
  const open = /<InputScopeProvider\b[^>]*>/g;
  let match;
  while ((match = open.exec(text)) !== null) {
    const start = match.index;
    const tag = match[0];
    const value = /value=\{?["']([a-z]+)["']\}?/.exec(tag)?.[1] ?? null;
    let depth = 1;
    let i = start + tag.length;
    let closeAt = text.length;
    while (i < text.length && depth > 0) {
      const nextOpen = text.indexOf("<InputScopeProvider", i);
      const nextClose = text.indexOf("</InputScopeProvider>", i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        i = nextOpen + "<InputScopeProvider".length;
      } else {
        depth -= 1;
        closeAt = nextClose;
        i = nextClose + "</InputScopeProvider>".length;
      }
    }
    // The body excludes its own opening tag, so `body.includes("<InputScopeProvider")` means nested.
    blocks.push({ start, value, body: text.slice(start + tag.length, closeAt) });
  }
  return blocks;
}

const violations = [];
const files = walkTsFiles(srcRoot).map((file) => ({
  rel: relative(srcRoot, file).replaceAll("\\", "/"),
  raw: readFileSync(file, "utf8"),
}));

for (const { rel, raw } of files) {
  const text = stripComments(raw);
  const lines = text.split("\n");

  // 1. Raw `useInput` outside the primitive.
  if (rel !== PRIMITIVE) {
    for (let i = 0; i < lines.length; i++) {
      if (/\buseInput\b/.test(lines[i])) {
        violations.push({ rel, line: i + 1, what: "raw useInput — register through a surface hook instead" });
      }
    }
  }

  // 2. The removed cross-screen machinery.
  for (let i = 0; i < lines.length; i++) {
    for (const symbol of FORBIDDEN_SYMBOLS) {
      if (new RegExp(`\\b${symbol}\\b`).test(lines[i])) {
        violations.push({ rel, line: i + 1, what: `${symbol} was removed with the cross-screen guards` });
      }
    }
  }

  // 3. `useAgentKeybindings` belongs to the chat screen only.
  if (rel !== KEYBINDINGS_HOST && rel !== KEYBINDINGS_DEFINITION) {
    for (let i = 0; i < lines.length; i++) {
      if (/\buseAgentKeybindings\s*\(/.test(lines[i])) {
        violations.push({
          rel,
          line: i + 1,
          what: "useAgentKeybindings outside ChatKeybindings would outlive the main screen",
        });
      }
    }
  }

  // 4. Each named hook delegates with the surface it names, from its own file.
  for (const [hook, { surface, file }] of SURFACE_HOOKS) {
    if (rel !== file) continue;
    if (!new RegExp(`useSurfaceInput\\(\\s*["']${surface}["']`).test(text)) {
      violations.push({ rel, line: 1, what: `${hook} must delegate to useSurfaceInput("${surface}", …)` });
    }
  }

  // 5. A non-main screen must not reach into another screen's store — not in a `when` predicate,
  //    not in a key handler body. Barrels re-export every hook without calling one, so only call
  //    sites count as a declaration.
  const declared = [...SURFACE_HOOKS.keys()].filter((hook) => new RegExp(`\\b${hook}\\s*\\(`).test(text));
  for (const hook of declared) {
    const surface = SURFACE_HOOKS.get(hook).surface;
    if (surface === "main") continue;
    for (const store of FOREIGN_STORES.get(surface)) {
      const match = lines.findIndex((line) => new RegExp(`\\b${store}\\s*[(.]`).test(line));
      if (match !== -1) {
        violations.push({
          rel,
          line: match + 1,
          what: `a ${surface} screen reaches ${store} — cross-screen guards belong to the \`InputScope\``,
        });
      }
    }
  }
}

// 6. Every screen declares its scope, the chat's keybindings live inside the chat's one, and that
//    block does not also contain a panel (a provider wrapping the whole tree would put the chat's
//    handlers back under every panel — the exact regression this change removes).
const agent = files.find((f) => f.rel === "app/Agent.tsx");
if (!agent) {
  violations.push({ rel: "app/Agent.tsx", line: 1, what: "missing — the screens are wired here" });
} else {
  const agentText = stripComments(agent.raw);
  const blocks = scopeBlocks(agentText);
  const surfaces = new Set(blocks.map((b) => b.value));
  for (const { surface } of SURFACE_HOOKS.values()) {
    if (!surfaces.has(surface)) {
      violations.push({ rel: "app/Agent.tsx", line: 1, what: `no InputScopeProvider for "${surface}"` });
    }
  }

  const holders = blocks.filter((b) => b.body.includes("<ChatKeybindings"));
  if (holders.length !== 1) {
    violations.push({
      rel: "app/Agent.tsx",
      line: 1,
      what: `<ChatKeybindings must be rendered inside exactly one scope (found ${holders.length})`,
    });
  } else {
    const holder = holders[0];
    const line = agentText.slice(0, holder.start).split("\n").length;
    if (holder.value !== "main") {
      violations.push({ rel: "app/Agent.tsx", line, what: `<ChatKeybindings> sits in a "${holder.value}" scope` });
    }
    if (holder.body.includes("<InputScopeProvider")) {
      violations.push({
        rel: "app/Agent.tsx",
        line,
        what: "the main scope holding <ChatKeybindings> also contains a panel scope — the chat's handlers would stay subscribed under that panel",
      });
    }
  }
}

// 7. A host that renders an input-owning screen directly must provide its scope: outside a scope
//    the hooks are inert by design, so a missing wrapper is a keyboard-dead screen, not a warning.
for (const hostRoot of HOST_ROOTS) {
  let hostFiles;
  try {
    hostFiles = walkTsFiles(join(repoRoot, hostRoot));
  } catch {
    continue;
  }
  for (const file of hostFiles) {
    const rel = `${hostRoot}/${relative(join(repoRoot, hostRoot), file).replaceAll("\\", "/")}`;
    const text = stripComments(readFileSync(file, "utf8"));
    const rendered = SCOPED_SCREENS.filter((screen) => text.includes(screen));
    if (rendered.length > 0 && !text.includes("<InputScopeProvider")) {
      violations.push({
        rel,
        line: 1,
        what: `renders ${rendered.join(", ")} without an InputScopeProvider — its handlers would never subscribe`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error("@codent/app input routing violations:");
  for (const v of violations) console.error(`  ${v.rel}:${v.line}  ${v.what}`);
  console.error("\nSee openspec/specs/app-input-routing/spec.md.");
  process.exit(1);
}

console.log("app input-routing validation passed (0 violations)");
