import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { askNextActions } from "@/lib/ask-next";
import { AskNextActionPanel, MessagesList } from "./ChatView";

// This panel has no native dependencies; importing ChatView also imports
// the composer's desktop-capability context, which expects a browser.
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: vi.fn() }));
vi.mock("@/state/store", async importOriginal => ({ ...await importOriginal<object>(), useStore: () => ({ dispatch: vi.fn(), state: {} }), api: vi.fn() }));
// The task card's own rendering has its tests; here only what ChatView hands it.
const cards = vi.hoisted(() => [] as Array<Record<string, any>>);
vi.mock("./BrowserTaskCard", () => ({ BrowserTaskCard: (props: Record<string, any>) => { cards.push(props); return null; }, useBrowserTasks: vi.fn() }));

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

describe("Ask task card wiring", () => {
  it("passes the chosen app window to Start as the task's target", () => {
    const at = Date.now();
    const bot = { id: "bud", threadId: "t-desk", name: "Bud", busy: false, messages: [] } as any;
    const reply = { id: "m-offer", role: "bot", kind: "text", text: "Press **Start this task**", at } as any;
    const task = { id: "task-1", messageId: "m-offer", status: "proposed", request: "Open the inbox", sites: [], siteSource: "none", savedJob: null,
      actions: ["read", "click"], consequential: [], minutes: 30, budget: 40, offerExpiresAt: at + 60_000, startedAt: null, expiresAt: null, endNote: null, progress: [] };
    const onBrowserTask = vi.fn();
    cards.length = 0;
    renderToStaticMarkup(createElement(MessagesList, { bot: { ...bot, messages: [reply] }, messages: [reply], editingId: null, lastBotTextId: undefined, canRetryLast: false,
      engine: undefined, onStartEdit: vi.fn(), onCancelEdit: vi.fn(), onSubmitEdit: vi.fn(), onRegenerate: vi.fn(), productAsk: true,
      browserTasks: { "m-offer": task } as any, onBrowserTask, scrollRef: { current: null }, readingEarlier: false, onReadEarlier: vi.fn() }));
    expect(cards).toHaveLength(1);
    const window = { appName: "Mail", bundleId: "com.apple.mail", pid: 501, windowId: 77, title: "Inbox" };
    cards[0].onStartWindow(window);
    expect(onBrowserTask).toHaveBeenCalledWith("task-1", "start", window);
    cards[0].onStart("portal.fictional-strata.example");
    expect(onBrowserTask).toHaveBeenLastCalledWith("task-1", "start", "portal.fictional-strata.example");
  });
});

describe("Work step chips after Stop", () => {
  const at = Date.now();
  const ask = { id: "m-ask", role: "user", kind: "text", text: "Open the receipts", at } as any;
  const done = { id: "m-done", role: "bot", kind: "activity", tool: { name: "run", ok: true, spoken: "running run" }, at: at + 1 } as any;
  const open = { id: "m-open", role: "bot", kind: "activity", tool: { name: "read_page", spoken: "reading a page" }, at: at + 2 } as any;
  const render = (busy: boolean, messages = [ask, done, open]) => renderToStaticMarkup(createElement(MessagesList, {
    bot: { id: "bud", threadId: "t-desk", name: "Bud", busy, messages } as any, messages,
    editingId: null, lastBotTextId: undefined, canRetryLast: false, engine: undefined, onStartEdit: vi.fn(), onCancelEdit: vi.fn(),
    onSubmitEdit: vi.fn(), onRegenerate: vi.fn(), productAsk: true, scrollRef: { current: null }, readingEarlier: false, onReadEarlier: vi.fn(),
  }));

  it("reads an unfinished step as stopped once the turn has ended, and a finished one never as running", () => {
    const html = render(false);
    expect(html).toContain("reading a page · stopped");
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("ran run");
    expect(html).not.toMatch(/>running run</);
  });

  it("keeps the spinner on an unfinished step while the turn is live", () => {
    const html = render(true);
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("· stopped");
  });

  it("reads a step left open by an earlier stopped turn as stopped while a new turn runs", () => {
    const next = { id: "m-next", role: "user", kind: "text", text: "Try again", at: at + 3 } as any;
    const html = render(true, [ask, done, open, next]);
    expect(html).toContain("reading a page · stopped");
    expect(html).not.toContain("animate-spin");
  });
});
