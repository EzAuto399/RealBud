import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { askNextActions } from "@/lib/ask-next";
import { AskNextActionPanel } from "./ChatView";

// This panel has no native dependencies; importing ChatView also imports
// the composer's desktop-capability context, which expects a browser.
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: vi.fn() }));

const actions = () => ({ onAsk: vi.fn(), onRecheck: vi.fn(), onDesk: vi.fn(), onYou: vi.fn() });
const suggestions = (lastBotText: string, threadIdle = true) => askNextActions({
  miss: false, needsYou: 0, workerReady: true, lastRunAt: 100, lastBotText, threadIdle,
});

describe("Ask connection follow-up placement", () => {
  it.each(["Gmail", "Outlook"])("exposes %s's one check action before the closed task menu", app => {
    const handlers = actions();
    const html = renderToStaticMarkup(createElement(AskNextActionPanel, {
      ...handlers,
      next: suggestions(`I opened ${app} sign-in. Finish sign-in, then press Check connection.`),
    }));
    const [visible, collapsed] = html.split("<details");
    expect(visible).toContain(`Check ${app} connection`);
    expect(visible).toContain('aria-label="Connection follow-up"');
    expect(visible).toContain('type="button"');
    expect(collapsed).not.toContain(`Check ${app} connection`);
    expect(collapsed).toContain("Tasks, book &amp; saved jobs");
    expect(collapsed.split(">")[0]).not.toContain("open=");
    expect(handlers.onAsk).not.toHaveBeenCalled();
  });

  it("keeps the visible follow-up disabled during an action", () => {
    const html = renderToStaticMarkup(createElement(AskNextActionPanel, {
      ...actions(), disabled: true, next: suggestions("I opened Gmail sign-in."),
    }));
    const visible = html.split("<details")[0];
    expect(visible).toMatch(/<button[^>]+disabled=""/);
  });

  it.each([
    ["I opened Gmail sign-in.", false],
    ["Gmail is connected. You can prepare a task.", true],
    ["No connection attempt is awaiting your sign-in.", true],
  ])("does not leave an obsolete or in-flight check action for %s", (reply, idle) => {
    const html = renderToStaticMarkup(createElement(AskNextActionPanel, {
      ...actions(), next: suggestions(String(reply), Boolean(idle)),
    }));
    expect(html).not.toContain('aria-label="Connection follow-up"');
    expect(html).not.toContain("Check Gmail connection");
  });

  it("preserves expanded tasks and their contents for an attended job", () => {
    const html = renderToStaticMarkup(createElement(AskNextActionPanel, {
      ...actions(), expanded: true,
      next: [{ id: "attend-now", kind: "attend", label: "Run beside me now", description: "Start the saved job.", recipeId: "job-1" }],
      children: createElement("span", null, "Other task starters"),
    }));
    expect(html).toMatch(/<details[^>]+open=""/);
    expect(html).toContain("Run beside me now");
    expect(html).toContain("Other task starters");
    expect(html).not.toContain('aria-label="Connection follow-up"');
  });
});
