import { describe, expect, it } from "vitest";

import {
  askLayerVoice,
  deniesLinkedConnection,
  linkedToolsVoice,
  reconcileAskWorkerText,
} from "./ask-layer-voice.ts";

describe("ask layer voice", () => {
  const screenshotLie =
    "Nothing — I can't see inside Notion. No connection is active, no read has happened, and nothing about your Notion workspace is verified in this session; I'd only be guessing if I said otherwise.";

  it("treats the screenshot Bud reply as a denied connection", () => {
    expect(deniesLinkedConnection(screenshotLie)).toBe(true);
    expect(deniesLinkedConnection("Yo Da's Space is on this device. Visible now: Getting Started.")).toBe(false);
    expect(deniesLinkedConnection("Ask still cannot send.")).toBe(false);
    expect(deniesLinkedConnection(
      "Notion isn't a RealBud office source, so there's no connection card for it",
      [{ label: "Notion", connected: true, account: "Yo Da's Space" }],
    )).toBe(true);
    expect(deniesLinkedConnection(
      "Instagram isn't a RealBud office source",
      [{ label: "Notion", connected: true }],
    )).toBe(false);
  });

  it("repeats the card detail instead of inventing a second story", () => {
    expect(askLayerVoice({
      detail: "Yo Da's Space is on this device. Visible now: Getting Started. Ask still cannot send.",
    })).toBe("Yo Da's Space is on this device. Visible now: Getting Started. Ask still cannot send.");
  });

  it("replaces a worker denial when a named key is on this device", () => {
    expect(reconcileAskWorkerText(screenshotLie, [
      { label: "Notion", connected: true, account: "Yo Da's Space", lastPeekTitles: ["Getting Started"] },
    ])).toBe("Yo Da's Space (Notion) is on this device. Visible now: Getting Started. Ask still cannot send.");
    expect(reconcileAskWorkerText(screenshotLie, [
      { label: "Notion", connected: true, account: "Yo Da's Space" },
    ])).toBe("Yo Da's Space (Notion) is on this device. Ask still cannot send.");
    expect(reconcileAskWorkerText(screenshotLie, [])).toBe(screenshotLie);
    expect(linkedToolsVoice([{ label: "Notion", connected: false }])).toBe("");
  });
});
