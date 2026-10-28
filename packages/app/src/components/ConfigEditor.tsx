import { errorMessage } from "@codent/core";
import { Box, Text } from "ink";
import { useState } from "react";

import { useMainInput } from "../hooks/input";
import { useSize } from "../hooks/use-size.js";
import { WelcomePanel, welcomeTierForWidth } from "../layout/WelcomePanel.js";
import { BG, COLORS } from "../theme/colors.js";
import { KeyLabel, listNavHint, newlineEnterLabel } from "../utils/keyboard-labels.js";

import { FullBox } from "./FullBox.js";
import { Spinner } from "./Spinner.js";
import { TextInput } from "./TextInput.js";

import type { ModelsConfig, ModelsConfigEntry } from "@codent/core";

// ============================================================================
// ConfigEditor — model configuration editor
//
// Shared by all hosts (CLI etc.). A multi-step form that builds a minimal
// `models.json` with a single `direct` entry. The write/parse functions are
// injected so the app package stays decoupled from the concrete persistence
// implementation (core is a peer dependency); the CLI supplies core's
// parseModelsConfig / saveModelsConfig. After completion the config is written
// and the rest of startup reads it back through the same unified pipeline.
//
// Two modes, one form:
// - `firstRun` (default, host bootstrap): nothing exists yet, so the written
//   config IS the file, and `Step N/M` plus the "First-Run" copy set that up.
// - `edit` (`/settings config` mid-session): the host seeds the draft from the
//   current `models.json` and treats the form's output as the edited entry's
//   connection (see `utils/merge-models-config.ts`), so the save keeps the rest
//   of the file. The chrome drops the first-run framing.
//
// TODO(models-config): this wizard is the file's only UI, and it can only reach `models[i]`
// (`style` / `baseURL` / `apiKey` / `models`). It has NO field for `global.toolConfig` (websearch
// keys/provider), so that block is hand-edit-only; `firstRun` also writes a document with neither
// `global` nor `active` (`parseDraft` below), so a fresh install has no place for it to live.
//
// It also only ever emits a `direct` entry, so the schema's other member — `remote-provider`
// (`RemoteProviderConfigEntry`: a server URL that holds the keys) — has no UI at all and must be
// hand-written. Same for adding a SECOND entry: the edit path replaces the active one
// (`mergeModelsConfig`), so a multi-entry config is authored outside the app.
// ============================================================================

type StyleChoice = "openai" | "anthropic";

export const STYLE_OPTIONS: readonly StyleChoice[] = ["openai", "anthropic"];

type Step = "style" | "baseURL" | "apiKey" | "models" | "confirm";

/** Ordered steps — drives the `Step N/M` progress indicator. */
const STEP_ORDER: readonly Step[] = ["style", "baseURL", "apiKey", "models", "confirm"];

export interface ConfigEditorProps {
  onDone: (config: ModelsConfig) => void;
  onCancel: () => void;
  /**
   * Persist a validated config to the file source. Injected by the host so the
   * app package does not depend on a specific storage implementation.
   */
  saveModelsConfig: (config: ModelsConfig) => Promise<void>;
  /** Validate + normalize a draft into a ModelsConfig, or null when invalid. */
  parseModelsConfig: (raw: string) => ModelsConfig;
  /**
   * `firstRun` (default) writes the whole file; `edit` is a re-edit of an
   * existing config and says so in the chrome. The merge itself happens in the
   * caller's `saveModelsConfig`, which receives only the draft.
   */
  mode?: ConfigEditorMode;
  /** Seed the form from the entry being edited (defaults to a blank draft). */
  initialEntry?: ModelsConfigEntry;
}

export type ConfigEditorMode = "firstRun" | "edit";

interface Draft {
  style: StyleChoice;
  baseURL: string;
  apiKey: string;
  modelsCsv: string;
}

const DEFAULT_DRAFT: Draft = {
  style: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey: "",
  modelsCsv: "",
};

/**
 * Seed the draft from the entry being edited. Only a `direct` entry has
 * connection fields to show; a `remote-provider` entry is proxied server-side and
 * has none, so it falls back to the blank draft (the user is creating the direct
 * entry that replaces it).
 */
function draftFromEntry(entry: ModelsConfigEntry | undefined): Draft {
  if (!entry || entry.type !== "direct") return DEFAULT_DRAFT;
  return {
    style: entry.style,
    baseURL: entry.baseURL,
    apiKey: entry.apiKey ?? "",
    modelsCsv: (entry.models ?? []).join(", "),
  };
}

function styleLabel(style: StyleChoice): string {
  return style === "openai" ? "openai" : "anthropic";
}

function parseDraft(draft: Draft, parse: ConfigEditorProps["parseModelsConfig"]): ModelsConfig | null {
  const models = draft.modelsCsv
    .split(/[,\n]/)
    .map((m) => m.trim())
    .filter(Boolean);
  if (models.length === 0) return null;
  if (!draft.baseURL.trim()) return null;
  try {
    // Emits `{ models: [entry] }` only — no `global`, no `active`. Harmless on first run (there is
    // nothing to lose); a first-run install simply has no `active.model` until a save through the
    // edit path writes one, and the pipeline then starts at entry 0 / the entry's first id.
    return parse(
      JSON.stringify({
        models: [
          {
            type: "direct",
            style: draft.style,
            baseURL: draft.baseURL.trim(),
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
            models,
          },
        ],
      })
    );
  } catch {
    return null;
  }
}

/** Confirm-step summary row — fixed-width label column, matching Help's layout. */
const SummaryRow = ({ label, value }: { label: string; value: string }) => (
  <Box>
    <Box width={10}>
      <Text color={COLORS.muted} dimColor>
        {label}
      </Text>
    </Box>
    <Text color={COLORS.text}>{value}</Text>
  </Box>
);

export const ConfigEditor = ({
  onDone,
  onCancel,
  saveModelsConfig,
  parseModelsConfig,
  mode = "firstRun",
  initialEntry,
}: ConfigEditorProps) => {
  const editing = mode === "edit";
  const [step, setStep] = useState<Step>("style");
  const [draft, setDraft] = useState<Draft>(() => draftFromEntry(initialEntry));
  const [styleIndex, setStyleIndex] = useState(() =>
    Math.max(0, STYLE_OPTIONS.indexOf(draftFromEntry(initialEntry).style))
  );
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // The editor renders before `Agent` (which normally initializes terminal
  // size), so seed the shared size store here too.
  useSize.getActions().useInitTerminalSize();
  const screenWidth = useSize((s) => s.state.screenWidth);
  const tier = welcomeTierForWidth(screenWidth);
  const paddingX = tier === "narrow" ? 1 : 3;
  const innerWidth = Math.max(0, screenWidth - paddingX * 2);
  // Chrome (title + hints) collapses earlier than the logo so rows never crowd.
  const compactChrome = screenWidth < 72;

  function commitText(): void {
    if (step === "baseURL") {
      setDraft((d) => ({ ...d, baseURL: text }));
      setText(draft.apiKey);
      setStep("apiKey");
      setError("");
    } else if (step === "apiKey") {
      setDraft((d) => ({ ...d, apiKey: text }));
      setText(draft.modelsCsv);
      setStep("models");
      setError("");
    } else if (step === "models") {
      setDraft((d) => ({ ...d, modelsCsv: text }));
      const config = parseDraft({ ...draft, modelsCsv: text }, parseModelsConfig);
      if (!config) {
        setError("Provide at least one model id (one per line).");
        return;
      }
      setStep("confirm");
      setError("");
    }
  }

  // The wizard's own keys stop on the text steps: there the focused <TextInput> owns the keyboard
  // (including Esc, which it forwards to `onCancel`), so at most one handler sees a keystroke.
  const isTextStep = step === "baseURL" || step === "apiKey" || step === "models";

  useMainInput(
    (input, key) => {
      // Not a sub-surface gate: saving is a transient state where no key should do anything, but the
      // handler stays subscribed so raw mode stays on until the wizard swaps screens.
      if (saving) return;

      if (key.escape) {
        onCancel();
        return;
      }

      if (step === "style") {
        if (key.upArrow) {
          setStyleIndex((i) => Math.max(0, i - 1));
          setError("");
          return;
        }
        if (key.downArrow) {
          setStyleIndex((i) => Math.min(STYLE_OPTIONS.length - 1, i + 1));
          setError("");
          return;
        }
        if (key.return) {
          setDraft((d) => ({ ...d, style: STYLE_OPTIONS[styleIndex] }));
          setStep("baseURL");
          setText(draft.baseURL);
          setError("");
        }
        return;
      }

      if (step === "confirm") {
        if (key.return) {
          void (async () => {
            const config = parseDraft(draft, parseModelsConfig);
            if (!config) return;
            setSaving(true);
            try {
              await saveModelsConfig(config);
              onDone(config);
            } catch (err) {
              setSaving(false);
              setError(errorMessage(err));
            }
          })();
        } else if (input === "e" || input === "E") {
          setStep("baseURL");
          setText(draft.baseURL);
          setError("");
        }
        return;
      }
    },
    { when: !isTextStep }
  );

  // ============================================================================
  // Step chrome (title, progress, hint)
  // ============================================================================

  const stepNo = STEP_ORDER.indexOf(step) + 1;

  const pageTitle = editing
    ? compactChrome
      ? "Model Config"
      : "Model Configuration"
    : compactChrome
      ? "First-Run Setup"
      : "First-Run Model Configuration";

  const stepTitle =
    step === "style"
      ? "Provider style"
      : step === "baseURL"
        ? compactChrome
          ? "Base URL"
          : `Base URL for the ${styleLabel(draft.style)} API`
        : step === "apiKey"
          ? compactChrome
            ? "API key (optional)"
            : "API key (empty to skip)"
          : step === "models"
            ? "Model ids"
            : editing
              ? "Ready to save"
              : "Ready to write config";

  const stepHint =
    step === "style"
      ? compactChrome
        ? `(${KeyLabel.upDown} ${KeyLabel.enter} ${KeyLabel.esc})`
        : listNavHint("accept", "cancel")
      : step === "baseURL" || step === "apiKey"
        ? compactChrome
          ? `(${KeyLabel.enter} · ${KeyLabel.esc})`
          : `(${KeyLabel.enter} to continue, ${KeyLabel.esc} to cancel)`
        : step === "models"
          ? compactChrome
            ? `(${newlineEnterLabel()} · ${KeyLabel.enter} · ${KeyLabel.esc})`
            : `(${newlineEnterLabel()} for newline, ${KeyLabel.enter} to continue, ${KeyLabel.esc} to cancel)`
          : "";

  const modelList = draft.modelsCsv
    .split(/[,\n]/)
    .map((m) => m.trim())
    .filter(Boolean)
    .join(", ");

  return (
    <FullBox flexDirection="column">
      <WelcomePanel variant="config" screenWidth={screenWidth} />

      <Box flexDirection="column" paddingX={paddingX}>
        <Text color={BG.border}>{"─".repeat(innerWidth)}</Text>

        {/* Title + progress */}
        <Box marginTop={1} justifyContent="space-between" width="100%" flexShrink={0}>
          <Box flexShrink={1}>
            <Text bold color={COLORS.primary} wrap="truncate">
              {pageTitle}
            </Text>
          </Box>
          <Text color={COLORS.muted} dimColor>
            Step {stepNo}/{STEP_ORDER.length}
          </Text>
        </Box>

        {/* Step name + hint */}
        <Box justifyContent="space-between" width="100%" flexShrink={0}>
          <Box flexShrink={1}>
            <Text color={COLORS.text} wrap="truncate">
              {stepTitle}
            </Text>
          </Box>
          {stepHint ? (
            <Text color={COLORS.muted} dimColor wrap="truncate">
              {stepHint}
            </Text>
          ) : null}
        </Box>

        {/* Body */}
        {step === "style" && (
          <Box flexDirection="column" marginTop={1}>
            {STYLE_OPTIONS.map((s, i) => {
              const selected = i === styleIndex;
              return (
                <Box key={s} height={1}>
                  <Text color={selected ? COLORS.primary : undefined} bold={selected}>
                    {selected ? "❯ " : "  "}
                    {styleLabel(s)}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}

        {step === "baseURL" && (
          <Box marginTop={1}>
            <TextInput
              value={text}
              onChange={setText}
              onSubmit={commitText}
              onEscape={onCancel}
              disabled={saving}
              placeholder="https://..."
            />
          </Box>
        )}

        {step === "apiKey" && (
          <Box marginTop={1}>
            <TextInput
              value={text}
              onChange={setText}
              onSubmit={commitText}
              onEscape={onCancel}
              disabled={saving}
              placeholder="(none)"
              mask
            />
          </Box>
        )}

        {step === "models" && (
          <Box marginTop={1}>
            <TextInput
              value={text}
              onChange={setText}
              onSubmit={commitText}
              onEscape={onCancel}
              disabled={saving}
              placeholder="gpt-4o"
            />
          </Box>
        )}

        {step === "confirm" && (
          <>
            <Box flexDirection="column" marginTop={1}>
              <SummaryRow label="style" value={styleLabel(draft.style)} />
              <SummaryRow label="baseURL" value={draft.baseURL.trim() || "(none)"} />
              <SummaryRow label="apiKey" value={draft.apiKey.trim() ? "••••" : "(none)"} />
              <SummaryRow label="models" value={modelList} />
            </Box>

            <Box flexDirection="column" marginTop={1}>
              <Text color={BG.border}>{"─".repeat(innerWidth)}</Text>
              <Box marginTop={1}>
                <Text color={COLORS.primary}>
                  {KeyLabel.enter} {editing ? "to save" : "to save & start"}
                </Text>
                <Text dimColor>
                  {compactChrome ? ` · e edit · ${KeyLabel.esc} cancel` : ` · e to edit · ${KeyLabel.esc} to cancel`}
                </Text>
              </Box>
            </Box>
          </>
        )}

        {saving && (
          <Box marginTop={1}>
            <Spinner text="Saving config…" />
          </Box>
        )}
        {error && (
          <Box marginTop={1}>
            <Text color={COLORS.danger}>✖ {error}</Text>
          </Box>
        )}
      </Box>
    </FullBox>
  );
};
