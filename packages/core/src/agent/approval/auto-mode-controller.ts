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

  /** @returns new enabled state */
  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }
}
