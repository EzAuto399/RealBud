import { describe, expect, it } from "vitest";
import { channelMessage } from "./channel-message";

describe("saved phone message presentation", () => {
  it.each(["Telegram", "Discord", "Slack"])("separates %s without changing the body", channel => {
    expect(channelMessage(`[${channel} · Yoda] Please follow up.\n\nKeep this paragraph.`)).toEqual({ channel, sender: "Yoda", body: "Please follow up.\n\nKeep this paragraph." });
  });
  it("handles a stamp-only legacy record without inventing content", () => {
    expect(channelMessage("[Telegram · Yoda]")?.body).toBe("");
  });
  it("strips only the outer label", () => {
    expect(channelMessage("[Telegram · Yoda]\n[Slack · Alex] quoted message")?.body).toBe("[Slack · Alex] quoted message");
  });
  it.each(["Discuss [Telegram · Yoda]", "[Telegram · Yoda]suffix", "[Telegram · ] Hello", "[Telegram · Yoda\nAlex] Hello", "[Email · Yoda] Hello", "[Telegram · Yoda", "Hello", `[Telegram · ${"a".repeat(201)}] Hello`])("leaves ordinary and malformed text alone: %s", text => {
    expect(channelMessage(text)).toBeNull();
  });
});
