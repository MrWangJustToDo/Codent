/**
 * Session-scoped switch to skip all `needsApproval` tool prompts (auto / YOLO mode).
 */

export class AutoModeController {
  private enabled = false;

  /** `onChange` receives the NEW state (the controller only fires on an actual change). */
  constructor(private readonly onChange?: (enabled: boolean) => void) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.onChange?.(enabled);
  }

  /**
   * Adopt the persisted flag during a session load, WITHOUT firing `onChange`.
   *
   * `setEnabled` is a live user action: it emits `mode:change` and persists. During a restore the
   * log sink is already the TARGET but the event envelope still names the departure (adoption is
   * later), so the row landed in the target's file claiming to describe the session being left —
   * and the persist was refused. `session:restore` is the record of this transition.
   */
  restore(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** @returns new enabled state */
  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }
}
