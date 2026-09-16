import { relativeAgo } from "./au";

export type ChannelPlatform = "telegram" | "discord" | "slack";

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
  slack: ChannelStatus;
};

export type TelegramDisconnected = ChannelDisconnected;
export type TelegramConnected = ChannelConnected;
export type TelegramChannel = ChannelStatus;

export const LIVE_CHANNEL_PLATFORMS: ChannelPlatform[] = ["telegram", "discord", "slack"];

export const CHANNEL_PLATFORM_LABEL: Record<ChannelPlatform, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
};

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
    slack: readChannelStatus(rec.slack),
  };
}

/** Merge a partial SSE/API channels patch onto the current roster. */
export function mergeChannelsPatch(prev: ChannelsState | null, patch: unknown): ChannelsState {
  const base = prev ?? {
    telegram: { connected: false } as ChannelStatus,
    discord: { connected: false } as ChannelStatus,
    slack: { connected: false } as ChannelStatus,
  };
  if (!patch || typeof patch !== "object") return base;
  const rec = patch as Record<string, unknown>;
  return {
    telegram: "telegram" in rec ? readChannelStatus(rec.telegram) : base.telegram,
    discord: "discord" in rec ? readChannelStatus(rec.discord) : base.discord,
    slack: "slack" in rec ? readChannelStatus(rec.slack) : base.slack,
  };
}

export function channelsAwaitingPair(channels: ChannelsState | null | undefined): boolean {
  if (!channels) return false;
  return LIVE_CHANNEL_PLATFORMS.some((platform) => {
    const row = channels[platform];
    return row.connected && !row.paired;
  });
}

export const CHANNELS_UPDATED_EVENT = "realbud:channels";

export function readTelegramChannel(body: unknown): TelegramChannel {
  return readChannels(body).telegram;
}

export function channelStatusLine(
  _platform: ChannelPlatform,
  status: Pick<ChannelConnected, "paired" | "pairedName" | "lastMessageAt">,
  now = Date.now(),
): string {
  if (!status.paired) {
    return "Create a pairing code on this Mac, then send it to the bot in a private chat.";
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

export function channelRowChip(status: ChannelStatus): string {
  if (!status.connected) return "Off";
  if (!status.paired) return "Pair chat";
  return status.pairedName?.trim() ? `Paired · ${status.pairedName.trim()}` : "Paired";
}
