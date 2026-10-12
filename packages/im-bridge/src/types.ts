/**
 * IM bridge — platform-agnostic chat types.
 *
 * A {@link ChatAdapter} translates one chat platform (Telegram, Slack, Discord,
 * Feishu, …) into these normalized primitives; the bridge runtime drives
 * AgentSessions on top. Adapters only translate — they never hold agent
 * references or implement business logic.
 */

import type { BUILTIN_TOOL_NAMES } from "@codent/core";

/** Unified conversation pointer. `threadId` maps Slack `thread_ts`, Telegram forum topics and Discord threads onto one field. */
export interface ChatTarget {
  chatId: string;
  threadId?: string;
  /** coarse chat kind; adapters set it, the runtime uses it for trigger policy. */
  chatType?: "private" | "group" | "channel";
}

/** Capabilities declared by an adapter — the runtime degrades on caps, never on platform names. */
export interface AdapterCaps {
  /** Platform renders markdown natively (Discord/Feishu cards). */
  markdown: boolean;
  /** In-place message editing is supported. */
  editMessage: boolean;
  /** Inline buttons / callback queries are supported. */
  buttons: boolean;
  /** Hard per-message text limit (Telegram 4096, Discord 2000, Slack 4000…). */
  maxTextLength: number;
  /** Streaming strategy the runtime should use. */
  streaming: "edit" | "native" | "append" | "none";
}

/**
 * An inbound attachment an adapter downloaded and handed to the runtime as a
 * model-ready data URL (no upload round-trip: the agent server receives it
 * inline in the dispatch body, exactly like a CLI/extension pasted image).
 */
export interface InboundAttachment {
  type: "image";
  /** `data:<mime>;base64,…` */
  dataUrl: string;
  mediaType: string;
  filename: string;
}

/** Normalized inbound message produced by an adapter. */
export interface InboundMessage {
  platform: string;
  chat: ChatTarget;
  userId: string;
  /** Bridge-level slash command name (without slash) when the message is one; undefined for plain text. */
  command?: "new" | "stop";
  text: string;
  /** Images attached to the message (may be empty; may accompany a caption or stand alone). */
  attachments?: InboundAttachment[];
  /** Raw platform payload for adapter-specific inspection. */
  raw: unknown;
}

/** A button rendered under a message. `data` must stay ≤64 bytes (Telegram `callback_data` hard limit). */
export interface Button {
  label: string;
  data: string;
}

export interface SendOptions {
  buttons?: Button[];
}

/** Reference to a message the adapter sent — needed for later in-place edits. */
export interface SentMessageRef {
  messageId: string;
  chat: ChatTarget;
}

/** Normalized button click produced by an adapter. */
export interface ButtonCallback {
  platform: string;
  chat: ChatTarget;
  /** Message the clicked button is attached to (for post-resolution edits). */
  messageId: string;
  userId: string;
  data: string;
  /** Acknowledge the callback to the platform (answerCallbackQuery / 3s envelope ack / deferUpdate…). */
  ack(): Promise<void>;
}

/**
 * Outbound primitives every platform adapter must implement.
 * Inbound handlers are registered once; the adapter fans platform events into them.
 */
export interface ChatAdapter {
  readonly platform: string;
  readonly caps: AdapterCaps;
  /** Connect to the platform (long-polling / WebSocket). Webhook-style adapters mount their route here too. */
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  onButton(handler: (cb: ButtonCallback) => Promise<void>): void;
  sendText(target: ChatTarget, text: string, options?: SendOptions): Promise<SentMessageRef>;
  sendButtons(target: ChatTarget, text: string, buttons: Button[]): Promise<SentMessageRef>;
  editMessage(target: ChatTarget, messageId: string, text: string, options?: SendOptions): Promise<void>;
  /** Best-effort typing indicator (Telegram `sendChatAction`, Discord `sendTyping`). */
  setTyping?(target: ChatTarget): Promise<void>;
}

/** A pending interaction surfaced to the user as buttons. */
export type PendingInteraction =
  | {
      kind: "approval";
      /** `ToolCallPart.approval.id` — answered via `dispatch({type:"respondApproval"})`. */
      approvalId: string;
      toolName: string;
      /** Short human summary of what is being approved. */
      question: string;
      /** Renderer segment the buttons ride on — the tool call's own message (keyed by `tool:${part.id}`). */
      segmentKey: string;
    }
  | {
      kind: typeof BUILTIN_TOOL_NAMES.askUser;
      /** Client-tool call id — answered via `dispatch({type:"addToolResult"})`. */
      toolCallId: string;
      question: string;
      options: string[];
      multiSelect: boolean;
      /** Renderer segment the buttons ride on — the tool call's own message (keyed by `tool:${part.id}`). */
      segmentKey: string;
    };

/** Payload encoded into button `data` (kept tiny for the 64-byte callback limit). */
export interface ButtonPayload {
  /** approve | deny | option (single-select) | toggle (multi-select) | submit (multi-select) */
  a: "y" | "n" | "o" | "t" | "s";
  /** PendingInteractionStore request id. */
  r: string;
  /** Option index for ask_user option / toggle buttons. */
  i?: number;
}
