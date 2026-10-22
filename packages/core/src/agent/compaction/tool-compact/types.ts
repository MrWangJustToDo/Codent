import type { ToModelOutputFn } from "../../tools/runtime/contract.js";

export interface ToModelOutputRegistry {
  get(toolName: string): ToModelOutputFn | undefined;
}
