import type { WorkspaceActivity } from '../workspace-activity.ts';
import { matchesPairingCode, clearPairingCode } from "../channel-pairing.ts";
import { channelContinuation } from "../channel-continuation.ts";
// RealBud owns the Telegram channel: Bot API long-poll over HTTPS, then
// ordinary Ask turns on the canonical Bud thread. The Hermes worker stays
// per-turn and untouched. Token never appears in API responses or logs.
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { URL } from "node:url";

import { productAskFailure } from "../ask-book.ts";
import { noteWorkerIssue } from "../worker-issues.ts";
import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import type { Message, Store } from "../store.ts";

import {
  decideRemotely,
  parseDecisionCallback,
  decideRemoteText,
  type RemoteChannelAdapter,
} from "../remote-decisions.ts";
import type { ChannelAdapter, ChannelPublic } from "./types.ts";

export type TelegramFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type ChannelRecord = {
  botToken: string;
  botUsername: string;
  pairedChatId: number | null;
  pairedName: string | null;
  offset: number;
  connectedAt: number;
  lastMessageAt: number | null;
};

export type TelegramPublic = ChannelPublic;

export type StartTurnFn = (
  botId: string,
  text: string,
  opts?: {
    userMessage?: Message;
    onDispatchError?: (message: string) => void;
    channelRelay?: boolean;
  },
) => Promise<void>;

export type TelegramDeps = {
  /** Host admission and drain boundary; channel queues remain intact. */
  withWorkspaceActivity?: WorkspaceActivity;
  store: Store;
  startTurn: StartTurnFn;
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
  broadcast?: (payload: unknown) => void;
  fetch?: TelegramFetch;
  now?: () => number;
};

const PAIR_REPLY = "Paired with your RealBud computer. Send a task, /continue for your latest saved reply, /summary for a short handoff, or /help. Keep that computer awake and online.";
const ELSEWHERE_REPLY = "This Bud is paired elsewhere.";
const BAD_TOKEN = "that token did not answer — check it against BotFather";
const CLIP_AT = 3900;
const POLL_TIMEOUT_SEC = 25;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

type QueuedAsk = { text: string; userMessage?: Message };
type PendingRelay = { threadId: string; userMessageId: string };

let bound: TelegramDeps | null = null;
let abort: AbortController | null = null;
let unsub: (() => void) | null = null;
let inboundQueue: QueuedAsk[] = [];
let pendingRelay: PendingRelay | null = null;
let flushing = false;

export function channelPath(): string {
  return join(DATA_DIR, "channel.json");
}

export function telegramApiBase(): string {
  return (process.env.REALBUD_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/$/, "");
}

function telegramMethodUrl(token: string, method: string, query?: Record<string, string>): string {
  const url = new URL(`${telegramApiBase()}/bot${token}/${method}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }
  return url.href;
}

function hideToken(text: string, token: string): string {
  return token ? text.split(token).join("«redacted»") : text;
}

function logQuiet(text: string, token?: string): void {
  const masked = token ? hideToken(text, token) : text;
  console.error(redactSecretsInText(masked));
}

function asChannel(value: unknown): ChannelRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.botToken !== "string" || !row.botToken.trim()) return null;
  return {
    botToken: row.botToken,
    botUsername: typeof row.botUsername === "string" ? row.botUsername : "",
    pairedChatId: typeof row.pairedChatId === "number" && Number.isFinite(row.pairedChatId) ? row.pairedChatId : null,
    pairedName: typeof row.pairedName === "string" ? row.pairedName : null,
    offset: typeof row.offset === "number" && Number.isFinite(row.offset) && row.offset >= 0 ? Math.floor(row.offset) : 0,
    connectedAt: typeof row.connectedAt === "number" && Number.isFinite(row.connectedAt) ? row.connectedAt : 0,
    lastMessageAt: typeof row.lastMessageAt === "number" && Number.isFinite(row.lastMessageAt) ? row.lastMessageAt : null,
  };
}

export function loadChannel(): ChannelRecord | null {
  try {
    return asChannel(JSON.parse(readFileSync(channelPath(), "utf8")));
  } catch {
    return null;
  }
}

export function saveChannel(record: ChannelRecord): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(channelPath(), `${JSON.stringify(record)}\n`, 0o600);
}

export function deleteChannel(): void {
  try {
    unlinkSync(channelPath());
  } catch {
    /* already gone */
  }
}

export function toPublic(record: ChannelRecord | null): TelegramPublic {
  if (!record) return { connected: false };
  return {
    connected: true,
    botUsername: record.botUsername,
    pairedName: record.pairedName,
    paired: record.pairedChatId != null,
    lastMessageAt: record.lastMessageAt,
  };
}

export function telegramStatus(): { telegram: TelegramPublic } {
  return { telegram: toPublic(loadChannel()) };
}

export function clipTelegramText(text: string): string {
  if (text.length <= CLIP_AT) return text;
  return `${text.slice(0, CLIP_AT - 20).trimEnd()}…\n(trimmed)`;
}

/** Telegram HTML parse_mode — escape user/book text before wrapping tags. */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Default-on “response card” formatting for phone outbound.
 * Known Desk review / Ask handoff shapes get a bold title; everything else is
 * escaped plain text so parse_mode HTML stays safe.
 */
export function formatTelegramHtmlMessage(plain: string): string {
  const clipped = clipTelegramText(plain);
  const reply = /^(Reply from Ask:|Bud is still working\. Saved reply from Ask:)\n\n([\s\S]*)$/.exec(clipped);
  if (reply) {
    const title = reply[1]!.startsWith("Bud is still") ? "Saved reply · Bud still working" : "Reply from Ask";
    return `<b>${escapeTelegramHtml(title)}</b>\n\n${escapeTelegramHtml(reply[2]!.trimEnd())}`;
  }
  const summary = /^Ask handoff summary:\n\n([\s\S]*)$/.exec(clipped);
  if (summary) {
    return `<b>Ask handoff</b>\n\n${escapeTelegramHtml(summary[1]!.trimEnd())}`;
  }
  const review =
    /^(.+ — .+)\n\nTo: (.+)\n\n([\s\S]+?)\n\nReply allow ([a-f0-9]{12}) or deny \4\.$/i.exec(clipped);
  if (review) {
    const id = review[4]!;
    return (
      `<b>${escapeTelegramHtml(review[1]!)}</b>\n` +
      `<i>To: ${escapeTelegramHtml(review[2]!)}</i>\n\n` +
      `${escapeTelegramHtml(review[3]!.trim())}\n\n` +
      `<i>Or reply allow ${id} / deny ${id}</i>`
    );
  }
  return escapeTelegramHtml(clipped);
}

export async function verifyToken(fetchFn: TelegramFetch, token: string): Promise<{ id: number; username: string }> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error(BAD_TOKEN);
  let res: Response;
  try {
    res = await fetchFn(telegramMethodUrl(trimmed, "getMe"));
  } catch {
    throw new Error(BAD_TOKEN);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(BAD_TOKEN);
  }
  const row = body && typeof body === "object" ? (body as { ok?: unknown; result?: unknown }) : null;
  const result = row?.result && typeof row.result === "object" ? (row.result as { id?: unknown; username?: unknown }) : null;
  const id = typeof result?.id === "number" ? result.id : null;
  const username = typeof result?.username === "string" ? result.username : "";
  if (!res.ok || row?.ok !== true || id == null || !username) throw new Error(BAD_TOKEN);
  return { id, username };
}

export async function getUpdates(
  fetchFn: TelegramFetch,
  token: string,
  offset: number,
  timeout = POLL_TIMEOUT_SEC,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const res = await fetchFn(telegramMethodUrl(token, "getUpdates", { offset: String(offset), timeout: String(timeout) }), {
    signal,
  });
  const body = (await res.json()) as { ok?: unknown; result?: unknown };
  return body.ok === true && Array.isArray(body.result) ? body.result : [];
}

function postJsonHttps(url: string, body: string): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpsRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300 });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function sendMessage(fetchFn: TelegramFetch, token: string, chatId: number, text: string): Promise<void> {
  const url = telegramMethodUrl(token, "sendMessage");
  const body = JSON.stringify({
    chat_id: chatId,
    text: formatTelegramHtmlMessage(text),
    parse_mode: "HTML",
  });
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!res.ok) throw new Error("Telegram did not accept that message");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  // Electron's utilityProcess fetch occasionally throws "fetch failed" while
  // Node https still reaches api.telegram.org — keep the phone reply moving.
  try {
    const res = await postJsonHttps(url, body);
    if (res.ok) return;
    throw new Error("Telegram did not accept that message");
  } catch (error) {
    throw lastError instanceof Error ? lastError : error instanceof Error ? error : new Error(String(error));
  }
}

export async function sendDecisionMessage(
  fetchFn: TelegramFetch,
  token: string,
  chatId: number,
  text: string,
  draftId: string,
): Promise<void> {
  const res = await fetchFn(telegramMethodUrl(token, "sendMessage"), {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: formatTelegramHtmlMessage(text),
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Allow", callback_data: `d:${draftId}:allow` },
            { text: "Deny", callback_data: `d:${draftId}:deny` },
          ],
        ],
      },
    }),
  });
  if (!res.ok || (await res.json() as { ok?: boolean }).ok !== true) throw new Error("Telegram did not accept that message");
}

async function answerCallbackQuery(fetchFn: TelegramFetch, token: string, callbackId: string, text?: string): Promise<void> {
  const res = await fetchFn(telegramMethodUrl(token, "answerCallbackQuery"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(text ? { callback_query_id: callbackId, text } : { callback_query_id: callbackId }),
  });
  if (!res.ok) throw new Error("Telegram did not accept that callback");
}

async function editMessageText(
  fetchFn: TelegramFetch,
  token: string,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  const res = await fetchFn(telegramMethodUrl(token, "editMessageText"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: formatTelegramHtmlMessage(text),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [] },
    }),
  });
  if (!res.ok) throw new Error("Telegram did not accept that edit");
}

function senderName(from: { first_name?: string; last_name?: string; username?: string } | undefined): string {
  const full = `${from?.first_name ?? ""} ${from?.last_name ?? ""}`.trim();
  if (full) return full;
  const username = from?.username?.trim();
  return username || "Telegram";
}

function isTurnBusy(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === 409) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /already running|already working/i.test(msg);
}

function asInboundMessage(value: unknown): {
  update_id: number;
  text: string;
  chatId: number;
  name: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.update_id !== "number" || !Number.isFinite(row.update_id)) return null;
  const message = row.message;
  if (!message || typeof message !== "object") return { update_id: row.update_id, text: "", chatId: 0, name: "" };
  const msg = message as Record<string, unknown>;
  if (typeof msg.text !== "string" || !msg.text) return { update_id: row.update_id, text: "", chatId: 0, name: "" };
  const chat = msg.chat && typeof msg.chat === "object" ? (msg.chat as { id?: unknown }) : null;
  if (typeof chat?.id !== "number") return { update_id: row.update_id, text: "", chatId: 0, name: "" };
  const from = msg.from && typeof msg.from === "object" ? (msg.from as { first_name?: string; last_name?: string; username?: string }) : undefined;
  return { update_id: row.update_id, text: msg.text, chatId: chat.id, name: senderName(from) };
}

function asCallbackQuery(value: unknown): {
  update_id: number;
  callbackId: string;
  chatId: number;
  messageId: number;
  data: string;
  name: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.update_id !== "number" || !Number.isFinite(row.update_id)) return null;
  const query = row.callback_query;
  if (!query || typeof query !== "object") return null;
  const cb = query as Record<string, unknown>;
  if (typeof cb.id !== "string" || !cb.id) return null;
  if (typeof cb.data !== "string" || !cb.data) return null;
  const message = cb.message && typeof cb.message === "object" ? (cb.message as Record<string, unknown>) : null;
  const chat = message?.chat && typeof message.chat === "object" ? (message.chat as { id?: unknown }) : null;
  if (typeof chat?.id !== "number") return null;
  if (typeof message?.message_id !== "number") return null;
  const from = cb.from && typeof cb.from === "object" ? (cb.from as { first_name?: string; last_name?: string; username?: string }) : undefined;
  return {
    update_id: row.update_id,
    callbackId: cb.id,
    chatId: chat.id,
    messageId: message.message_id,
    data: cb.data,
    name: senderName(from),
  };
}

async function sendChatAction(fetchFn: TelegramFetch, token: string, chatId: number, action = "typing"): Promise<void> {
  const url = telegramMethodUrl(token, "sendChatAction");
  const body = JSON.stringify({ chat_id: chatId, action });
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (res.ok) return;
  } catch {
    /* fall through */
  }
  try {
    await postJsonHttps(url, body);
  } catch {
    /* typing is best-effort */
  }
}

async function showTyping(deps: TelegramDeps): Promise<void> {
  const record = loadChannel();
  if (!record?.botToken || record.pairedChatId == null) return;
  await sendChatAction(deps.fetch ?? globalThis.fetch, record.botToken, record.pairedChatId);
}

async function relayText(text: string, deps: TelegramDeps): Promise<void> {
  const record = loadChannel();
  if (!record?.botToken || record.pairedChatId == null) return;
  try {
    await sendMessage(deps.fetch ?? globalThis.fetch, record.botToken, record.pairedChatId, text);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    logQuiet(raw, record.botToken);
    noteWorkerIssue({
      source: "channel",
      summary: "Telegram reply missed",
      detail: productAskFailure(raw),
    });
  }
}

function collectAssistantAfter(threadId: string, userMessageId: string, store: Store): string[] {
  const messages = store.messagesFor(threadId);
  const idx = messages.findIndex((m) => m.id === userMessageId);
  const slice = idx === -1 ? messages : messages.slice(idx + 1);
  return slice.filter((m) => m.role === "bot" && m.kind === "text" && m.text).map((m) => m.text as string);
}

async function relayPendingFromStore(deps: TelegramDeps, relay: PendingRelay = pendingRelay!): Promise<void> {
  const texts = collectAssistantAfter(relay.threadId, relay.userMessageId, deps.store);
  await relayText(texts.length ? texts.join("\n\n") : productAskFailure("Bud couldn't finish that request."), deps);
}

function queueAsk(item: QueuedAsk): void {
  // Rapid phone taps should not stack replies — keep only the newest ask.
  inboundQueue = [item];
}

function enqueueOrStart(prefixed: string, deps: TelegramDeps, userMessage?: Message): Promise<void> {
  const work = () => enqueueOrStartAdmitted(prefixed, deps, userMessage);
  return deps.withWorkspaceActivity ? deps.withWorkspaceActivity(work) : work();
}
async function enqueueOrStartAdmitted(prefixed: string, deps: TelegramDeps, userMessage?: Message): Promise<void> {
  const bot = deps.store.productBud();
  if (!bot) return;
  const message =
    userMessage ?? deps.store.appendMessage(bot.threadId, { role: "user", kind: "text", text: prefixed });
  if (!userMessage) deps.broadcast?.({ kind: "message", threadId: bot.threadId, message });
  if (bot.busy) {
    const replaced = inboundQueue.length > 0;
    queueAsk({ text: prefixed, userMessage: message });
    await relayText(replaced
      ? "Your latest follow-up replaces the waiting request. Both messages are saved in Ask on desktop. Bud will pick up the latest one after the current work finishes."
      : "Saved in Ask on desktop. Bud is working and will pick this up next. If RealBud restarts first, open Ask to resume the saved request.", deps);
    return;
  }
  pendingRelay = { threadId: bot.threadId, userMessageId: message.id };
  // Ask transcript keeps the [Telegram · …] stamp; Hermes sees the bare ask.
  const modelText = prefixed.replace(/^\[Telegram · [^\]]+\]\s*/i, "").trim() || prefixed;
  void showTyping(deps);
  try {
    await deps.startTurn(bot.id, modelText, {
      userMessage: message,
      channelRelay: true,
      onDispatchError: (errMsg) => {
        pendingRelay = null;
        if (/already running|already working/i.test(errMsg)) {
          queueAsk({ text: prefixed, userMessage: message });
          return;
        }
        void relayText(errMsg, deps);
      },
    });
  } catch (error) {
    pendingRelay = null;
    if (isTurnBusy(error)) {
      queueAsk({ text: prefixed, userMessage: message });
      return;
    }
    const raw = error instanceof Error ? error.message : String(error);
    await relayText(productAskFailure(raw), deps);
    return;
  }
  const after = deps.store.productBud();
  if (after && !after.busy && pendingRelay) {
    const relay = pendingRelay;
    pendingRelay = null;
    await relayPendingFromStore(deps, relay);
    return;
  }
  if (after?.busy && pendingRelay) {
    const token = pendingRelay.userMessageId;
    void (async () => {
      while (pendingRelay?.userMessageId === token && deps.store.productBud()?.busy) {
        await showTyping(deps);
        await sleep(4_000, new AbortController().signal);
      }
    })();
  }
}

async function flushQueue(deps: TelegramDeps): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (inboundQueue.length && !deps.store.productBud()?.busy) {
      const next = inboundQueue.shift();
      if (!next) break;
      await enqueueOrStart(next.text, deps, next.userMessage);
      if (deps.store.productBud()?.busy) break;
    }
  } finally {
    flushing = false;
  }
}

export function onTelegramRuntimeEvent(event: RuntimeEvent): void {
  if (event.type !== "turn.completed") return;
  flushTelegramRelayForThread(event.threadId);
}

/** Ask finished on Bud's thread — push the pending phone reply even if the
 * bus subscription was lost mid-session. */
export function flushTelegramRelayForThread(threadId: string): void {
  if (!bound) return;
  const bot = bound.store.productBud();
  if (!bot || bot.threadId !== threadId) return;
  const deps = bound;
  const relay = pendingRelay?.threadId === threadId ? pendingRelay : null;
  if (relay) pendingRelay = null;
  void (async () => {
    if (relay) await relayPendingFromStore(deps, relay);
    await flushQueue(deps);
  })();
}

export function handleTelegramUpdates(updates: unknown[], deps: TelegramDeps): Promise<void> {
  const work = () => handleTelegramUpdatesAdmitted(updates, deps);
  return deps.withWorkspaceActivity ? deps.withWorkspaceActivity(work) : work();
}
async function handleTelegramUpdatesAdmitted(updates: unknown[], deps: TelegramDeps): Promise<void> {
  bound = deps;
  const record = loadChannel();
  if (!record) return;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  let next = { ...record };
  for (const raw of updates) {
    const updateId = (raw as { update_id?: unknown } | null)?.update_id;
    if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < next.offset) continue;
    const callback = asCallbackQuery(raw);
    if (callback) {
      if (callback.update_id >= next.offset) next.offset = callback.update_id + 1;
      saveChannel(next);
      if (next.pairedChatId != null && callback.chatId === next.pairedChatId) {
        await handlePairedCallback(callback, fetchFn, next.botToken);
      }
      continue;
    }
    const inbound = asInboundMessage(raw);
    if (!inbound) continue;
    if (inbound.update_id >= next.offset) next.offset = inbound.update_id + 1;
    if (!inbound.text || !inbound.chatId) {
      saveChannel(next);
      continue;
    }
    if (next.pairedChatId == null) {
      if (!matchesPairingCode("telegram", inbound.text, now())) { saveChannel(next); continue; }
      next = {
        ...next,
        pairedChatId: inbound.chatId,
        pairedName: inbound.name,
        lastMessageAt: now(),
      };
      saveChannel(next);
      clearPairingCode("telegram");
      try {
        await sendMessage(fetchFn, next.botToken, inbound.chatId, PAIR_REPLY);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logQuiet(msg, next.botToken);
      }
      deps.broadcast?.({ kind: "channels", channels: { telegram: toPublic(next) } });
      continue;
    }
    if (inbound.chatId !== next.pairedChatId) {
      try {
        await sendMessage(fetchFn, next.botToken, inbound.chatId, ELSEWHERE_REPLY);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logQuiet(msg, next.botToken);
      }
      saveChannel(next);
      continue;
    }
    next = { ...next, lastMessageAt: now() };
    saveChannel(next);
    const continuation = channelContinuation(inbound.text, deps.store);
    if (continuation !== null) { await relayText(continuation, deps); continue; }
    const result = await decideRemoteText("telegram", String(inbound.chatId), inbound.text, inbound.name);
    if (result) {
      try {
        await sendMessage(fetchFn, next.botToken, inbound.chatId, result.ok ? result.stamp : result.message);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logQuiet(msg, next.botToken);
      }
      continue;
    }
    await enqueueOrStart(`[Telegram · ${inbound.name}] ${inbound.text}`, deps);
  }
  saveChannel(next);
}

async function handlePairedCallback(
  callback: { callbackId: string; chatId: number; messageId: number; data: string; name: string },
  fetchFn: TelegramFetch,
  token: string,
): Promise<void> {
  const parsed = parseDecisionCallback(callback.data);
  if (!parsed) return;
  try {
    await answerCallbackQuery(fetchFn, token, callback.callbackId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logQuiet(msg, token);
  }
  const result = await decideRemotely("telegram", String(callback.chatId), parsed.draftId, parsed.decision, undefined, callback.name);
  try {
    await editMessageText(fetchFn, token, callback.chatId, callback.messageId, result.ok ? result.stamp : result.message);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logQuiet(msg, token);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function runPoller(deps: TelegramDeps, signal: AbortSignal): Promise<void> {
  let backoff = BACKOFF_START_MS;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  while (!signal.aborted) {
    const record = loadChannel();
    if (!record?.botToken) return;
    try {
      const updates = await getUpdates(fetchFn, record.botToken, record.offset, POLL_TIMEOUT_SEC, signal);
      if (signal.aborted) return;
      backoff = BACKOFF_START_MS;
      if (updates.length) await handleTelegramUpdates(updates, deps);
    } catch (error) {
      if (signal.aborted) return;
      const raw = error instanceof Error ? error.message : String(error);
      logQuiet(raw, record.botToken);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
    }
  }
}

export function bindTelegramBridge(deps: TelegramDeps): void {
  bound = deps;
}

export function stopTelegramBridge(): void {
  abort?.abort();
  abort = null;
  unsub?.();
  unsub = null;
  inboundQueue = [];
  pendingRelay = null;
  flushing = false;
}

export function startTelegramBridge(deps?: TelegramDeps): void {
  if (deps) bound = deps;
  if (!bound) return;
  stopTelegramBridge();
  bound = deps ?? bound;
  const record = loadChannel();
  if (!record?.botToken) return;
  unsub = bound.subscribe((event) => onTelegramRuntimeEvent(event));
  if (process.env.VITEST) return;
  abort = new AbortController();
  void runPoller(bound, abort.signal);
}

export async function connectTelegram(token: string, fetchFn?: TelegramFetch): Promise<{ telegram: TelegramPublic }> {
  const me = await verifyToken(fetchFn ?? bound?.fetch ?? globalThis.fetch, token);
  const record: ChannelRecord = {
    botToken: token.trim(),
    botUsername: me.username,
    pairedChatId: null,
    pairedName: null,
    offset: 0,
    connectedAt: Date.now(),
    lastMessageAt: null,
  };
  clearPairingCode("telegram");
  saveChannel(record);
  startTelegramBridge();
  return { telegram: toPublic(record) };
}

export function disconnectTelegram(): { telegram: { connected: false } } {
  stopTelegramBridge();
  clearPairingCode("telegram");
  deleteChannel();
  return { telegram: { connected: false } };
}

export function telegramDecisionAdapter(): RemoteChannelAdapter {
  return {
    id: "telegram",
    label: "Telegram",
    pairedKey() {
      const rec = loadChannel();
      return rec?.pairedChatId != null ? String(rec.pairedChatId) : null;
    },
    async sendDecision(text, draftId) {
      const rec = loadChannel();
      if (!rec?.botToken || rec.pairedChatId == null) throw new Error("Phone connection changed");
      try {
        await sendDecisionMessage(bound?.fetch ?? globalThis.fetch, rec.botToken, rec.pairedChatId, text, draftId);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        logQuiet(raw, rec.botToken);
        throw new Error("Review card delivery was not confirmed");
      }
    },
    async sendDigest(text) {
      const rec = loadChannel();
      if (!rec?.botToken || rec.pairedChatId == null) return;
      try {
        await sendMessage(bound?.fetch ?? globalThis.fetch, rec.botToken, rec.pairedChatId, text);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        logQuiet(raw, rec.botToken);
      }
    },
  };
}

export const telegramAdapter: ChannelAdapter = {
  async verify(creds) {
    const me = await verifyToken(bound?.fetch ?? globalThis.fetch, creds.botToken);
    return { botUsername: me.username };
  },
  start() {
    startTelegramBridge();
  },
  stop() {
    stopTelegramBridge();
  },
  status() {
    return toPublic(loadChannel());
  },
};
