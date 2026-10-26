/**
 * Typed rejection of an extension model completion (`ctx.llm`).
 *
 * Lives on the extension side of the layer boundary (not in `managers/`, where the completion is
 * implemented) because both the extension context and its callers branch on it, and `agent` must not
 * import `managers`.
 */
export type ExtensionLlmErrorCode = "no-adapter" | "unknown-model" | "budget-exceeded" | "bad-request";

export class ExtensionLlmError extends Error {
  readonly code: ExtensionLlmErrorCode;

  constructor(code: ExtensionLlmErrorCode, message: string) {
    super(message);
    this.name = "ExtensionLlmError";
    this.code = code;
  }
}
