// RealBud owns the Slack channel: bot-token Web API poll (and Socket Mode when
// an app-level token is also stored). Ordinary Ask turns on the canonical Bud
// thread. Token never appears in API responses or logs.
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { productAskFailure } from "../ask-book.ts";
import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import type { Message, Store } from "../store.ts";

import {
  decideRemotely,
  parseRemoteDecisionText,
  pendingDraftId,
  type RemoteChannelAdapter,
} from "../remote-decisions.ts";
import type { ChannelAdapter, ChannelPublic } from "./types.ts";

export type SlackFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type SlackRecord = {
  botToken: string;
  /** App-level token (xapp-…) enables Socket Mode; without it RealBud polls. */
  appToken: string | null;
  botUsername: string;
  botUserId: string;
  pairedChannelId: string | null;
  pairedName: string | null;
  /** Per-IM last seen message ts for poll mode. */
  lastTsByChannel: Record<string, string>;
  connectedAt: number;
  lastMessageAt: number | null;
};

export type SlackPublic = ChannelPublic;

export type StartTurnFn = (
  botId: string,
  text: string,
  opts?: {
    userMessage?: Message;
    onDispatchError?: (message: string) => void;
  },
) => Promise<void>;

export type SlackDeps = {
  store: Store;
  startTurn: StartTurnFn;
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
  broadcast?: (payload: unknown) => void;
  fetch?: SlackFetch;
  now?: () => number;
};

export type SlackSocketLike = {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type SlackWebSocketFactory = (url: string) => SlackSocketLike;

const PAIR_REPLY = "Paired with RealBud on this Mac. Send a task, /continue for your latest saved reply, /summary for a short handoff, or /help. Keep this Mac awake and online. Review cards include the exact reply to use.";
const ELSEWHERE_REPLY = "This Bud is paired elsewhere.";
const BAD_TOKEN = "that token did not answer — check it against the Slack app settings";
const CLIP_AT = 2900;
const MAX_QUEUE = 20;
const POLL_MS = 3_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

type QueuedAsk = { text: string; userMessage?: Message };
type PendingRelay = { threadId: string; userMessageId: string };
type InboundSlack = { channelId: string; userId: string; name: string; text: string; ts: string };

let bound: SlackDeps | null = null;
let abort: AbortController | null = null;
let unsub: (() => void) | null = null;
let inboundQueue: QueuedAsk[] = [];
let pendingRelay: PendingRelay | null = null;
let flushing = false;
let wsFactory: SlackWebSocketFactory | null = null;
let activeSocket: SlackSocketLike | null = null;
let refusedChannels = new Set<string>();

export function channelPath(): string {
  return join(DATA_DIR, "channel-slack.json");
}

export function slackApiBase(): string {
  return (process.env.REALBUD_SLACK_API ?? "https://slack.com").replace(/\/$/, "");
}

export function setSlackWebSocket(factory: SlackWebSocketFactory | null): void {
  wsFactory = factory;
}

function hideToken(text: string, token: string): string {
  return token ? text.split(token).join("«redacted»") : text;
}

function logQuiet(text: string, token?: string): void {
  const masked = token ? hideToken(text, token) : text;
  console.error(redactSecretsInText(masked));
}

function asChannel(value: unknown): SlackRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.botToken !== "string" || !row.botToken.trim()) return null;
  const lastTsByChannel: Record<string, string> = {};
  if (row.lastTsByChannel && typeof row.lastTsByChannel === "object") {
    for (const [key, ts] of Object.entries(row.lastTsByChannel as Record<string, unknown>)) {
      if (typeof ts === "string" && ts.trim()) lastTsByChannel[key] = ts;
    }
  }
  return {
    botToken: row.botToken,
    appToken: typeof row.appToken === "string" && row.appToken.trim() ? row.appToken.trim() : null,
    botUsername: typeof row.botUsername === "string" ? row.botUsername : "",
    botUserId: typeof row.botUserId === "string" ? row.botUserId : "",
    pairedChannelId:
      typeof row.pairedChannelId === "string" && row.pairedChannelId.trim() ? row.pairedChannelId : null,
    pairedName: typeof row.pairedName === "string" ? row.pairedName : null,
    lastTsByChannel,
    connectedAt: typeof row.connectedAt === "number" && Number.isFinite(row.connectedAt) ? row.connectedAt : 0,
    lastMessageAt: typeof row.lastMessageAt === "number" && Number.isFinite(row.lastMessageAt) ? row.lastMessageAt : null,
  };
}

export function loadChannel(): SlackRecord | null {
  try {
    return asChannel(JSON.parse(readFileSync(channelPath(), "utf8")));
  } catch {
    return null;
  }
}

export function saveChannel(record: SlackRecord): void {
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

export function toPublic(record: SlackRecord | null): SlackPublic {
  if (!record) return { connected: false };
  return {
    connected: true,
    botUsername: record.botUsername,
    pairedName: record.pairedName,
    paired: record.pairedChannelId != null,
    lastMessageAt: record.lastMessageAt,
  };
}

export function clipSlackText(text: string): string {
  if (text.length <= CLIP_AT) return text;
  return `${text.slice(0, CLIP_AT - 20).trimEnd()}…\n(trimmed)`;
}

function apiHeaders(token: string, json = false): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "user-agent": "RealBud (https://github.com/EzAuto399/RealBud, 0.1.17)",
  };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

async function slackApi(
  fetchFn: SlackFetch,
  token: string,
  method: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetchFn(`${slackApiBase()}/api/${method}`, {
    method: "POST",
    headers: apiHeaders(token, true),
    body: JSON.stringify(body ?? {}),
    signal,
  });
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(BAD_TOKEN);
  }
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export async function verifyToken(
  fetchFn: SlackFetch,
  token: string,
): Promise<{ userId: string; username: string }> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error(BAD_TOKEN);
  let body: Record<string, unknown>;
  try {
    body = await slackApi(fetchFn, trimmed, "auth.test", {});
  } catch {
    throw new Error(BAD_TOKEN);
  }
  if (body.ok !== true) throw new Error(BAD_TOKEN);
  const userId = typeof body.user_id === "string" ? body.user_id : "";
  const username = typeof body.user === "string" ? body.user : "";
  if (!userId || !username) throw new Error(BAD_TOKEN);
  return { userId, username };
}

export async function sendMessage(fetchFn: SlackFetch, token: string, channelId: string, text: string): Promise<void> {
  const body = await slackApi(fetchFn, token, "chat.postMessage", {
    channel: channelId,
    text: clipSlackText(text),
  });
  if (body.ok !== true) throw new Error("Slack did not accept that message");
}

export async function sendDecisionMessage(
  fetchFn: SlackFetch,
  token: string,
  channelId: string,
  text: string,
): Promise<void> {
  await sendMessage(fetchFn, token, channelId, `${clipSlackText(text)}\n\nReply allow or deny.`);
}

function isTurnBusy(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === 409) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /already running|already working/i.test(msg);
}

async function relayText(text: string, deps: SlackDeps): Promise<void> {
  const record = loadChannel();
  if (!record?.botToken || record.pairedChannelId == null) return;
  try {
    await sendMessage(deps.fetch ?? globalThis.fetch, record.botToken, record.pairedChannelId, text);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    logQuiet(raw, record.botToken);
  }
}

function collectAssistantAfter(threadId: string, userMessageId: string, store: Store): string[] {
  const messages = store.messagesFor(threadId);
  const idx = messages.findIndex((m) => m.id === userMessageId);
  const slice = idx === -1 ? messages : messages.slice(idx + 1);
  return slice.filter((m) => m.role === "bot" && m.kind === "text" && m.text).map((m) => m.text as string);
}

async function relayPendingFromStore(deps: SlackDeps): Promise<void> {
  if (!pendingRelay) return;
  const texts = collectAssistantAfter(pendingRelay.threadId, pendingRelay.userMessageId, deps.store);
  await relayText(texts.length ? texts.join("\n\n") : productAskFailure("Bud couldn't finish that request."), deps);
}

function queueAsk(item: QueuedAsk): void {
  if (inboundQueue.length >= MAX_QUEUE) return;
  inboundQueue.push(item);
}

async function enqueueOrStart(prefixed: string, deps: SlackDeps, userMessage?: Message): Promise<void> {
  const bot = deps.store.bot("bud");
  if (!bot) return;
  if (bot.busy) {
    queueAsk({ text: prefixed, userMessage });
    return;
  }
  const message =
    userMessage ?? deps.store.appendMessage(bot.threadId, { role: "user", kind: "text", text: prefixed });
  if (!userMessage) deps.broadcast?.({ kind: "message", threadId: bot.threadId, message });
  pendingRelay = { threadId: bot.threadId, userMessageId: message.id };
  try {
    await deps.startTurn("bud", prefixed, {
      userMessage: message,
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
  const after = deps.store.bot("bud");
  if (after && !after.busy && pendingRelay) {
    await relayPendingFromStore(deps);
    pendingRelay = null;
  }
}

async function flushQueue(deps: SlackDeps): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (inboundQueue.length) {
      const bot = deps.store.bot("bud");
      if (!bot || bot.busy) return;
      const next = inboundQueue.shift();
      if (!next) return;
      await enqueueOrStart(next.text, deps, next.userMessage);
    }
  } finally {
    flushing = false;
  }
}

export function onSlackRuntimeEvent(event: RuntimeEvent): void {
  if (!bound) return;
  const bot = bound.store.bot("bud");
  if (!bot || event.threadId !== bot.threadId) return;
  if (event.type !== "turn.completed") return;
  const deps = bound;
  void (async () => {
    if (pendingRelay) {
      await relayPendingFromStore(deps);
      pendingRelay = null;
    }
    await flushQueue(deps);
  })();
}

async function resolveUserName(fetchFn: SlackFetch, token: string, userId: string): Promise<string> {
  try {
    const body = await slackApi(fetchFn, token, "users.info", { user: userId });
    const user = body.user && typeof body.user === "object" ? (body.user as Record<string, unknown>) : null;
    const profile = user?.profile && typeof user.profile === "object" ? (user.profile as Record<string, unknown>) : null;
    const real =
      (typeof profile?.real_name === "string" && profile.real_name.trim()) ||
      (typeof user?.real_name === "string" && user.real_name.trim()) ||
      (typeof user?.name === "string" && user.name.trim()) ||
      "";
    return real || "Slack";
  } catch {
    return "Slack";
  }
}

export async function handleSlackInbound(items: InboundSlack[], deps: SlackDeps): Promise<void> {
  bound = deps;
  const record = loadChannel();
  if (!record) return;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  let next = { ...record, lastTsByChannel: { ...record.lastTsByChannel } };

  for (const inbound of items) {
    if (inbound.ts) next.lastTsByChannel[inbound.channelId] = inbound.ts;
    if (!inbound.text?.trim()) {
      saveChannel(next);
      continue;
    }
    if (next.pairedChannelId == null) {
      next = {
        ...next,
        pairedChannelId: inbound.channelId,
        pairedName: inbound.name,
        lastMessageAt: now(),
      };
      saveChannel(next);
      try {
        await sendMessage(fetchFn, next.botToken, inbound.channelId, PAIR_REPLY);
      } catch (error) {
        logQuiet(error instanceof Error ? error.message : String(error), next.botToken);
      }
      continue;
    }
    if (inbound.channelId !== next.pairedChannelId) {
      if (!refusedChannels.has(inbound.channelId)) {
        refusedChannels.add(inbound.channelId);
        try {
          await sendMessage(fetchFn, next.botToken, inbound.channelId, ELSEWHERE_REPLY);
        } catch (error) {
          logQuiet(error instanceof Error ? error.message : String(error), next.botToken);
        }
      }
      saveChannel(next);
      continue;
    }
    next = { ...next, lastMessageAt: now() };
    saveChannel(next);
    const pending = pendingDraftId("slack");
    const parsed = pending ? parseRemoteDecisionText(inbound.text) : null;
    if (pending && parsed) {
      const result = await decideRemotely("slack", inbound.channelId, pending, parsed.decision, parsed.reason, inbound.name);
      try {
        await sendMessage(fetchFn, next.botToken, inbound.channelId, result.ok ? result.stamp : result.message);
      } catch (error) {
        logQuiet(error instanceof Error ? error.message : String(error), next.botToken);
      }
      continue;
    }
    await enqueueOrStart(`[Slack · ${inbound.name}] ${inbound.text}`, deps);
  }
  saveChannel(next);
}

function asMessageEvent(payload: unknown, botUserId: string): InboundSlack | null {
  if (!payload || typeof payload !== "object") return null;
  const event = (payload as { event?: unknown }).event;
  if (!event || typeof event !== "object") return null;
  const row = event as Record<string, unknown>;
  if (row.type !== "message") return null;
  if (row.subtype != null && row.subtype !== "") return null;
  if (typeof row.user !== "string" || !row.user || row.user === botUserId) return null;
  if (typeof row.channel !== "string" || !row.channel) return null;
  if (typeof row.text !== "string" || !row.text.trim()) return null;
  if (typeof row.ts !== "string" || !row.ts) return null;
  if (row.bot_id != null) return null;
  return {
    channelId: row.channel,
    userId: row.user,
    name: "Slack",
    text: row.text,
    ts: row.ts,
  };
}

async function pollOnce(deps: SlackDeps, signal: AbortSignal): Promise<void> {
  const record = loadChannel();
  if (!record?.botToken) return;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const list = await slackApi(fetchFn, record.botToken, "conversations.list", { types: "im", limit: 50 }, signal);
  if (list.ok !== true || signal.aborted) return;
  const channels = Array.isArray(list.channels) ? list.channels : [];
  const inbound: InboundSlack[] = [];
  for (const raw of channels) {
    if (!raw || typeof raw !== "object") continue;
    const ch = raw as { id?: unknown };
    if (typeof ch.id !== "string" || !ch.id) continue;
    const oldest = record.lastTsByChannel[ch.id];
    const hist = await slackApi(
      fetchFn,
      record.botToken,
      "conversations.history",
      { channel: ch.id, limit: 20, ...(oldest ? { oldest } : {}) },
      signal,
    );
    if (hist.ok !== true || signal.aborted) continue;
    const messages = Array.isArray(hist.messages) ? [...hist.messages].reverse() : [];
    for (const msg of messages) {
      if (!msg || typeof msg !== "object") continue;
      const row = msg as Record<string, unknown>;
      if (typeof row.ts !== "string") continue;
      if (oldest && row.ts <= oldest) continue;
      if (typeof row.user !== "string" || row.user === record.botUserId) continue;
      if (row.bot_id != null) continue;
      if (typeof row.text !== "string" || !row.text.trim()) continue;
      const name = await resolveUserName(fetchFn, record.botToken, row.user);
      inbound.push({ channelId: ch.id, userId: row.user, name, text: row.text, ts: row.ts });
    }
  }
  if (inbound.length) await handleSlackInbound(inbound, deps);
}

function openSocket(url: string): SlackSocketLike {
  if (wsFactory) return wsFactory(url);
  // eslint-disable-next-line no-undef
  const WebSocketCtor = (globalThis as { WebSocket?: new (url: string) => SlackSocketLike }).WebSocket;
  if (!WebSocketCtor) throw new Error("WebSocket unavailable");
  return new WebSocketCtor(url);
}

async function openSocketMode(deps: SlackDeps, signal: AbortSignal): Promise<void> {
  const record = loadChannel();
  if (!record?.appToken) return;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const opened = await slackApi(fetchFn, record.appToken, "apps.connections.open", {}, signal);
  if (opened.ok !== true || typeof opened.url !== "string" || !opened.url) {
    throw new Error(typeof opened.error === "string" ? opened.error : "Slack Socket Mode did not open");
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (activeSocket === ws) activeSocket = null;
      resolve();
    };
    const ws = openSocket(opened.url as string);
    activeSocket = ws;
    const onAbort = () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      done();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort);
    ws.addEventListener("close", () => done());
    ws.addEventListener("error", () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    });
    ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data ?? "");
      void onSocketFrame(data, ws, deps);
    });
  });
}

async function onSocketFrame(raw: string, ws: SlackSocketLike, deps: SlackDeps): Promise<void> {
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof frame.envelope_id === "string" && frame.envelope_id) {
    try {
      ws.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    } catch {
      /* socket closed */
    }
  }
  if (frame.type !== "events_api") return;
  const record = loadChannel();
  if (!record) return;
  const inbound = asMessageEvent(frame.payload, record.botUserId);
  if (!inbound) return;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const name = await resolveUserName(fetchFn, record.botToken, inbound.userId);
  await handleSlackInbound([{ ...inbound, name }], deps);
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

async function runBridge(deps: SlackDeps, signal: AbortSignal): Promise<void> {
  let backoff = BACKOFF_START_MS;
  while (!signal.aborted) {
    const record = loadChannel();
    if (!record?.botToken) return;
    try {
      if (record.appToken) {
        await openSocketMode(deps, signal);
      } else {
        await pollOnce(deps, signal);
        await sleep(POLL_MS, signal);
      }
      if (signal.aborted) return;
      backoff = BACKOFF_START_MS;
    } catch (error) {
      if (signal.aborted) return;
      logQuiet(error instanceof Error ? error.message : String(error), record.botToken);
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
    }
  }
}

export function bindSlackBridge(deps: SlackDeps): void {
  bound = deps;
}

export function stopSlackBridge(): void {
  abort?.abort();
  abort = null;
  try {
    activeSocket?.close();
  } catch {
    /* already closed */
  }
  activeSocket = null;
  unsub?.();
  unsub = null;
  inboundQueue = [];
  pendingRelay = null;
  flushing = false;
  refusedChannels = new Set();
}

export function startSlackBridge(deps?: SlackDeps): void {
  if (deps) bound = deps;
  if (!bound) return;
  stopSlackBridge();
  bound = deps ?? bound;
  const record = loadChannel();
  if (!record?.botToken) return;
  unsub = bound.subscribe((event) => onSlackRuntimeEvent(event));
  if (process.env.VITEST && !wsFactory) {
    // Tests drive poll/inbound directly unless a socket factory is installed.
    return;
  }
  abort = new AbortController();
  void runBridge(bound, abort.signal);
}

export async function connectSlack(
  token: string,
  appToken?: string | null,
  fetchFn?: SlackFetch,
): Promise<{ slack: SlackPublic }> {
  const me = await verifyToken(fetchFn ?? bound?.fetch ?? globalThis.fetch, token);
  const record: SlackRecord = {
    botToken: token.trim(),
    appToken: appToken?.trim() ? appToken.trim() : null,
    botUsername: me.username,
    botUserId: me.userId,
    pairedChannelId: null,
    pairedName: null,
    lastTsByChannel: {},
    connectedAt: Date.now(),
    lastMessageAt: null,
  };
  saveChannel(record);
  startSlackBridge();
  return { slack: toPublic(record) };
}

export function disconnectSlack(): { slack: { connected: false } } {
  stopSlackBridge();
  deleteChannel();
  return { slack: { connected: false } };
}

export function slackDecisionAdapter(): RemoteChannelAdapter {
  return {
    id: "slack",
    label: "Slack",
    pairedKey() {
      const rec = loadChannel();
      return rec?.pairedChannelId ?? null;
    },
    async sendDecision(text, _draftId) {
      const rec = loadChannel();
      if (!rec?.botToken || rec.pairedChannelId == null) return;
      try {
        await sendDecisionMessage(bound?.fetch ?? globalThis.fetch, rec.botToken, rec.pairedChannelId, text);
      } catch (error) {
        logQuiet(error instanceof Error ? error.message : String(error), rec.botToken);
      }
    },
    async sendDigest(text) {
      const rec = loadChannel();
      if (!rec?.botToken || rec.pairedChannelId == null) return;
      try {
        await sendMessage(bound?.fetch ?? globalThis.fetch, rec.botToken, rec.pairedChannelId, text);
      } catch (error) {
        logQuiet(error instanceof Error ? error.message : String(error), rec.botToken);
      }
    },
  };
}

export const slackAdapter: ChannelAdapter = {
  async verify(creds) {
    const me = await verifyToken(bound?.fetch ?? globalThis.fetch, creds.botToken);
    return { botUsername: me.username };
  },
  start() {
    startSlackBridge();
  },
  stop() {
    stopSlackBridge();
  },
  status() {
    return toPublic(loadChannel());
  },
};
