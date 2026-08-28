// PM-only mobile projection of the canonical Ask thread. The transport may
// receive requests and manual Allow/Deny decisions, but it never receives a
// worker toolset, a shell, a second session, or credentials beyond its own
// platform token.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { redactSecretsInText } from "./redact.ts";
import {
  parsePocketDecision,
  parsePocketText,
  pocketApprovalRequestText,
  pocketDecisionId,
  pocketHelpText,
  pocketUnsupportedCommandText,
  type PocketActionReply,
  type PocketConnectionState,
  type PocketHandlers,
} from "./pocket-shared.ts";

const TELEGRAM_TEXT_LIMIT = 3_500;
const MAX_RECEIPTS = 200;

export type { PocketActionReply, PocketConnectionState, PocketHandlers, PocketTurnReply } from "./pocket-shared.ts";

export interface PocketStatus {
  provider: "telegram";
  configured: boolean;
  enabled: boolean;
  pilotReady: boolean;
  state: PocketConnectionState;
  detail: string;
  allowedUserId: string;
  botUsername: string | null;
  lastInboundAt: number | null;
  deliveryUncertain: boolean;
}

export interface PocketGatewayConfig {
  enabled: boolean;
  pilotReady: boolean;
  token?: string;
  allowedUserId?: string;
}

type FetchLike = typeof fetch;

interface TelegramUser {
  id: number;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
}

interface InboundReceipt {
  updateId: number;
  kind: "message" | "decision" | "ignored";
  state: "claimed" | "completed" | "failed" | "interrupted";
  at: number;
}

interface OutboundReceipt {
  id: string;
  digest: string;
  state: "sending" | "delivered" | "effect-unknown";
  at: number;
}

interface PocketLedger {
  version: 1;
  nextUpdateId: number;
  lastInboundAt?: number;
  inbound: InboundReceipt[];
  outbound: OutboundReceipt[];
}

function emptyLedger(): PocketLedger {
  return { version: 1, nextUpdateId: 0, inbound: [], outbound: [] };
}

export function normalizeTelegramUserId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return /^[1-9]\d{4,19}$/.test(clean) ? clean : null;
}

export function normalizeTelegramBotToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return /^\d{5,20}:[A-Za-z0-9_-]{20,128}$/.test(clean) ? clean : null;
}

function responseError(status: number): Error {
  return Object.assign(new Error("Telegram did not accept the pocket request."), {
    status: status === 401 || status === 403 ? 401 : 502,
    retryable: status !== 401 && status !== 403,
  });
}

async function telegramCall<T>(input: {
  token: string;
  method: string;
  payload?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  apiBase?: string;
  signal?: AbortSignal;
}): Promise<T> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${input.apiBase ?? "https://api.telegram.org"}/bot${input.token}/${input.method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input.payload ?? {}),
      signal: input.signal,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw Object.assign(new Error("Telegram could not be reached."), { status: 502, retryable: true });
  }
  const body = await response.json().catch(() => null) as TelegramResponse<T> | null;
  if (!response.ok || !body?.ok || body.result === undefined) throw responseError(response.status);
  return body.result;
}

export async function verifyTelegramPocketToken(
  token: string,
  options?: { fetchImpl?: FetchLike; apiBase?: string; signal?: AbortSignal },
): Promise<{ username: string }> {
  const normalized = normalizeTelegramBotToken(token);
  if (!normalized) throw Object.assign(new Error("Enter a valid Telegram bot token."), { status: 400 });
  const controller = options?.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), 15_000) : null;
  try {
    const bot = await telegramCall<TelegramUser>({
      token: normalized,
      method: "getMe",
      fetchImpl: options?.fetchImpl,
      apiBase: options?.apiBase,
      signal: options?.signal ?? controller?.signal,
    });
    return { username: typeof bot.username === "string" && bot.username.trim() ? bot.username.trim() : "Telegram bot" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseLedger(raw: unknown): PocketLedger {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pocket state is invalid");
  const value = raw as Partial<PocketLedger>;
  if (
    value.version !== 1 || !Number.isSafeInteger(value.nextUpdateId) || Number(value.nextUpdateId) < 0 ||
    !Array.isArray(value.inbound) || !Array.isArray(value.outbound)
  ) throw new Error("pocket state is invalid");
  const inbound = value.inbound.map((item) => {
    if (
      !item || !Number.isSafeInteger(item.updateId) || item.updateId < 0 ||
      !["message", "decision", "ignored"].includes(item.kind) ||
      !["claimed", "completed", "failed", "interrupted"].includes(item.state) ||
      !Number.isFinite(item.at)
    ) throw new Error("pocket inbound receipt is invalid");
    return { ...item };
  });
  const outbound = value.outbound.map((item) => {
    if (
      !item || typeof item.id !== "string" || !/^[a-f0-9]{24}$/.test(item.id) ||
      typeof item.digest !== "string" || !/^[a-f0-9]{64}$/.test(item.digest) ||
      !["sending", "delivered", "effect-unknown"].includes(item.state) ||
      !Number.isFinite(item.at)
    ) throw new Error("pocket outbound receipt is invalid");
    return { ...item };
  });
  return {
    version: 1,
    nextUpdateId: Number(value.nextUpdateId),
    ...(Number.isFinite(value.lastInboundAt) ? { lastInboundAt: Number(value.lastInboundAt) } : {}),
    inbound: inbound.slice(-MAX_RECEIPTS),
    outbound: outbound.slice(-MAX_RECEIPTS),
  };
}

function splitTelegramText(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return ["RealBud finished without a text reply. Open Ask to review the result."];
  const chunks: string[] = [];
  let remaining = clean;
  while (remaining.length > TELEGRAM_TEXT_LIMIT) {
    let cut = remaining.lastIndexOf("\n", TELEGRAM_TEXT_LIMIT);
    if (cut < TELEGRAM_TEXT_LIMIT / 2) cut = remaining.lastIndexOf(" ", TELEGRAM_TEXT_LIMIT);
    if (cut < TELEGRAM_TEXT_LIMIT / 2) cut = TELEGRAM_TEXT_LIMIT;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export class PocketGateway {
  private readonly handlers: PocketHandlers;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;
  private readonly stateFile: string;
  private readonly now: () => number;
  private readonly autoPoll: boolean;
  private readonly onStatusChange?: (status: PocketStatus) => void;
  private ledger: PocketLedger = emptyLedger();
  private config: Required<Pick<PocketGatewayConfig, "enabled" | "pilotReady">> & { token: string; allowedUserId: string } = {
    enabled: false,
    pilotReady: false,
    token: "",
    allowedUserId: "",
  };
  private current: PocketStatus = {
    provider: "telegram",
    configured: false,
    enabled: false,
    pilotReady: false,
    state: "off",
    detail: "Pocket is off.",
    allowedUserId: "",
    botUsername: null,
    lastInboundAt: null,
    deliveryUncertain: false,
  };
  private running = false;
  private requestController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private cancelRetry: (() => void) | null = null;

  constructor(options: {
    handlers: PocketHandlers;
    stateFile?: string;
    fetchImpl?: FetchLike;
    apiBase?: string;
    now?: () => number;
    autoPoll?: boolean;
    onStatusChange?: (status: PocketStatus) => void;
  }) {
    this.handlers = options.handlers;
    this.stateFile = options.stateFile ?? join(DATA_DIR, "pocket-state.json");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = options.apiBase ?? "https://api.telegram.org";
    this.now = options.now ?? Date.now;
    this.autoPoll = options.autoPoll ?? true;
    this.onStatusChange = options.onStatusChange;
  }

  status(): PocketStatus {
    return { ...this.current };
  }

  private setStatus(patch: Partial<PocketStatus>): void {
    this.current = { ...this.current, ...patch };
    this.onStatusChange?.(this.status());
  }

  private loadLedger(): { interrupted: boolean } {
    this.ledger = existsSync(this.stateFile)
      ? parseLedger(JSON.parse(readFileSync(this.stateFile, "utf8")))
      : emptyLedger();
    let interrupted = false;
    for (const receipt of this.ledger.inbound) {
      if (receipt.state === "claimed") {
        receipt.state = "interrupted";
        interrupted = true;
      }
    }
    for (const receipt of this.ledger.outbound) {
      if (receipt.state === "sending") receipt.state = "effect-unknown";
    }
    if (interrupted || this.ledger.outbound.some((item) => item.state === "effect-unknown")) this.persistLedger();
    return { interrupted };
  }

  private persistLedger(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    this.ledger.inbound = this.ledger.inbound.slice(-MAX_RECEIPTS);
    this.ledger.outbound = this.ledger.outbound.slice(-MAX_RECEIPTS);
    writeFileAtomic(this.stateFile, JSON.stringify(this.ledger));
  }

  async configure(input: PocketGatewayConfig): Promise<PocketStatus> {
    await this.stop();
    const token = normalizeTelegramBotToken(input.token) ?? "";
    const allowedUserId = normalizeTelegramUserId(input.allowedUserId) ?? "";
    this.config = { enabled: input.enabled, pilotReady: input.pilotReady, token, allowedUserId };
    this.setStatus({
      configured: Boolean(token && allowedUserId),
      enabled: input.enabled,
      pilotReady: input.pilotReady,
      allowedUserId,
      botUsername: null,
      deliveryUncertain: false,
      lastInboundAt: null,
    });
    if (!input.pilotReady) {
      this.setStatus({ state: "pilot-gated", detail: "Name the pilot agency and PM before Pocket can connect." });
      return this.status();
    }
    if (!input.enabled) {
      this.setStatus({ state: "off", detail: token && allowedUserId ? "Pocket is configured but off." : "Pocket is off." });
      return this.status();
    }
    if (!token || !allowedUserId) {
      this.setStatus({ state: "setup-required", detail: "Add a dedicated Telegram bot token and the PM's numeric user ID." });
      return this.status();
    }

    let interrupted = false;
    try {
      ({ interrupted } = this.loadLedger());
    } catch {
      this.setStatus({ state: "attention", detail: "Pocket delivery state is unreadable. RealBud refused to poll so old requests cannot replay." });
      return this.status();
    }
    this.setStatus({
      state: "connecting",
      detail: "Checking the dedicated Telegram bot…",
      lastInboundAt: this.ledger.lastInboundAt ?? null,
      deliveryUncertain: this.ledger.outbound.some((item) => item.state === "effect-unknown"),
    });
    try {
      const verified = await verifyTelegramPocketToken(token, { fetchImpl: this.fetchImpl, apiBase: this.apiBase });
      await this.call<boolean>("deleteWebhook", { drop_pending_updates: this.ledger.nextUpdateId === 0 }, 15_000);
      this.running = true;
      const deliveryUncertain = this.ledger.outbound.some((item) => item.state === "effect-unknown");
      this.setStatus({
        state: deliveryUncertain ? "attention" : "ready",
        detail: deliveryUncertain
          ? "A prior Pocket reply has an unknown delivery result. Check Ask before repeating it."
          : "Connected to the same Ask thread. Only the named PM's private chat is accepted.",
        botUsername: verified.username,
        deliveryUncertain,
      });
      if (interrupted) {
        await this.deliver(
          allowedUserId,
          "RealBud restarted while handling a mobile request. It was not replayed. Check Ask on the desktop and resend only if the result is missing.",
        );
      }
      if (this.autoPoll) this.loopPromise = this.pollLoop();
    } catch (error) {
      this.running = false;
      this.setStatus({
        state: "attention",
        detail: (error as { status?: number }).status === 401
          ? "Telegram rejected that bot token. Replace it in You."
          : "Telegram could not be reached. Check the connection and try again.",
      });
    }
    return this.status();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.requestController?.abort();
    this.requestController = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    const pending = this.loopPromise;
    this.loopPromise = null;
    if (pending) await pending.catch(() => {});
  }

  private async call<T>(method: string, payload?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const controller = new AbortController();
    this.requestController = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await telegramCall<T>({
        token: this.config.token,
        method,
        payload,
        fetchImpl: this.fetchImpl,
        apiBase: this.apiBase,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (this.requestController === controller) this.requestController = null;
    }
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        await this.pollOnce();
        failures = 0;
        if (!this.current.deliveryUncertain && this.current.state !== "ready") {
          this.setStatus({ state: "ready", detail: "Connected to the same Ask thread. Only the named PM's private chat is accepted." });
        }
      } catch (error) {
        if (!this.running || (error instanceof Error && error.name === "AbortError")) break;
        failures += 1;
        const denied = (error as { status?: number }).status === 401;
        this.setStatus({
          state: "attention",
          detail: denied ? "Telegram rejected the saved bot token." : "Pocket lost its Telegram connection and is retrying.",
        });
        if (denied) {
          this.running = false;
          break;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)));
          this.cancelRetry = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.cancelRetry = null;
      }
    }
  }

  async pollOnce(): Promise<void> {
    if (!this.running) return;
    const updates = await this.call<TelegramUpdate[]>("getUpdates", {
      offset: this.ledger.nextUpdateId,
      timeout: 20,
      allowed_updates: ["message", "callback_query"],
    }, 30_000);
    if (!Array.isArray(updates)) throw new Error("Telegram returned invalid updates.");
    for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
      if (!Number.isSafeInteger(update.update_id) || update.update_id < this.ledger.nextUpdateId) continue;
      const receipt: InboundReceipt = {
        updateId: update.update_id,
        kind: update.callback_query ? "decision" : update.message ? "message" : "ignored",
        state: "claimed",
        at: this.now(),
      };
      // Claim and advance before doing any model or Desk work. A crash may
      // require the PM to resend, but it can never execute one mobile request
      // twice without a new message.
      this.ledger.nextUpdateId = update.update_id + 1;
      this.ledger.inbound.push(receipt);
      this.persistLedger();
      try {
        await this.handleUpdate(update, receipt);
        receipt.state = "completed";
      } catch {
        receipt.state = "failed";
        if (this.allowed(update)) {
          await this.deliver(this.config.allowedUserId, "RealBud could not complete that mobile request. Nothing was retried automatically; open Ask to review it.").catch(() => {});
        }
      }
      this.persistLedger();
    }
  }

  private allowed(update: TelegramUpdate): boolean {
    const from = update.message?.from ?? update.callback_query?.from;
    const chat = update.message?.chat ?? update.callback_query?.message?.chat;
    return Boolean(
      from && chat && chat.type === "private" &&
      String(from.id) === this.config.allowedUserId && String(chat.id) === this.config.allowedUserId,
    );
  }

  private async handleUpdate(update: TelegramUpdate, receipt: InboundReceipt): Promise<void> {
    if (!this.allowed(update)) {
      receipt.kind = "ignored";
      return;
    }
    this.ledger.lastInboundAt = this.now();
    this.setStatus({ lastInboundAt: this.ledger.lastInboundAt });
    if (update.callback_query) {
      await this.handleDecision(update.callback_query);
      return;
    }
    const parsed = parsePocketText(update.message?.text);
    if (!parsed.ok) {
      await this.deliver(this.config.allowedUserId, parsed.reason);
      return;
    }
    const command = parsed.text.toLowerCase();
    if (command === "/start" || command === "/help") {
      await this.deliver(
        this.config.allowedUserId,
        pocketHelpText("Telegram"),
      );
      return;
    }
    if (command === "/status") {
      await this.deliver(this.config.allowedUserId, await this.handlers.onStatus());
      return;
    }
    if (command.startsWith("/")) {
      await this.deliver(this.config.allowedUserId, pocketUnsupportedCommandText());
      return;
    }
    const reply = await this.handlers.onText(parsed.text);
    const text = reply.action
      ? `${reply.text.trim() ? `${reply.text.trim()}\n\n` : ""}${pocketApprovalRequestText(reply.action, TELEGRAM_TEXT_LIMIT)}`
      : reply.text;
    await this.deliver(this.config.allowedUserId, text, reply.action);
  }

  private async handleDecision(query: TelegramCallbackQuery): Promise<void> {
    const parsed = parsePocketDecision(query.data);
    if (!parsed) {
      await this.answerCallback(query.id, "That RealBud decision is no longer valid.");
      return;
    }
    const { decision, messageId } = parsed;
    let outcome: string;
    try {
      outcome = await this.handlers.onDecision(messageId, decision);
    } catch (error) {
      outcome = redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 300)
        || "RealBud could not apply that decision.";
    }
    await this.answerCallback(query.id, outcome.slice(0, 180));
    if (query.message) {
      await this.call<boolean>("editMessageReplyMarkup", {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => false);
    }
    await this.deliver(this.config.allowedUserId, outcome);
  }

  private async answerCallback(callbackQueryId: string, text: string): Promise<void> {
    await this.call<boolean>("answerCallbackQuery", { callback_query_id: callbackQueryId, text }).catch(() => false);
  }

  private async deliver(chatId: string, text: string, action?: PocketActionReply): Promise<void> {
    const chunks = splitTelegramText(redactSecretsInText(text));
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]!;
      const final = index === chunks.length - 1;
      // Validate the server-owned action id before recording a network effect.
      // A malformed internal id is a local failure, never an ambiguous send.
      const replyMarkup = final && action ? {
        inline_keyboard: [[
          { text: "Allow once", callback_data: pocketDecisionId("allow", action.messageId) },
          { text: "Not now", callback_data: pocketDecisionId("deny", action.messageId) },
        ]],
      } : null;
      const digest = createHash("sha256").update(chunk).digest("hex");
      const receipt: OutboundReceipt = {
        id: randomBytes(12).toString("hex"),
        digest,
        state: "sending",
        at: this.now(),
      };
      this.ledger.outbound.push(receipt);
      this.persistLedger();
      try {
        await this.call<TelegramMessage>("sendMessage", {
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        });
        receipt.state = "delivered";
      } catch (error) {
        // Once a network send starts Telegram may have accepted it even when
        // the acknowledgement is lost. Record uncertainty and never replay
        // the bubble or an embedded approval button automatically.
        receipt.state = "effect-unknown";
        this.setStatus({
          state: "attention",
          detail: "A Pocket reply may not have arrived. Check Ask before repeating the request.",
          deliveryUncertain: true,
        });
        this.persistLedger();
        throw error;
      }
      this.persistLedger();
    }
  }
}
