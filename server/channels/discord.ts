import { matchesPairingCode, clearPairingCode } from "../channel-pairing.ts";
import { channelContinuation } from "../channel-continuation.ts";
// RealBud owns the Discord channel: REST verify + Gateway v10 over the
// global WebSocket, then ordinary Ask turns on the canonical Bud thread.
// Token never appears in API responses or logs.
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
  parseDecisionCallback,
  decideRemoteText,
  type RemoteChannelAdapter,
} from "../remote-decisions.ts";
import type { ChannelAdapter, ChannelPublic } from "./types.ts";

export type DiscordFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type DiscordRecord = {
  botToken: string;
  botUsername: string;
  pairedChannelId: string | null;
  pairedName: string | null;
  connectedAt: number;
  lastMessageAt: number | null;
};

export type DiscordPublic = ChannelPublic;

export type StartTurnFn = (
  botId: string,
  text: string,
  opts?: {
    userMessage?: Message;
    onDispatchError?: (message: string) => void;
    channelRelay?: boolean;
  },
) => Promise<void>;

export type DiscordDeps = {
  store: Store;
  startTurn: StartTurnFn;
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
  broadcast?: (payload: unknown) => void;
  fetch?: DiscordFetch;
  now?: () => number;
};

export type DiscordSocketLike = {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type DiscordWebSocketFactory = (url: string) => DiscordSocketLike;

const PAIR_REPLY = "Paired with RealBud on this Mac. Send a task, /continue for your latest saved reply, or /help. Keep this Mac awake and online.";
const ELSEWHERE_REPLY = "This Bud is paired elsewhere.";
const BAD_TOKEN = "that token did not answer — check it against the Discord developer portal";
const CLIP_AT = 1900;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const DISCORD_INTENTS = (1 << 12) | (1 << 15);

type QueuedAsk = { text: string; userMessage?: Message };
type PendingRelay = { threadId: string; userMessageId: string };

let bound: DiscordDeps | null = null;
let abort: AbortController | null = null;
let unsub: (() => void) | null = null;
let inboundQueue: QueuedAsk[] = [];
let pendingRelay: PendingRelay | null = null;
let flushing = false;
let wsFactory: DiscordWebSocketFactory | null = null;
let activeSocket: DiscordSocketLike | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatAcked = true;
let lastSeq: number | null = null;
let refusedChannels = new Set<string>();

export function channelPath(): string {
  return join(DATA_DIR, "channel-discord.json");
}

export function discordApiBase(): string {
  return (process.env.REALBUD_DISCORD_API ?? "https://discord.com").replace(/\/$/, "");
}

export function setDiscordWebSocket(factory: DiscordWebSocketFactory | null): void {
  wsFactory = factory;
}

function hideToken(text: string, token: string): string {
  return token ? text.split(token).join("«redacted»") : text;
}

function logQuiet(text: string, token?: string): void {
  const masked = token ? hideToken(text, token) : text;
  console.error(redactSecretsInText(masked));
}

function asChannel(value: unknown): DiscordRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.botToken !== "string" || !row.botToken.trim()) return null;
  const pairedChannelId =
    typeof row.pairedChannelId === "string" && row.pairedChannelId.trim() ? row.pairedChannelId : null;
  return {
    botToken: row.botToken,
    botUsername: typeof row.botUsername === "string" ? row.botUsername : "",
    pairedChannelId,
    pairedName: typeof row.pairedName === "string" ? row.pairedName : null,
    connectedAt: typeof row.connectedAt === "number" && Number.isFinite(row.connectedAt) ? row.connectedAt : 0,
    lastMessageAt: typeof row.lastMessageAt === "number" && Number.isFinite(row.lastMessageAt) ? row.lastMessageAt : null,
  };
}

export function loadChannel(): DiscordRecord | null {
  try {
    return asChannel(JSON.parse(readFileSync(channelPath(), "utf8")));
  } catch {
    return null;
  }
}

export function saveChannel(record: DiscordRecord): void {
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

export function toPublic(record: DiscordRecord | null): DiscordPublic {
  if (!record) return { connected: false };
  return {
    connected: true,
    botUsername: record.botUsername,
    pairedName: record.pairedName,
    paired: record.pairedChannelId != null,
    lastMessageAt: record.lastMessageAt,
  };
}

export function discordStatus(): { discord: DiscordPublic } {
  return { discord: toPublic(loadChannel()) };
}

export function clipDiscordText(text: string): string {
  if (text.length <= CLIP_AT) return text;
  return `${text.slice(0, CLIP_AT - 20).trimEnd()}…\n(trimmed)`;
}

function restHeaders(token: string, json = false): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bot ${token}`,
    "user-agent": "RealBud (https://github.com/EzAuto399/RealBud, 0.1.17)",
  };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

export async function verifyToken(fetchFn: DiscordFetch, token: string): Promise<{ username: string }> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error(BAD_TOKEN);
  let res: Response;
  try {
    res = await fetchFn(`${discordApiBase()}/api/v10/users/@me`, { headers: restHeaders(trimmed) });
  } catch {
    throw new Error(BAD_TOKEN);
  }
  if (res.status === 401) throw new Error(BAD_TOKEN);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(BAD_TOKEN);
  }
  const row = body && typeof body === "object" ? (body as { username?: unknown }) : null;
  const username = typeof row?.username === "string" ? row.username : "";
  if (!res.ok || !username) throw new Error(BAD_TOKEN);
  return { username };
}

export async function sendMessage(fetchFn: DiscordFetch, token: string, channelId: string, text: string): Promise<void> {
  const res = await fetchFn(`${discordApiBase()}/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: restHeaders(token, true),
    body: JSON.stringify({ content: clipDiscordText(text) }),
  });
  if (!res.ok) throw new Error("Discord did not accept that message");
}

export async function sendDecisionMessage(
  fetchFn: DiscordFetch,
  token: string,
  channelId: string,
  text: string,
  draftId: string,
): Promise<void> {
  const res = await fetchFn(`${discordApiBase()}/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: restHeaders(token, true),
    body: JSON.stringify({
      content: clipDiscordText(text),
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 1, custom_id: `d:${draftId}:allow`, label: "Allow" },
            { type: 2, style: 4, custom_id: `d:${draftId}:deny`, label: "Deny" },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error("Discord did not accept that message");
}

function isTurnBusy(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === 409) return true;
  const msg = error instanceof Error ? error.message : String(error);
  return /already running|already working/i.test(msg);
}

async function relayText(text: string, deps: DiscordDeps): Promise<void> {
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

async function relayPendingFromStore(deps: DiscordDeps, relay: PendingRelay = pendingRelay!): Promise<void> {
  const texts = collectAssistantAfter(relay.threadId, relay.userMessageId, deps.store);
  await relayText(texts.length ? texts.join("\n\n") : productAskFailure("Bud couldn't finish that request."), deps);
}

function queueAsk(item: QueuedAsk): void {
  inboundQueue = [item];
}

async function enqueueOrStart(prefixed: string, deps: DiscordDeps, userMessage?: Message): Promise<void> {
  const bot = deps.store.productBud();
  if (!bot) return;
  const message =
    userMessage ?? deps.store.appendMessage(bot.threadId, { role: "user", kind: "text", text: prefixed });
  if (!userMessage) deps.broadcast?.({ kind: "message", threadId: bot.threadId, message });
  if (bot.busy) {
    const replaced = inboundQueue.length > 0;
    queueAsk({ text: prefixed, userMessage: message });
    await relayText(replaced
      ? "Your latest follow-up replaces the waiting request. Both messages are saved in Ask on your Mac. Bud will pick up the latest one after the current work finishes."
      : "Saved in Ask on your Mac. Bud is working and will pick this up next. If RealBud restarts first, open Ask to resume the saved request.", deps);
    return;
  }
  pendingRelay = { threadId: bot.threadId, userMessageId: message.id };
  const modelText = prefixed.replace(/^\[Discord · [^\]]+\]\s*/i, "").trim() || prefixed;
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
  }
}

async function flushQueue(deps: DiscordDeps): Promise<void> {
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

export function onDiscordRuntimeEvent(event: RuntimeEvent): void {
  if (event.type !== "turn.completed") return;
  flushDiscordRelayForThread(event.threadId);
}

export function flushDiscordRelayForThread(threadId: string): void {
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

function asInbound(value: unknown): { channelId: string; name: string; text: string; dm: boolean; bot: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.channel_id !== "string" || !row.channel_id) return null;
  const author = row.author && typeof row.author === "object" ? (row.author as Record<string, unknown>) : null;
  const name =
    typeof author?.username === "string" && author.username.trim() ? author.username.trim() : "Discord";
  const text = typeof row.content === "string" ? row.content : "";
  return {
    channelId: row.channel_id,
    name,
    text,
    dm: row.guild_id == null,
    bot: author?.bot === true,
  };
}

export async function handleInbound(value: unknown, deps: DiscordDeps): Promise<void> {
  bound = deps;
  const inbound = asInbound(value);
  if (!inbound || inbound.bot || !inbound.dm || !inbound.text) return;
  const record = loadChannel();
  if (!record) return;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  if (record.pairedChannelId == null) {
    if (!matchesPairingCode("discord", inbound.text, now())) return;
    const next = { ...record, pairedChannelId: inbound.channelId, pairedName: inbound.name, lastMessageAt: now() };
    saveChannel(next);
    clearPairingCode("discord");
    try {
      await sendMessage(fetchFn, next.botToken, inbound.channelId, PAIR_REPLY);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logQuiet(msg, next.botToken);
    }
    deps.broadcast?.({ kind: "channels", channels: { discord: toPublic(next) } });
    return;
  }
  if (inbound.channelId !== record.pairedChannelId) {
    if (!refusedChannels.has(inbound.channelId)) {
      refusedChannels.add(inbound.channelId);
      try {
        await sendMessage(fetchFn, record.botToken, inbound.channelId, ELSEWHERE_REPLY);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logQuiet(msg, record.botToken);
      }
    }
    return;
  }
  saveChannel({ ...record, lastMessageAt: now() });
  const continuation = channelContinuation(inbound.text, deps.store);
  if (continuation !== null) { await relayText(continuation, deps); return; }
  const result = await decideRemoteText("discord", inbound.channelId, inbound.text, inbound.name);
  if (result) {
    try {
      await sendMessage(fetchFn, record.botToken, inbound.channelId, result.ok ? result.stamp : result.message);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logQuiet(msg, record.botToken);
    }
    return;
  }
  await enqueueOrStart(`[Discord · ${inbound.name}] ${inbound.text}`, deps);
}

function asInteraction(value: unknown): {
  id: string;
  token: string;
  channelId: string;
  messageId: string;
  customId: string;
  name: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;
  if (typeof row.token !== "string" || !row.token) return null;
  if (typeof row.channel_id !== "string" || !row.channel_id) return null;
  const data = row.data && typeof row.data === "object" ? (row.data as { custom_id?: unknown }) : null;
  if (typeof data?.custom_id !== "string" || !data.custom_id) return null;
  const message = row.message && typeof row.message === "object" ? (row.message as { id?: unknown }) : null;
  const messageId = typeof message?.id === "string" ? message.id : "";
  const user = row.user && typeof row.user === "object" ? (row.user as { username?: unknown }) : null;
  const member = row.member && typeof row.member === "object" ? (row.member as { user?: unknown }) : null;
  const memberUser = member?.user && typeof member.user === "object" ? (member.user as { username?: unknown }) : null;
  const username =
    typeof user?.username === "string" && user.username.trim()
      ? user.username.trim()
      : typeof memberUser?.username === "string" && memberUser.username.trim()
        ? memberUser.username.trim()
        : "Discord";
  return { id: row.id, token: row.token, channelId: row.channel_id, messageId, customId: data.custom_id, name: username };
}

export async function handleInteraction(value: unknown, deps: DiscordDeps): Promise<void> {
  bound = deps;
  const interaction = asInteraction(value);
  if (!interaction) return;
  const record = loadChannel();
  if (!record?.botToken || record.pairedChannelId == null) return;
  if (interaction.channelId !== record.pairedChannelId) return;
  const parsed = parseDecisionCallback(interaction.customId);
  if (!parsed) return;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  saveChannel({ ...record, lastMessageAt: now() });
  try {
    await fetchFn(`${discordApiBase()}/api/v10/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      headers: restHeaders(record.botToken, true),
      body: JSON.stringify({ type: 6 }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logQuiet(msg, record.botToken);
  }
  const result = await decideRemotely("discord", interaction.channelId, parsed.draftId, parsed.decision, undefined, interaction.name);
  if (!interaction.messageId) return;
  try {
    await fetchFn(`${discordApiBase()}/api/v10/channels/${interaction.channelId}/messages/${interaction.messageId}`, {
      method: "PATCH",
      headers: restHeaders(record.botToken, true),
      body: JSON.stringify({ content: clipDiscordText(result.ok ? result.stamp : result.message), components: [] }),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logQuiet(msg, record.botToken);
  }
}

function clearHeartbeats(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatAcked = true;
}

function startHeartbeats(interval: number, ws: DiscordSocketLike, signal: AbortSignal): void {
  clearHeartbeats();
  heartbeatAcked = true;
  heartbeatTimer = setInterval(() => {
    if (signal.aborted) return;
    if (!heartbeatAcked) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      return;
    }
    heartbeatAcked = false;
    try {
      ws.send(JSON.stringify({ op: 1, d: lastSeq }));
    } catch {
      /* socket gone */
    }
  }, interval);
}

function openSocket(url: string): DiscordSocketLike {
  if (wsFactory) return wsFactory(url);
  return new WebSocket(url);
}

async function resolveGatewayUrl(fetchFn: DiscordFetch, signal: AbortSignal): Promise<string> {
  const res = await fetchFn(`${discordApiBase()}/api/v10/gateway`, { signal });
  const body = (await res.json()) as { url?: unknown };
  if (typeof body.url !== "string" || !body.url) throw new Error("Discord gateway did not answer");
  const url = new URL(body.url);
  url.searchParams.set("v", "10");
  url.searchParams.set("encoding", "json");
  return url.href;
}

async function onGatewayFrame(raw: string, ws: DiscordSocketLike, deps: DiscordDeps, signal: AbortSignal): Promise<void> {
  let frame: { op?: unknown; t?: unknown; s?: unknown; d?: unknown };
  try {
    frame = JSON.parse(raw) as typeof frame;
  } catch {
    return;
  }
  if (typeof frame.s === "number" && Number.isFinite(frame.s)) lastSeq = frame.s;
  if (frame.op === 10) {
    const interval =
      frame.d && typeof frame.d === "object" && typeof (frame.d as { heartbeat_interval?: unknown }).heartbeat_interval === "number"
        ? (frame.d as { heartbeat_interval: number }).heartbeat_interval
        : 0;
    if (interval > 0) startHeartbeats(interval, ws, signal);
    const record = loadChannel();
    if (!record?.botToken) return;
    ws.send(
      JSON.stringify({
        op: 2,
        d: {
          token: record.botToken,
          intents: DISCORD_INTENTS,
          properties: { os: process.platform, browser: "RealBud", device: "RealBud" },
        },
      }),
    );
    return;
  }
  if (frame.op === 11) {
    heartbeatAcked = true;
    return;
  }
  if (frame.op === 0 && frame.t === "MESSAGE_CREATE") {
    await handleInbound(frame.d, deps);
  }
  if (frame.op === 0 && frame.t === "INTERACTION_CREATE") {
    await handleInteraction(frame.d, deps);
  }
}

function openAndServe(url: string, deps: DiscordDeps, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearHeartbeats();
      signal.removeEventListener("abort", onAbort);
      if (activeSocket === ws) activeSocket = null;
      resolve();
    };
    lastSeq = null;
    heartbeatAcked = true;
    const ws = openSocket(url);
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
      void onGatewayFrame(data, ws, deps, signal);
    });
  });
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

async function runGateway(deps: DiscordDeps, signal: AbortSignal): Promise<void> {
  let backoff = BACKOFF_START_MS;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  while (!signal.aborted) {
    const record = loadChannel();
    if (!record?.botToken) return;
    try {
      const url = await resolveGatewayUrl(fetchFn, signal);
      if (signal.aborted) return;
      await openAndServe(url, deps, signal);
      if (signal.aborted) return;
      backoff = BACKOFF_START_MS;
    } catch (error) {
      if (signal.aborted) return;
      const raw = error instanceof Error ? error.message : String(error);
      logQuiet(raw, record.botToken);
    }
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
  }
}

export function bindDiscordBridge(deps: DiscordDeps): void {
  bound = deps;
}

export function stopDiscordBridge(): void {
  abort?.abort();
  abort = null;
  try {
    activeSocket?.close();
  } catch {
    /* already closed */
  }
  activeSocket = null;
  clearHeartbeats();
  unsub?.();
  unsub = null;
  inboundQueue = [];
  pendingRelay = null;
  flushing = false;
  refusedChannels = new Set();
  lastSeq = null;
}

export function startDiscordBridge(deps?: DiscordDeps): void {
  if (deps) bound = deps;
  if (!bound) return;
  stopDiscordBridge();
  bound = deps ?? bound;
  const record = loadChannel();
  if (!record?.botToken) return;
  unsub = bound.subscribe((event) => onDiscordRuntimeEvent(event));
  if (process.env.VITEST && !wsFactory) return;
  abort = new AbortController();
  void runGateway(bound, abort.signal);
}

export async function connectDiscord(token: string, fetchFn?: DiscordFetch): Promise<{ discord: DiscordPublic }> {
  const me = await verifyToken(fetchFn ?? bound?.fetch ?? globalThis.fetch, token);
  const record: DiscordRecord = {
    botToken: token.trim(),
    botUsername: me.username,
    pairedChannelId: null,
    pairedName: null,
    connectedAt: Date.now(),
    lastMessageAt: null,
  };
  clearPairingCode("discord");
  saveChannel(record);
  startDiscordBridge();
  return { discord: toPublic(record) };
}

export function disconnectDiscord(): { discord: { connected: false } } {
  stopDiscordBridge();
  clearPairingCode("discord");
  deleteChannel();
  return { discord: { connected: false } };
}

export function discordDecisionAdapter(): RemoteChannelAdapter {
  return {
    id: "discord",
    label: "Discord",
    pairedKey() {
      const rec = loadChannel();
      return rec?.pairedChannelId ?? null;
    },
    async sendDecision(text, draftId) {
      const rec = loadChannel();
      if (!rec?.botToken || rec.pairedChannelId == null) throw new Error("Phone connection changed");
      try {
        await sendDecisionMessage(bound?.fetch ?? globalThis.fetch, rec.botToken, rec.pairedChannelId, text, draftId);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        logQuiet(raw, rec.botToken);
        throw new Error("Review card delivery was not confirmed");
      }
    },
    async sendDigest(text) {
      const rec = loadChannel();
      if (!rec?.botToken || rec.pairedChannelId == null) return;
      try {
        await sendMessage(bound?.fetch ?? globalThis.fetch, rec.botToken, rec.pairedChannelId, text);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        logQuiet(raw, rec.botToken);
      }
    },
  };
}

export const discordAdapter: ChannelAdapter = {
  async verify(creds) {
    const me = await verifyToken(bound?.fetch ?? globalThis.fetch, creds.botToken);
    return { botUsername: me.username };
  },
  start() {
    startDiscordBridge();
  },
  stop() {
    stopDiscordBridge();
  },
  status() {
    return toPublic(loadChannel());
  },
};
