import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { Composer } from "./Composer";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { bots: [], askWorkContext: null }, dispatch: fixture.dispatch }),
  visibleMessages: (bot: Bot) => bot.messages,
}));
const caps = vi.hoisted(() => ({ dictation: { available: false as boolean } }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({ capabilities: caps }) }));

function render(heldReason?: NonNullable<Bot["queuedMessage"]>["heldReason"], busy = false, threadId = "task-1") {
  const bot: Bot = { id: "bud", threadId: "task-1", name: "Bud", title: "Assistant", description: "", notifications: false,
    color: "green", unread: false, busy, messages: [], modelSelection: { instanceId: "fixture", model: "fixture" },
    queuedMessage: { id: "queued-1", text: "Review repair replies; prepare local draft text.", at: 1, threadId, ...(heldReason ? { heldReason } : {}) },
  };
  return renderToStaticMarkup(createElement(Composer, { bot, productAsk: true }));
}

describe("held connected-app follow-up", () => {
  it.each([false, true])("shows review recovery instead of automatic dispatch language when busy=%s", busy => {
    const html = render("connected-app-settings-changed", busy);
    expect(html).toContain("Paused — app settings changed");
    expect(html).toContain("Review repair replies; prepare local draft text.");
    expect(html).toContain("Edit queued to review, then send again.");
    expect(html).toContain('aria-label="Edit queued follow-up"');
    expect(html).toContain('aria-label="Discard queued follow-up"');
    expect(html).not.toContain("ready to start");
    expect(html).not.toContain("starts when");
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("preserves normal queue timing and does not show another task's held instruction", () => {
    expect(render(undefined, true)).toContain("starts when Bud finishes");
    expect(render()).toContain("ready to start");
    expect(render("connected-app-settings-changed", false, "other-task")).not.toContain("Review repair replies");
  });

  it("offers generic recovery for an unknown persisted hold", () => {
    const html = render("review-required");
    expect(html).toContain("Paused — review required");
    expect(html).not.toContain("app settings changed");
  });
});

describe("Ask dictation control", () => {
  it("shows Hold to speak on the product Ask composer when dictation is available", () => {
    caps.dictation.available = true;
    const html = render();
    expect(html).toContain('aria-label="Hold to speak into the message"');
    expect(html).toContain("Hold to speak");
    expect(html).toContain("Hold Speak to dictate");
    caps.dictation.available = false;
  });

  it("keeps Speak hidden when dictation is unavailable", () => {
    caps.dictation.available = false;
    expect(render()).not.toContain('aria-label="Hold to speak into the message"');
  });
});
