import { CHANNEL_PLATFORM_LABEL, LIVE_CHANNEL_PLATFORMS, type ChannelsState } from "./telegram-channel";

/** A live platform is paired when the bot is connected and a chat is bound. */
export function phonePaired(channels: ChannelsState | null | undefined): boolean {
  if (!channels) return false;
  return LIVE_CHANNEL_PLATFORMS.some((id) => {
    const row = channels[id];
    return row.connected && row.paired;
  });
}

/** User chrome for Desk / You — which phone door is live. */
export function phoneChip(channels: ChannelsState | null | undefined): string {
  if (!channels) return "Phone off";
  const paired = LIVE_CHANNEL_PLATFORMS.filter((id) => {
    const row = channels[id];
    return row.connected && row.paired;
  }).map((id) => CHANNEL_PLATFORM_LABEL[id]);
  if (paired.length === 0) {
    const connected = LIVE_CHANNEL_PLATFORMS.some((id) => channels[id].connected);
    return connected ? "Phone · pair chat" : "Phone off";
  }
  if (paired.length === 1) return `Phone · ${paired[0]}`;
  return `Phone · ${paired.join(" + ")}`;
}

export function phoneChipTone(channels: ChannelsState | null | undefined): "agency" | "hold" | "muted" {
  if (!channels) return "muted";
  if (phonePaired(channels)) return "agency";
  const anyConnected = LIVE_CHANNEL_PLATFORMS.some((id) => channels[id].connected);
  return anyConnected ? "hold" : "muted";
}

/** Short line for a recorded draft decision that arrived from phone or Desk. */
export function draftViaLine(draft: { status: string; via?: string }): string | null {
  if (!draft.via?.trim()) return null;
  if (draft.status === "allowed") return `Allowed ${draft.via.trim()}`;
  if (draft.status === "denied") return `Denied ${draft.via.trim()}`;
  return draft.via.trim();
}
