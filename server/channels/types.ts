// Shared channel-adapter contract. Telegram already ships these jobs as
// verifyToken + startTelegramBridge / stopTelegramBridge + toPublic(loadChannel()).
// `start()` assumes the platform bind* function has been called.

export type ChannelStatus = {
  connected: true;
  botUsername: string;
  pairedName: string | null;
  paired: boolean;
  lastMessageAt: number | null;
};

export type ChannelPublic = ChannelStatus | { connected: false };

export type ChannelAdapter = {
  verify(creds: { botToken: string }): Promise<{ botUsername: string }>;
  start(): void;
  stop(): void;
  status(): ChannelPublic;
};

export type ChannelsPayload = {
  telegram: ChannelPublic;
  discord: ChannelPublic;
};
