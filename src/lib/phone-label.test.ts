import { describe, expect, it } from "vitest";

import { draftViaLine, phoneChip, phoneChipTone, phonePaired } from "./phone-label";
import type { ChannelsState } from "./telegram-channel";

const off: ChannelsState = {
  telegram: { connected: false },
  discord: { connected: false },
  slack: { connected: false },
};

describe("phone labels", () => {
  it("treats a channel as paired only when connected and bound", () => {
    expect(phonePaired(null)).toBe(false);
    expect(phonePaired(off)).toBe(false);
    expect(
      phonePaired({
        ...off,
        telegram: { connected: true, botUsername: "realbud_bot", pairedName: null, paired: false, lastMessageAt: null },
      }),
    ).toBe(false);
    expect(
      phonePaired({
        ...off,
        telegram: { connected: true, botUsername: "realbud_bot", pairedName: "Yoda", paired: true, lastMessageAt: 1 },
      }),
    ).toBe(true);
  });

  it("says Phone off when nothing is connected", () => {
    expect(phoneChip(null)).toBe("Phone off");
    expect(phoneChipTone(null)).toBe("muted");
    expect(phoneChip(off)).toBe("Phone off");
  });

  it("asks to pair when a bot is connected but no chat is paired", () => {
    const state: ChannelsState = {
      ...off,
      telegram: {
        connected: true,
        botUsername: "realbud_bot",
        pairedName: null,
        paired: false,
        lastMessageAt: null,
      },
    };
    expect(phoneChip(state)).toBe("Phone · pair chat");
    expect(phoneChipTone(state)).toBe("hold");
  });

  it("names the paired platform including Slack", () => {
    const telegram: ChannelsState = {
      ...off,
      telegram: {
        connected: true,
        botUsername: "realbud_bot",
        pairedName: "Yoda",
        paired: true,
        lastMessageAt: 1,
      },
    };
    expect(phoneChip(telegram)).toBe("Phone · Telegram");
    expect(phoneChipTone(telegram)).toBe("agency");

    const slack: ChannelsState = {
      ...off,
      slack: {
        connected: true,
        botUsername: "realbud",
        pairedName: "Sam",
        paired: true,
        lastMessageAt: 1,
      },
    };
    expect(phoneChip(slack)).toBe("Phone · Slack");
  });

  it("joins multiple paired platforms", () => {
    const state: ChannelsState = {
      telegram: {
        connected: true,
        botUsername: "t",
        pairedName: "A",
        paired: true,
        lastMessageAt: 1,
      },
      discord: { connected: false },
      slack: {
        connected: true,
        botUsername: "s",
        pairedName: "B",
        paired: true,
        lastMessageAt: 1,
      },
    };
    expect(phoneChip(state)).toBe("Phone · Telegram + Slack");
  });
});

describe("draftViaLine", () => {
  it("prefixes Allowed or Denied with the via stamp", () => {
    expect(draftViaLine({ status: "allowed", via: "via Telegram · Yoda" })).toBe("Allowed via Telegram · Yoda");
    expect(draftViaLine({ status: "denied", via: "via Discord · Sam" })).toBe("Denied via Discord · Sam");
    expect(draftViaLine({ status: "pending" })).toBeNull();
  });
});
