import { parseModelsConfig } from "@codent/core";

import { useCoreEnv } from "../context/core-env-context.js";
import { useCommandOutput } from "../hooks/use-command-output.js";
import { useConfigEditor } from "../hooks/use-config-editor.js";
import { applyModelsConfigEdit, describeEditedEntry, selectEditedEntry } from "../utils/apply-models-config-edit.js";

import { ConfigEditor } from "./ConfigEditor.js";

import type { ModelsConfig } from "@codent/core";

/**
 * The model-config wizard, opened over the running app by `/settings config`.
 *
 * Seeded from the entry the session is actually running on (`modelsConfig.active`) so the form
 * opens on the live connection, and saved through {@link applyModelsConfigEdit}, which merges the
 * draft into the existing file (other entries and `global` survive) and reloads the pipeline in
 * place — no restart, no session teardown.
 *
 * It lives beside `ConfigEditor` rather than inside `Agent` because it is a full-screen swap the
 * app returns into, not part of the transcript. `Agent` owns layout and the run loop; this owns
 * one modal's lifecycle.
 */
export const ConfigEditorOverlay = () => {
  const close = useConfigEditor.getActions().close;
  const showOutput = useCommandOutput.getActions().show;
  // The workspace being edited is the host's env, not whatever was registered last process-wide.
  const env = useCoreEnv();

  // The wizard's draft is seeded once, at mount, and the overlay is unmounted on
  // close (Agent returns early), so the seeded entry can be read directly.
  const entry = useConfigEditor((s) => {
    void s.view;
    return selectEditedEntry().entry;
  });

  const handleDone = (config: ModelsConfig): void => {
    close();
    const { entryIndex } = selectEditedEntry();
    void applyModelsConfigEdit(config, { entryIndex, env }).then((result) => {
      if (!result.ok) {
        showOutput("/settings config", `Config not saved: ${result.error}`);
        return;
      }
      showOutput(
        "/settings config",
        [
          `Saved .agents/config/models.json (entry ${entryIndex}: ${describeEditedEntry(result.loaded, entryIndex)})`,
          result.reloadError
            ? `Not live yet — reloading failed: ${result.reloadError}\nRestart to apply it.`
            : result.model
              ? `Live model: ${result.model} — run /models to re-pick if the new list dropped it.`
              : "No model id in the entry — add one to select a model.",
        ].join("\n")
      );
    });
  };

  return (
    <ConfigEditor
      mode="edit"
      initialEntry={entry}
      onCancel={close}
      onDone={handleDone}
      parseModelsConfig={parseModelsConfig}
      saveModelsConfig={async (config) => {
        // The write is owned by `applyModelsConfigEdit` (it merges the draft into
        // the existing file first), so the editor's own save is a no-op that just
        // resolves — the merge needs the draft, not the raw write.
        void config;
      }}
    />
  );
};
