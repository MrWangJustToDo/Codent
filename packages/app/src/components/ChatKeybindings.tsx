import { useAgentKeybindings } from "../hooks/use-agent-keybindings.js";

import type { UseAgentKeybindingsOptions } from "../hooks/use-agent-keybindings.js";

/**
 * Registers the main screen's keybindings and renders nothing.
 *
 * It exists as a component because that is what binds registration to a screen: `Agent` renders it
 * inside the `main` `InputScope`, so the five mode handlers are subscribed only while the chat is
 * on screen. The state they act on lives in `useAgentInputControls`, which stays at `Agent` level
 * because approvals and `ask_user` prompts must still update while a panel is up.
 */
export const ChatKeybindings = ({ options }: { options: UseAgentKeybindingsOptions }) => {
  useAgentKeybindings(options);
  return null;
};
