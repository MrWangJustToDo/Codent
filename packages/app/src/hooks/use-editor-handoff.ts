import { createState } from "reactivity-store";

/**
 * State that has to outlive the UI across a host editor handoff.
 *
 * The handoff unmounts the whole app (the editor needs the terminal), so nothing component-local can
 * carry the outcome back: the mount that resumes is a different React tree. Both fields are written
 * before the UI goes down and read by the panel after it comes back.
 *
 * - `roundTrip` is the "a file was edited, the caches are stale" marker. The panel consumes it on
 *   mount and reuses its own manual-refresh path (`r`), so an editor save and a manual refresh cannot
 *   drift apart.
 * - `notice` is the failure a user must see *after* resume (editor binary missing, non-zero exit, or a
 *   refusal because the workspace is remote). It is a notice rather than a throw because the terminal
 *   the failure would be printed to is the one the editor was supposed to own.
 */
export interface EditorRoundTrip {
  /** Absolute path handed to the editor. */
  path: string;
}

export const useEditorHandoff = createState(
  () => ({
    roundTrip: null as EditorRoundTrip | null,
    notice: null as string | null,
  }),
  {
    withActions: (s) => ({
      /** Record that a file is being opened in the host editor; clears any stale failure notice. */
      beginRoundTrip: (path: string) => {
        s.roundTrip = { path };
        s.notice = null;
      },
      /** Take the marker (one refresh per handoff) — `null` when there is nothing pending. */
      consumeRoundTrip: (): EditorRoundTrip | null => {
        const roundTrip = s.roundTrip;
        s.roundTrip = null;
        return roundTrip;
      },
      /** Report a handoff outcome; `null` clears it. Shown by the workspace panel footer. */
      setNotice: (notice: string | null) => {
        s.notice = notice;
      },
    }),

    withDeepSelector: false,

    withStableSelector: true,
  }
);
