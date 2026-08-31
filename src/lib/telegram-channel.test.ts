import { describe, expect, it } from "vitest";

import {
  channelStatusLine,
  readChannels,
  readTelegramChannel,
  telegramPairingLine,
} from "./telegram-channel";

describe("readTelegramChannel", () => {
  it("treats a missing or disconnected payload as not connected", () => {
    expect(readTelegramChannel(undefined)).toEqual({ connected: false });
    expect(readTelegramChannel({ telegram: { connected: false } })).toEqual({ connected: false });
  });

  it("reads a connected payload without echoing a leading @", () => {
    expect(
      readTelegramChannel({
        telegram: {
          connected: true,
          botUsername: "@realbud_bot",
          pairedName: "Sam",
          paired: true,
          lastMessageAt: 1_700_000_000_000,
        },
      }),
    ).toEqual({
      connected: true,
      botUsername: "realbud_bot",
      pairedName: "Sam",
      paired: true,
      lastMessageAt: 1_700_000_000_000,
    });
  });
});

describe("readChannels", () => {
  it("reads telegram and discord independently, defaulting a missing platform", () => {
    expect(readChannels(undefined)).toEqual({
      telegram: { connected: false },
      discord: { connected: false },
    });
    expect(
      readChannels({
        telegram: {
          connected: true,
          botUsername: "@realbud_bot",
          pairedName: "Sam",
          paired: true,
          lastMessageAt: 1_700_000_000_000,
        },
      }),
    ).toEqual({
      telegram: {
        connected: true,
        botUsername: "realbud_bot",
        pairedName: "Sam",
        paired: true,
        lastMessageAt: 1_700_000_000_000,
      },
      discord: { connected: false },
    });
    expect(
      readChannels({
        telegram: { connected: false },
        discord: {
          connected: true,
          botUsername: "realbud",
          pairedName: null,
          paired: false,
          lastMessageAt: null,
        },
      }),
    ).toEqual({
      telegram: { connected: false },
      discord: {
        connected: true,
        botUsername: "realbud",
        pairedName: null,
        paired: false,
        lastMessageAt: null,
      },
    });
  });
});

describe("telegram pairing line", () => {
  it("asks the first chat to write when unpaired", () => {
    expect(
      telegramPairingLine({ paired: false, pairedName: null, lastMessageAt: null }),
    ).toBe("Now message the bot once from your phone — the first chat to write pairs with this Mac.");
  });

  it("names the pair and a last-message stamp when present", () => {
    expect(
      telegramPairingLine({ paired: true, pairedName: "Sam", lastMessageAt: null }),
    ).toBe("Paired with Sam");
    expect(
      telegramPairingLine(
        { paired: true, pairedName: "Sam", lastMessageAt: 1_700_000_000_000 },
        1_700_000_000_000 + 120_000,
      ),
    ).toBe("Paired with Sam · last message 2 min ago");
  });
});

describe("channelStatusLine", () => {
  it("asks Discord for a first DM when unpaired", () => {
    expect(
      channelStatusLine("discord", { paired: false, pairedName: null, lastMessageAt: null }),
    ).toBe("Now DM the bot once — the first chat to write pairs with this Mac.");
  });

  it("keeps Telegram copy and a last-message stamp", () => {
    expect(
      channelStatusLine(
        "telegram",
        { paired: true, pairedName: "Sam", lastMessageAt: 1_700_000_000_000 },
        1_700_000_000_000 + 120_000,
      ),
    ).toBe("Paired with Sam · last message 2 min ago");
  });
});
