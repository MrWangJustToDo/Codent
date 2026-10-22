import type { ToModelOutputFn } from "../../tools/runtime/model-output.js";

export interface ToModelOutputRegistry {
  get(toolName: string): ToModelOutputFn | undefined;
}
