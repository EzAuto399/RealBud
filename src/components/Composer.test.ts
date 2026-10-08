import { createElement, type ComponentProps, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { DeskSnapshot } from "@/lib/desk";
import { buildDeskQueue } from "@/lib/desk-queue";
import { deskCaseInstruction } from "@/lib/desk-ask-context";
import { Composer } from "./Composer";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), stateUpdates: [] as unknown[], preview: null as string | null, store: {} as Record<string, unknown> }));
vi.mock('@/lib/design-preview', () => ({ get DESIGN_PREVIEW_REASON() { return fixture.preview; } }));
// Keep React's real hooks while observing state requests from event handlers.
// A server render lets the tests inspect the control wiring without a DOM.
vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: <T,>(initial: T | (() => T)) => {
    const [value, set] = react.useState(initial);
    return [value, (next: SetStateAction<T>) => { fixture.stateUpdates.push(next); set(next); }];
  } };
});
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { bots: [], askWorkContext: null, ...fixture.store }, dispatch: fixture.dispatch }),
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

beforeEach(() => { vi.clearAllMocks(); fixture.preview = null; fixture.store = {}; fixture.stateUpdates.length = 0; caps.dictation.available = false; });
afterEach(() => { vi.unstubAllGlobals(); });

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

describe("Ask while Bud is re-checking", () => {
  it("keeps the draft box open and never renders the notice before a send is tried", () => {
    const bot: Bot = { id: "bud", threadId: "task-1", name: "Bud", title: "Assistant", description: "", notifications: false,
      color: "green", unread: false, busy: false, messages: [], modelSelection: { instanceId: "fixture", model: "fixture" } };
    const html = renderToStaticMarkup(createElement(Composer, { bot, productAsk: true, askReady: false, askRecheckPending: true, readiness: createElement("span") }));
    expect(html).toContain('aria-label="Tell Bud what outcome you need"');
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain("You can draft while we connect.");
    expect(html).not.toContain("Bud is re-checking");
  });
});

describe("Ask when model access is withdrawn", () => {
  const blocked = () => {
    const bot: Bot = { id: "bud", threadId: "task-1", name: "Bud", title: "Assistant", description: "", notifications: false,
      color: "green", unread: false, busy: false, messages: [], modelSelection: { instanceId: "fixture", model: "fixture" } };
    return renderToStaticMarkup(createElement(Composer, { bot, productAsk: true, askReady: false, readiness: createElement("span") }));
  };

  it("names the terminal hold and keeps drafting open instead of promising a reconnect", () => {
    fixture.store = { connected: true, hermes: { modelAccess: { managed: true, withdrawn: true, attached: false, detail: "Fictional withdrawn grant." } } };
    const html = blocked();
    expect(html).toContain("Disconnected from your office. You can still write a draft to keep.");
    expect(html).toContain("Reconnect in Workspace → Website account · Shift + Enter for a new line");
    expect(html).not.toMatch(/draft while we connect|Connect Bud to start/);
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
  });

  it("keeps the connecting copy while the local service is reconnecting", () => {
    fixture.store = { connected: false, hermes: { modelAccess: { managed: true, withdrawn: true, attached: false, detail: "Fictional withdrawn grant." } } };
    const html = blocked();
    expect(html).toContain("You can draft while we connect.");
    expect(html).toContain("Connect Bud to start");
    expect(html).not.toContain("Reconnect in Workspace");
  });
});

// Capture the returned control tree inside a genuine React hook render. Child
// components need not mount to exercise this composer's own event handlers.
function composerControls(extra: Partial<ComponentProps<typeof Composer>> = {}) {
  let tree: ReactNode;
  const bot: Bot = { id: "bud", threadId: "task-1", name: "Bud", title: "Assistant", description: "", notifications: false,
    color: "green", unread: false, busy: false, messages: [], modelSelection: { instanceId: "fixture", model: "fixture" } };
  function Capture() { tree = Composer({ bot, productAsk: true, ...extra }); return null; }
  renderToStaticMarkup(createElement(Capture));
  const elements: ReactElement<Record<string, unknown>>[] = [];
  function visit(node: ReactNode) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object" || !("props" in node)) return;
    const element = node as ReactElement<Record<string, unknown>>;
    elements.push(element);
    visit(element.props.children as ReactNode);
  }
  visit(tree);
  return elements;
}
function controls(extra: Partial<ComponentProps<typeof Composer>> = {}) {
  const elements = composerControls(extra);
  const mic = elements.find(element => element.type === "button" && element.props["aria-label"] === "Hold to speak into the message");
  if (!mic) throw new Error("Dictation control missing");
  return mic.props as ComponentProps<"button">;
}

describe('design preview Ask controls', () => {
  it.each([false, true])('keeps a draft while preventing click and Enter submission when busy=%s', async busy => {
    fixture.preview = 'This design preview uses example data.';
    const savedDraft = JSON.stringify({ 'bot:bud': 'connect Google Sheets' });
    const storage = { getItem: vi.fn((key: string) => key === 'omb-drafts' ? savedDraft : null), setItem: vi.fn() };
    vi.stubGlobal('localStorage', storage);
    const bot: Bot = { id: 'bud', threadId: 'task-1', name: 'Bud', title: 'Assistant', description: '', notifications: false,
      color: 'green', unread: false, busy, messages: [], modelSelection: { instanceId: 'fixture', model: 'fixture' } };
    const elements = composerControls({ bot });
    const textarea = elements.find(element => element.type === 'textarea')!.props as ComponentProps<'textarea'>;
    expect(textarea.disabled).toBe(false);
    expect(textarea.value).toBe('connect Google Sheets');
    const labels = busy ? ['Update current work', 'Do this next'] : ['Start this work'];
    for (const label of labels) {
      const button = elements.find(element => element.props['aria-label'] === label)!.props as ComponentProps<'button'>;
      expect(button.disabled).toBe(true);
      button.onClick!({} as Parameters<NonNullable<typeof button.onClick>>[0]);
    }
    textarea.onKeyDown!(keyEvent('Enter') as unknown as Parameters<NonNullable<typeof textarea.onKeyDown>>[0]);
    await Promise.resolve();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

function keyEvent(key: string, extra: Record<string, unknown> = {}) {
  return { key, repeat: false, nativeEvent: { isComposing: false, keyCode: 0 }, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra } as unknown as Parameters<NonNullable<ComponentProps<"button">["onKeyDown"]>>[0];
}

function dictationBridge() {
  const requests: Array<(granted: boolean) => void> = [];
  const permRequestMic = vi.fn(() => new Promise<boolean>(resolve => requests.push(resolve)));
  const bridge = { permRequestMic, speechStart: vi.fn(), speechFinish: vi.fn() };
  caps.dictation.available = true;
  vi.stubGlobal("window", { ogb: bridge });
  return { bridge, requests };
}

async function settlePermission(request: (granted: boolean) => void, granted = true) {
  request(granted);
  await Promise.resolve();
  await Promise.resolve();
}

describe("Ask keyboard dictation", () => {
  it.each([" ", "Enter"])("holds %j without submitting, and release cancels a pending permission request", async key => {
    const { bridge, requests } = dictationBridge();
    const mic = controls();
    const down = keyEvent(key);
    mic.onKeyDown!(down);
    await Promise.resolve();
    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(down.stopPropagation).toHaveBeenCalledOnce();
    expect(bridge.permRequestMic).toHaveBeenCalledOnce();
    mic.onKeyDown!(keyEvent(key, { repeat: true }));
    mic.onKeyDown!(keyEvent(key));
    expect(bridge.permRequestMic).toHaveBeenCalledOnce();
    const up = keyEvent(key);
    mic.onKeyUp!(up);
    expect(up.preventDefault).toHaveBeenCalledOnce();
    expect(up.stopPropagation).toHaveBeenCalledOnce();
    await settlePermission(requests[0]);
    expect(fixture.stateUpdates).not.toContain(true);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("keeps pointer hold and release with capture", async () => {
    const { requests } = dictationBridge();
    const mic = controls();
    const pointer = { button: 0, pointerId: 7, preventDefault: vi.fn(), currentTarget: { setPointerCapture: vi.fn() } };
    mic.onPointerDown!(pointer as unknown as Parameters<NonNullable<typeof mic.onPointerDown>>[0]);
    await Promise.resolve();
    expect(pointer.currentTarget.setPointerCapture).toHaveBeenCalledWith(7);
    mic.onPointerUp!(pointer as unknown as Parameters<NonNullable<typeof mic.onPointerUp>>[0]);
    await settlePermission(requests[0]);
    expect(fixture.stateUpdates).not.toContain(true);
  });

  it("starts recording after permission only while the same key is still held", async () => {
    const { requests } = dictationBridge();
    const mic = controls();
    mic.onKeyDown!(keyEvent(" "));
    await Promise.resolve();
    await settlePermission(requests[0]);
    expect(fixture.stateUpdates).toContain(true);
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("ignores composition, repeats and modifier shortcuts", async () => {
    const { bridge } = dictationBridge();
    const mic = controls();
    for (const extra of [{ repeat: true }, { nativeEvent: { isComposing: true } }, { nativeEvent: { keyCode: 229 } }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      mic.onKeyDown!(keyEvent("Enter", extra));
    }
    await Promise.resolve();
    expect(bridge.permRequestMic).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it.each(["blur", "escape"])("cancels a hold on %s without allowing its permission reply to restart it", async cancel => {
    const { requests } = dictationBridge();
    const mic = controls();
    mic.onKeyDown!(keyEvent("Enter"));
    await Promise.resolve();
    if (cancel === "blur") mic.onBlur!({} as Parameters<NonNullable<typeof mic.onBlur>>[0]);
    else mic.onKeyDown!(keyEvent("Escape"));
    await settlePermission(requests[0]);
    expect(fixture.stateUpdates).not.toContain(true);
  });

  it("ignores an older permission reply after a new hold begins", async () => {
    const { requests } = dictationBridge();
    const mic = controls();
    mic.onKeyDown!(keyEvent(" "));
    await Promise.resolve();
    mic.onKeyUp!(keyEvent(" "));
    mic.onKeyDown!(keyEvent("Enter"));
    await Promise.resolve();
    await settlePermission(requests[0]);
    expect(fixture.stateUpdates).not.toContain(true);
    await settlePermission(requests[1]);
    expect(fixture.stateUpdates).toContain(true);
  });

  it("does not release a keyboard hold when unrelated pointer capture ends", async () => {
    const { requests } = dictationBridge();
    const mic = controls();
    mic.onKeyDown!(keyEvent("Enter"));
    await Promise.resolve();
    mic.onLostPointerCapture!({} as Parameters<NonNullable<typeof mic.onLostPointerCapture>>[0]);
    mic.onKeyUp!(keyEvent(" "));
    await settlePermission(requests[0]);
    expect(fixture.stateUpdates).toContain(true);
  });

  it("blocks dictation while an approval owns the composer", async () => {
    const { bridge } = dictationBridge();
    const mic = controls({ bot: { id: "bud", threadId: "task-1", name: "Bud", title: "Assistant", description: "", notifications: false,
      color: "green", unread: false, busy: false, modelSelection: { instanceId: "fixture", model: "fixture" }, messages: [{ id: "approval", at: 1, role: "bot", kind: "options", text: "", card: { title: "Review", subtitle: "Review first", requestId: "request-1", tool: "read_file", options: [] } }] } });
    expect(mic.disabled).toBe(true);
    mic.onKeyDown!(keyEvent("Enter"));
    await Promise.resolve();
    expect(bridge.permRequestMic).not.toHaveBeenCalled();
  });
});

describe("Ask work action labels", () => {
  it("names the current-work action and keeps the Enter hint consistent", () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === "omb-drafts" ? JSON.stringify({ "bot:bud": "Use the updated address" }) : null });
    const html = render(undefined, true);
    expect(html).toContain('class="flex items-center gap-2 ask-busy-actions"');
    expect(html).toContain('aria-label="Update current work"');
    expect(html).toContain(">Update current work</span>");
    expect(html).toContain(">Do next</span>");
    expect(html).toContain("Enter to update current work");
    expect(html).not.toContain("Enter to start");
    expect(html).not.toContain("Steer now");
  });
});

describe("attached Desk case next step", () => {
  const attach = (caseId: string, draft?: string) => vi.stubGlobal("localStorage", {
    getItem: (key: string) => key === "omb-draft-attachments"
      ? JSON.stringify({ "bot:bud": [{ kind: "paste", id: `desk-case-${caseId}`, label: "Money · 12 Oak St", text: "Selected RealBud case.", size: 22, lines: 1 }] })
      : key === "omb-drafts" && draft ? JSON.stringify({ "bot:bud": draft }) : null,
    setItem: () => {},
  });
  const desk = {
    properties: [{ id: "p1", address: "12 Oak St" }], sources: [], ledger: [],
    workItems: [{ id: "w1", propertyId: "p1", kind: "arrears-reminder", state: "proposed", occurrenceKey: "p1:week", sourceIds: [] }],
    drafts: [{ id: "d1", propertyId: "p1", workItemId: "w1", kind: "friendly-reminder", status: "pending", to: "Tenant", body: "Hi", createdAt: 1 }],
    escalations: [{ id: "e1", propertyId: "p1", reason: "dispute", detail: "Tenant disputes the amount", createdAt: 2 }],
  };

  it("offers one step from the case's current Desk state before Back to this case, without sending", () => {
    attach("draft:d1");
    fixture.store = { desk };
    const html = render();
    expect(html).toContain('aria-label="Next step: Review draft"');
    expect(html.indexOf("Next step")).toBeLessThan(html.indexOf("Back to this case"));
    expect(fixture.api).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("never offers a draft on a licensee case", () => {
    attach("esc:e1");
    fixture.store = { desk };
    const html = render();
    expect(html).toContain('aria-label="Next step: Summarise for licensee"');
    expect(html).not.toContain("Review draft");
  });

  it("offers nothing for a decided case or one no longer on Desk", () => {
    attach("draft:d1");
    fixture.store = { desk: { ...desk, drafts: [{ ...desk.drafts[0], status: "allowed" }] } };
    expect(render()).not.toContain("Next step");
    attach("draft:gone");
    fixture.store = { desk };
    const html = render();
    expect(html).not.toContain("Next step");
    expect(html).toContain("Back to this case");
  });

  it("does not offer the step the composer already holds", () => {
    fixture.store = { desk };
    const item = buildDeskQueue(desk as unknown as DeskSnapshot).find(row => row.id === "draft:d1")!;
    attach("draft:d1", deskCaseInstruction(item, "refine"));
    expect(render()).not.toContain("Next step");
    attach("draft:d1", deskCaseInstruction(item, "next"));
    expect(render()).toContain('aria-label="Next step: Review draft"');
  });
});
