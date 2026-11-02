/**
 * Plan-mode phase transitions.
 *
 * One family of {@link AgentEventPayloadMap} (`agent-event-payloads.ts`), split so the map stays
 * readable and no single file sits at the line ceiling.
 */

import type { PlanPhase } from "./payload-primitives.js";

export type PlanEventPayloads = {
  "plan:enter": {
    phase?: PlanPhase;
  };
  "plan:ready": {
    phase?: PlanPhase;
    stepCount?: number;
    preservedExistingTodos?: boolean;
    todosSeeded?: boolean;
    planFilePath?: string | null;
  };
  "plan:execute": {
    phase?: PlanPhase;
    stepCount?: number;
    replacedExistingTodos?: boolean;
    planFilePath?: string | null;
  };
  "plan:cancel-execution": {
    phase?: PlanPhase;
    stepCount?: number;
  };
  "plan:todo-replaced": {
    stepCount?: number;
  };
  "plan:retro": {
    phase?: PlanPhase;
    stepCount?: number;
    planFilePath?: string | null;
  };
  "plan:complete": {
    phase?: PlanPhase;
    planFilePath?: string | null;
    stepCount?: number;
  };
  "plan:exit": {
    phase?: PlanPhase;
  };
};
