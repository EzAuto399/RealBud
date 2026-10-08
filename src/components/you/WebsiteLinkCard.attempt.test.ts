import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserLinkPhase } from "./browser-link";

// Effects are collected and run after the server render so the card's attempt reporting can be observed.
const fakes = vi.hoisted(() => ({ note: vi.fn(), phase: { kind: "idle" } as unknown, effects: [] as Array<() => unknown> }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useEffect: (effect: () => unknown) => { fakes.effects.push(effect); } }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: vi.fn() }), api: vi.fn() }));
vi.mock("@/lib/use-setup-state", () => ({ noteLinkAttempt: fakes.note }));
vi.mock("./browser-link", async importOriginal => ({
  ...await importOriginal<object>(),
  useBrowserLink: () => ({ status: { state: "unlinked" }, phase: fakes.phase, error: "", setError: vi.fn(), setPhase: vi.fn(), refresh: vi.fn(), start: vi.fn(), cancel: vi.fn(), retry: vi.fn(), linkCode: vi.fn(), changed: vi.fn() }),
}));

import { WebsiteLinkCard, refusedLinkAttempt } from "./WebsiteLinkCard";

const render = (phase: BrowserLinkPhase) => {
  fakes.phase = phase; fakes.effects.length = 0;
  renderToStaticMarkup(createElement(WebsiteLinkCard));
  for (const effect of fakes.effects) effect();
};

beforeEach(() => { fakes.note.mockReset(); });

describe("website account card reports link attempts to setup", () => {
  it.each(["expired", "declined"] as const)("records a browser approval that %s", kind => {
    render({ kind });
    expect(fakes.note).toHaveBeenCalledWith({ outcome: kind });
  });

  it("clears the last attempt when a new request starts, and leaves it alone otherwise", () => {
    render({ kind: "starting" });
    expect(fakes.note).toHaveBeenCalledWith(null);
    fakes.note.mockReset();
    render({ kind: "idle" });
    expect(fakes.note).not.toHaveBeenCalled();
  });

  it("keeps the website's own words for a refused code, and nothing else", () => {
    const limit = Object.assign(new Error("Fictional Office already has 3 computers. Your code is kept."), { status: 409, code: "installation_limit" });
    const refused = Object.assign(new Error("This code is expired or already used."), { status: 409, code: "link_code_refused" });
    expect(refusedLinkAttempt(limit)).toEqual({ outcome: "installation_limit", message: limit.message });
    expect(refusedLinkAttempt(refused)).toEqual({ outcome: "link_code_refused", message: refused.message });
    expect(refusedLinkAttempt(Object.assign(new Error("The website could not be reached."), { code: "website_unreachable" }))).toBeNull();
    expect(refusedLinkAttempt({ code: "installation_limit" })).toBeNull();
    expect(refusedLinkAttempt(null)).toBeNull();
  });
});
