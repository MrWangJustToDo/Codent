/**
 * Telegram adapter — grammY long-polling implementation of {@link ChatAdapter}.
 *
 * Translation only: normalizes messages/button clicks into bridge primitives
 * and maps outbound primitives onto the Telegram Bot API. Holds no agent state.
 *
 * Inbound images (largest `photo` size, or an image `document`) are downloaded
 * and handed over as base64 data URLs — Telegram file ids expire within
 * minutes, so the download must happen while handling the message.
 *
 * Loop prevention: messages from bots are never delivered. In group chats the
 * adapter is mention-only — text must @-mention the bot (or be a command
 * addressed to it) to reach the bridge.
 */

import { Bot } from "grammy";

import type {
  AdapterCaps,
  Button,
  ButtonCallback,
  ChatAdapter,
  ChatTarget,
  InboundAttachment,
  InboundMessage,
  SendOptions,
  SentMessageRef,
} from "../types.js";

const TG_MAX_TEXT = 4096;
const CALLBACK_DATA_LIMIT = 64;
const NOT_MODIFIED_PATTERN = /message is not modified/i;
const PARSE_ERROR_PATTERN = /can't parse entities/i;
/** getMe can hang indefinitely on unreachable networks — cap it so startup fails fast. */
const TG_INIT_TIMEOUT_MS = 10_000;
/** Inbound images larger than this are skipped (base64 + inline JSON would balloon). */
const TG_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Bounded flood-control retry (mirrors grammY autoRetry): honor retry_after, capped. */
const MAX_SEND_ATTEMPTS = 3;
const FLOOD_WAIT_CAP_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function floodRetryAfterMs(error: unknown): number {
  const params = (error as { parameters?: { retry_after?: number } } | null | undefined)?.parameters;
  const retryAfter = params?.retry_after;
  return typeof retryAfter === "number" && retryAfter > 0 ? Math.min(retryAfter * 1000, FLOOD_WAIT_CAP_MS) : 0;
}

/** Retry a send on 429 flood control (waiting retry_after); other errors surface immediately. */
async function withFloodRetry<T>(send: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt++) {
    try {
      return await send();
    } catch (error) {
      lastError = error;
      const waitMs = floodRetryAfterMs(error);
      if (waitMs <= 0) throw error; // not flood control — fail fast
      await sleep(waitMs + 500);
    }
  }
  throw lastError;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Bridge-level commands; Telegram-specific `/cmd@OtherBot` addressing is filtered. */
const COMMAND_PATTERN = /^\/(new|stop)(?:@([\w-]+))?(?:\s|$)/;

/** Registered via setMyCommands so the `/` menu reflects the bridge's commands. Keep in sync with COMMAND_PATTERN. */
const BRIDGE_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "new", description: "Clear the current session and start fresh" },
  { command: "stop", description: "Stop the running task" },
];

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline constructs with unambiguous Telegram HTML equivalents; the rest passes through escaped. */
function inlineMarkdownToHtml(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

/**
 * Convert a markdown subset to Telegram's HTML parse mode (the runtime's
 * assistant text is plain markdown — rendering it verbatim shows raw ```
 * fences / `**` markers). Conservative by design: only fenced code, inline
 * code, bold, ATX headers and links are mapped; everything else is escaped
 * as-is, so plain IM strings (`⏳`, tool status lines) never break parsing.
 */
function toTelegramHtml(text: string): string {
  // Odd segments lie between fences (possibly unterminated while streaming —
  // still renderable); the runtime's splitter already keeps fences whole.
  const parts = text.split(/```[a-zA-Z0-9_+-]*\n?/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    html +=
      i % 2 === 1
        ? `<pre><code>${escapeHtml(parts[i].replace(/\n$/, ""))}</code></pre>`
        : inlineMarkdownToHtml(parts[i]);
  }
  return html;
}

export interface TelegramAdapterOptions {
  botToken: string;
  onError?: (error: unknown) => void;
}

interface RawChat {
  id: number;
  type: string;
}

interface RawPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

interface RawDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface RawMessage {
  message_thread_id?: number;
  text?: string;
  caption?: string;
  /** Telegram sends every resolution of a photo; the largest entry is picked. */
  photo?: RawPhotoSize[];
  document?: RawDocument;
  from?: { id: number; is_bot: boolean } | undefined;
  chat: RawChat;
}

/** File id of the message's image: the largest `photo`, or an image `document`. */
function imageFileId(message: RawMessage): string | undefined {
  const photos = message.photo;
  if (photos && photos.length > 0) {
    return photos.reduce((best, size) => ((size.file_size ?? 0) >= (best.file_size ?? 0) ? size : best)).file_id;
  }
  const document = message.document;
  if (document && document.mime_type?.startsWith("image/")) return document.file_id;
  return undefined;
}

/** Best-effort image mime: the document's declared type, else the file extension. */
function imageMediaType(message: RawMessage, filePath: string): string {
  if (message.document?.mime_type?.startsWith("image/")) return message.document.mime_type;
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/jpeg";
}

function toTarget(chat: RawChat): ChatTarget {
  const chatType = chat.type === "private" ? "private" : chat.type === "channel" ? "channel" : "group";
  return { chatId: String(chat.id), chatType };
}

function toKeyboard(
  buttons: Button[] | undefined
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  // Wrap long rows (multi-select options + Submit can exceed one tidy row);
  // Telegram caps inline rows at 8 buttons, 3 keeps labels readable on mobile.
  const ROW_SIZE = 3;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += ROW_SIZE) {
    rows.push(buttons.slice(i, i + ROW_SIZE).map((button) => ({ text: button.label, callback_data: button.data })));
  }
  return { inline_keyboard: rows };
}

function clamp(text: string): string {
  // The runtime splits oversized replies (code-block aware); this is a last-resort guard.
  return text.length <= TG_MAX_TEXT ? text : `${text.slice(0, TG_MAX_TEXT - 1)}…`;
}

export class TelegramAdapter implements ChatAdapter {
  readonly platform = "telegram";
  readonly caps: AdapterCaps = {
    markdown: true, // rendered via parse_mode: "HTML" (see toTelegramHtml)
    editMessage: true,
    buttons: true,
    maxTextLength: TG_MAX_TEXT,
    streaming: "edit",
  };

  private readonly bot: Bot;
  private readonly botToken: string;
  private readonly onError: (error: unknown) => void;
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private buttonHandler: ((cb: ButtonCallback) => Promise<void>) | null = null;
  private started = false;

  constructor(options: TelegramAdapterOptions) {
    this.onError = options.onError ?? (() => {});
    this.botToken = options.botToken;
    this.bot = new Bot(options.botToken);
    this.bot.catch((error) => this.onError(error.error));
    this.registerHandlers();
  }

  async start(): Promise<void> {
    if (this.started) return;
    // populates botInfo.username used by mention checks. Fail fast (with a
    // clear message) instead of freezing startup on an unreachable network.
    await withTimeout(
      this.bot.init(),
      TG_INIT_TIMEOUT_MS,
      "Telegram getMe timed out — check TELEGRAM_BOT_TOKEN and network reachability to api.telegram.org"
    );
    // Expose the bridge's slash commands in the Telegram `/` menu. Best-effort:
    // a registration failure must not block startup (polling still works).
    await withFloodRetry(() => this.bot.api.setMyCommands(BRIDGE_COMMANDS)).catch((error) => this.onError(error));
    // bot.start() long-polls until stop(); it must not be awaited here.
    void this.bot
      .start({
        onStart: () => {
          // Long polling active — inbound delivery happens via handlers.
        },
      })
      .catch((error) => this.onError(error)); // e.g. invalid token — surface, never silent
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.bot.stop();
    this.started = false;
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  onButton(handler: (cb: ButtonCallback) => Promise<void>): void {
    this.buttonHandler = handler;
  }

  async sendText(target: ChatTarget, text: string, options?: SendOptions): Promise<SentMessageRef> {
    const extras = {
      ...(target.threadId !== undefined ? { message_thread_id: Number(target.threadId) } : {}),
      reply_markup: toKeyboard(options?.buttons),
    };
    return withFloodRetry(async () => {
      try {
        const message = await this.bot.api.sendMessage(target.chatId, clamp(toTelegramHtml(text)), {
          ...extras,
          parse_mode: "HTML",
        });
        return { messageId: String(message.message_id), chat: target };
      } catch (error) {
        if (error instanceof Error && PARSE_ERROR_PATTERN.test(error.message)) {
          // Malformed entities (e.g. a truncated fence) — degrade to plain text.
          const message = await this.bot.api.sendMessage(target.chatId, clamp(text), extras);
          return { messageId: String(message.message_id), chat: target };
        }
        throw error;
      }
    });
  }

  async sendButtons(target: ChatTarget, text: string, buttons: Button[]): Promise<SentMessageRef> {
    assertCallbackData(buttons);
    return this.sendText(target, text, { buttons });
  }

  async editMessage(target: ChatTarget, messageId: string, text: string, options?: SendOptions): Promise<void> {
    await withFloodRetry(async () => {
      // reply_markup must ALWAYS be explicit: editMessageText keeps the
      // existing inline keyboard when the parameter is omitted, so a
      // button-less edit (answered interaction / terminal tool line) would
      // silently leave the stale buttons clickable. An empty keyboard clears.
      const replyMarkup = options?.buttons ? toKeyboard(options.buttons) : { inline_keyboard: [] };
      try {
        await this.bot.api.editMessageText(target.chatId, Number(messageId), clamp(toTelegramHtml(text)), {
          reply_markup: replyMarkup,
          parse_mode: "HTML",
        });
      } catch (error) {
        // Editing with identical content is a no-op condition, not a failure.
        if (error instanceof Error && NOT_MODIFIED_PATTERN.test(error.message)) return;
        if (error instanceof Error && PARSE_ERROR_PATTERN.test(error.message)) {
          await this.bot.api.editMessageText(target.chatId, Number(messageId), clamp(text), {
            reply_markup: replyMarkup,
          });
          return;
        }
        throw error;
      }
    });
  }

  async setTyping(target: ChatTarget): Promise<void> {
    await this.bot.api.sendChatAction(target.chatId, "typing");
  }

  private registerHandlers(): void {
    this.bot.on("message", async (ctx) => {
      const message = ctx.message as RawMessage | undefined;
      const handler = this.messageHandler;
      if (!message || !handler) return;
      if (message.from?.is_bot) return; // loop prevention: never deliver bot messages

      const target = toTarget(message.chat);
      const isPrivate = target.chatType === "private";
      const threadId = message.message_thread_id !== undefined ? String(message.message_thread_id) : undefined;
      if (threadId !== undefined) target.threadId = threadId;

      const text = message.text ?? message.caption ?? "";
      const command = this.extractCommand(text, isPrivate);
      // Group chats are mention-only: require an @-mention for both text and commands.
      if (!isPrivate && !this.mentionsBot(text)) return;

      // Download attached images BEFORE handing off — Telegram file ids are
      // short-lived. Best-effort: a failed download drops the attachment, never
      // the whole message.
      const attachments = await this.collectAttachments(message).catch((error): InboundAttachment[] => {
        this.onError(error);
        return [];
      });

      await handler({
        platform: this.platform,
        chat: target,
        userId: String(message.from?.id ?? ""),
        ...(command !== undefined ? { command } : {}),
        text,
        ...(attachments.length > 0 ? { attachments } : {}),
        raw: ctx.message,
      });
    });

    this.bot.on("callback_query:data", async (ctx) => {
      const handler = this.buttonHandler;
      if (!handler) return;
      const query = ctx.callbackQuery;
      const message = query.message as { chat: RawChat; message_id: number } | undefined;
      if (!message) {
        await ctx.answerCallbackQuery({ text: "Unsupported callback target" });
        return;
      }
      await handler({
        platform: this.platform,
        chat: toTarget(message.chat),
        messageId: String(message.message_id),
        userId: String(query.from.id),
        data: query.data,
        ack: async () => {
          await ctx.answerCallbackQuery();
        },
      });
    });
  }

  private extractCommand(text: string, isPrivate: boolean): InboundMessage["command"] {
    const match = COMMAND_PATTERN.exec(text);
    if (!match) return undefined;
    const [, name, addressedTo] = match;
    // In groups, `/new@OtherBot` belongs to another bot — ignore it.
    if (!isPrivate && addressedTo && addressedTo !== this.bot.botInfo?.username) return undefined;
    return name as InboundMessage["command"];
  }

  /**
   * Download the message's image (if any) and return it as a data URL. Returns
   * an empty list for text-only messages, oversized files and non-image
   * documents; throws only on transport failures (caught by the caller).
   */
  private async collectAttachments(message: RawMessage): Promise<InboundAttachment[]> {
    const fileId = imageFileId(message);
    if (!fileId) return [];
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) return [];
    if (file.file_size !== undefined && file.file_size > TG_MAX_IMAGE_BYTES) {
      this.onError(
        new Error(`Telegram image skipped: ${file.file_size} bytes exceeds the ${TG_MAX_IMAGE_BYTES}-byte cap`)
      );
      return [];
    }
    const response = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const mediaType = imageMediaType(message, file.file_path);
    const filename = message.document?.file_name ?? file.file_path.split("/").pop() ?? "image";
    return [{ type: "image", dataUrl: `data:${mediaType};base64,${buffer.toString("base64")}`, mediaType, filename }];
  }

  private mentionsBot(text: string): boolean {
    const username = this.bot.botInfo?.username;
    return username !== undefined && text.includes(`@${username}`);
  }
}

function assertCallbackData(buttons: Button[]): void {
  for (const button of buttons) {
    if (button.data.length > CALLBACK_DATA_LIMIT) {
      throw new Error(`Button callback_data exceeds Telegram's ${CALLBACK_DATA_LIMIT}-byte limit: ${button.data}`);
    }
  }
}
