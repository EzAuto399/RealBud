import { relativeAgo } from "./au";

export type ChannelPlatform = "telegram" | "discord";

export type ChannelDisconnected = { connected: false };

export type ChannelConnected = {
  connected: true;
  botUsername: string;
  pairedName: string | null;
  paired: boolean;
  lastMessageAt: number | null;
};

export type ChannelStatus = ChannelDisconnected | ChannelConnected;

export type ChannelsState = {
  telegram: ChannelStatus;
  discord: ChannelStatus;
};

export type TelegramDisconnected = ChannelDisconnected;
export type TelegramConnected = ChannelConnected;
export type TelegramChannel = ChannelStatus;

function readChannelStatus(raw: unknown): ChannelStatus {
  if (!raw || typeof raw !== "object") return { connected: false };
  const rec = raw as Record<string, unknown>;
  if (rec.connected !== true) return { connected: false };
  return {
    connected: true,
    botUsername: typeof rec.botUsername === "string" ? rec.botUsername.replace(/^@/, "") : "",
    pairedName: typeof rec.pairedName === "string" && rec.pairedName.trim() ? rec.pairedName : null,
    paired: rec.paired === true,
    lastMessageAt: typeof rec.lastMessageAt === "number" ? rec.lastMessageAt : null,
  };
}

export function readChannels(body: unknown): ChannelsState {
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    telegram: readChannelStatus(rec.telegram),
    discord: readChannelStatus(rec.discord),
  };
}

export function readTelegramChannel(body: unknown): TelegramChannel {
  return readChannels(body).telegram;
}

export function channelStatusLine(
  platform: ChannelPlatform,
  status: Pick<ChannelConnected, "paired" | "pairedName" | "lastMessageAt">,
  now = Date.now(),
): string {
  if (!status.paired) {
    return platform === "discord"
      ? "Now DM the bot once — the first chat to write pairs with this Mac."
      : "Now message the bot once from your phone — the first chat to write pairs with this Mac.";
  }
  const who = status.pairedName?.trim() ? `Paired with ${status.pairedName.trim()}` : "Paired";
  return status.lastMessageAt ? `${who} · last message ${relativeAgo(status.lastMessageAt, now)}` : who;
}

export function telegramPairingLine(
  channel: Pick<TelegramConnected, "paired" | "pairedName" | "lastMessageAt">,
  now = Date.now(),
): string {
  return channelStatusLine("telegram", channel, now);
}
