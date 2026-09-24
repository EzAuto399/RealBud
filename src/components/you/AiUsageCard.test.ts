import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AiUsageCardView, usagePeriodLabel } from "./AiUsageCard";
import type { InstallationUsageState } from "@shared/office-link";

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

describe("AI usage card", () => {
  it("shows the account's own figures with exact amounts and an accessible name", () => {
    const html = render(ready());
    expect(html).toContain("AI usage this month");
    expect(html).toContain("aria-label=\"AI usage for September 2026\"");
    expect(html).toContain("1,234");
    // Exact nano-AUD: a float would lose these digits.
    expect(html).toContain("12,345,678,901,234,567,890");
    expect(html).toContain("A$41.23");
    expect(html).toContain("A$38.77");
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
    // The portal does not return monthlyCapNanoAud/remainingNanoAud today.
    const html = render(ready({ monthlyCapNanoAud: null, remainingNanoAud: null, money: { customerNetNanoAud: null } }));
    expect(html).toContain("Not reported by your account");
    expect(html).toContain("Not priced");
    expect(html).not.toContain("No monthly limit");
    expect(html).not.toContain("Monthly limit");
  });

  it("falls back to a neutral month label rather than inventing one", () => {
    expect(usagePeriodLabel("2026-01")).toBe("January 2026");
    expect(usagePeriodLabel("2026-13")).toBe("This month");
    expect(usagePeriodLabel("")).toBe("This month");
  });
});
