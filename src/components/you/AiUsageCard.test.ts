import { createElement, type SetStateAction } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiUsageCard, AiUsageCardView, usagePeriodLabel } from "./AiUsageCard";
import { currentUsagePeriod, type InstallationUsageState } from "@shared/office-link";
import { api } from "@/state/store";

const observed = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, values: [] as unknown[], setters: [] as ReturnType<typeof vi.fn>[], cleanups: [] as Array<() => void> }));
// Render with real React refs/callbacks and execute the card's actual effect.
// Observe state requests after deferred API replies, as in other node-only
// component tests; this does not stand in for installed renderer acceptance.
vi.mock("react", async importOriginal => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useEffect: (effect: () => void | (() => void)) => { observed.effects.push(effect); },
    useState: <T,>(initial: T | (() => T)) => {
      const [value, set] = react.useState(initial), index = observed.values.length;
      observed.values.push(value);
      const setter = vi.fn((next: SetStateAction<T>) => {
        observed.values[index] = typeof next === "function" ? (next as (value: T) => T)(observed.values[index] as T) : next;
        set(next);
      });
      observed.setters.push(setter);
      return [value, setter];
    } };
});

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

const ready = (over: Partial<Parameters<typeof usage>[0]> = {}) => usage(over);
function usage(over: Record<string, unknown> = {}): InstallationUsageState {
  return { state: "ready", usage: {
    period: "2026-09", requests: 1234, tokens: { input: "12345678901234567890", output: "987654321" },
    money: { customerNetNanoAud: "41230000000" }, monthlyCapNanoAud: "80000000000",
    remainingNanoAud: "38770000000", updatedAt: "2026-09-22T03:00:00.000Z", ...over } as never };
}

const render = (state: InstallationUsageState | null, busy = false) =>
  renderToStaticMarkup(createElement(AiUsageCardView, { usage: state, busy, onRefresh: () => {} }));

beforeEach(() => { observed.effects.length = 0; observed.values.length = 0; observed.setters.length = 0; vi.mocked(api).mockReset(); });
afterEach(() => { for (const cleanup of observed.cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

function mountUsageEffect() {
  const browser = Object.assign(new EventTarget(), { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  renderToStaticMarkup(createElement(AiUsageCard));
  for (const effect of observed.effects) { const cleanup = effect(); if (cleanup) observed.cleanups.push(cleanup); }
  return browser;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("AI usage card", () => {
  it("loads the changed office immediately and ignores the prior office's late figures", async () => {
    const oldOffice = deferred<{ usage: InstallationUsageState }>();
    const current = ready({ period: currentUsagePeriod(), money: { customerNetNanoAud: "2000000000" } });
    vi.mocked(api).mockReturnValueOnce(oldOffice.promise).mockResolvedValueOnce({ usage: current });
    const browser = mountUsageEffect();
    expect(api).toHaveBeenCalledTimes(1);
    browser.dispatchEvent(new Event("realbud-website-link-changed"));
    expect(api).toHaveBeenCalledTimes(2); // No wait for the old office or the polling timer.
    await vi.waitFor(() => expect(observed.values).toEqual([current, false]));
    expect(render(observed.values[0] as InstallationUsageState)).toContain("A$2.00");
    observed.setters.forEach(setter => setter.mockClear());
    oldOffice.resolve({ usage: ready({ period: currentUsagePeriod(), money: { customerNetNanoAud: "99000000000" } }) });
    await oldOffice.promise; await Promise.resolve();
    expect(observed.values).toEqual([current, false]);
    expect(observed.setters.every(setter => setter.mock.calls.length === 0)).toBe(true);
    expect(render(observed.values[0] as InstallationUsageState)).not.toContain("A$99.00");
  });

  it.each(["reply", "error"])("an old office's late %s cannot clear the new office's busy request or its single flight", async outcome => {
    const oldOffice = deferred<{ usage: InstallationUsageState }>(), newOffice = deferred<{ usage: InstallationUsageState }>();
    vi.mocked(api).mockReturnValueOnce(oldOffice.promise).mockReturnValueOnce(newOffice.promise);
    const browser = mountUsageEffect();
    browser.dispatchEvent(new Event("realbud-website-link-changed"));
    expect(api).toHaveBeenCalledTimes(2);
    observed.setters.forEach(setter => setter.mockClear());
    if (outcome === "reply") oldOffice.resolve({ usage: { state: "not-linked" } });
    else oldOffice.reject(new Error("Fictional old office timeout"));
    await oldOffice.promise.catch(() => {}); await Promise.resolve();
    expect(observed.values).toEqual([null, true]);
    expect(observed.setters.every(setter => setter.mock.calls.length === 0)).toBe(true);
    browser.dispatchEvent(new Event("focus"));
    expect(api).toHaveBeenCalledTimes(2);
    const current = ready({ period: currentUsagePeriod(), money: { customerNetNanoAud: "3000000000" } });
    newOffice.resolve({ usage: current });
    await vi.waitFor(() => expect(observed.values).toEqual([current, false]));
  });

  it("shows a tiny positive charge with its exact amount in details", () => {
    const html = render(ready({ money: { customerNetNanoAud: "1" } }));
    expect(html).toContain("&lt;A$0.01");
    expect(html).toContain("Exact cost so far");
    expect(html).toContain("A$0.000000001");
    expect(render(ready({ money: { customerNetNanoAud: "0" } }))).not.toContain("&lt;A$0.01");
  });
  it("shows the account's own figures with exact amounts and an accessible name", () => {
    const html = render(ready());
    expect(html).toContain("AI usage this month");
    expect(html).toContain("aria-label=\"AI usage for September 2026\"");
    expect(html).toContain("1,234");
    // Exact nano-AUD: a float would lose these digits.
    expect(html).toContain("12,345,678,901,234,567,890");
    expect(html).toContain("A$41.23");
    expect(html).toContain("A$38.77");
    expect(html).toContain("51.5%");
    expect(html).toContain('aria-label="Monthly spending budget used"');
    expect(html).toContain("Request and token details");
    expect(html).toContain("before credits");
    expect(html).toContain("Monthly limit A$80.00");
    expect(html).toContain("Check again");
    expect(html).toContain("across your linked office");
    expect(html).not.toContain("What this computer used");
    expect(html).toContain("https://realbud.app/account/ai-billing");
    expect(html).toContain("min-h-[44px]");
    for (const banned of ["Hermes", "MCP", "broker"]) expect(html).not.toContain(banned);
  });

  it("says so rather than showing a number it was not given", () => {
    expect(render(null)).toContain("Checking your account");
    expect(render({ state: "checking" })).toContain("Checking your account");
    const notLinked = render({ state: "not-linked" });
    expect(notLinked).toContain("Not linked");
    expect(notLinked).not.toContain("Check again");
    const unavailable = render({ state: "unavailable" });
    expect(unavailable).toContain("Usage unavailable");
    expect(unavailable).toContain("rather than guessed");
    for (const row of ["Requests", "Tokens in / out", "Customer usage estimate", "Reported headroom"]) expect(unavailable).not.toContain(row);
    expect(render({ state: "unavailable" }, true)).toContain("Checking…");
  });

  it("never turns a cap the account did not report into 'no limit'", () => {
    // An older or unconfigured account may omit limits.
    const html = render(ready({ monthlyCapNanoAud: null, remainingNanoAud: null, money: { customerNetNanoAud: null } }));
    expect(html).toContain("Not reported by your account");
    expect(html).toContain("Not priced");
    expect(html).not.toContain("No monthly limit");
    expect(html).not.toContain("Monthly limit");
  });

  it("keeps billing credits separate from budget consumption and does not invent a percentage", () => {
    const credited = render(ready({ money: { customerNetNanoAud: '1000000000' } }));
    expect(credited).toContain('A$1.00');
    expect(credited).toContain('51.5%');
    expect(render(ready({ monthlyCapNanoAud: '0', remainingNanoAud: '0' }))).toContain('Not enabled');
    expect(render(ready({ remainingNanoAud: null }))).not.toContain('<progress');
  });

  it("falls back to a neutral month label rather than inventing one", () => {
    expect(usagePeriodLabel("2026-01")).toBe("January 2026");
    expect(usagePeriodLabel("2026-13")).toBe("This month");
    expect(usagePeriodLabel("")).toBe("This month");
  });
});
