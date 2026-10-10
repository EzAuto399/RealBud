import { describe, expect, it, vi } from "vitest";
import { revealSettingsTarget, scrollYouTarget, youHashTarget, youRecoveryTarget } from "./you-navigation";

describe("settings navigation", () => {
  it.each(['you-website', 'you-website-code', 'you-private-backup'])("reveals and focuses %s without another scroll", id => {
    const outer = { tagName: "DETAILS", open: false, parentElement: null };
    const target = { tagName: "SECTION", parentElement: outer, focus: vi.fn(), getBoundingClientRect: () => ({ top: 200 }) };
    const scroller = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }), querySelector: () => null, scrollTo: vi.fn() };
    vi.stubGlobal("document", { getElementById: () => target, querySelector: () => scroller });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    try {
      scrollYouTarget(id);
      expect(outer.open).toBe(true);
      expect(target.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 192, behavior: "auto" });
    } finally { vi.unstubAllGlobals(); }
  });
  it("opens the folded link-code field for Enter link code, and lands on the card when the field is not shown", () => {
    const card = { tagName: "SECTION", parentElement: null, focus: vi.fn(), getBoundingClientRect: () => ({ top: 40 }) };
    const disclosure = { tagName: "DETAILS", open: false, parentElement: card };
    const field = { tagName: "INPUT", parentElement: disclosure, focus: vi.fn(), getBoundingClientRect: () => ({ top: 90 }) };
    const scroller = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }), scrollTo: vi.fn() };
    let shown = true;
    vi.stubGlobal("document", { getElementById: (id: string) => id === "you-website-code" ? (shown ? field : null) : id === "you-website" ? card : null, querySelector: () => scroller });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    try {
      scrollYouTarget("you-website-code");
      expect(disclosure.open).toBe(true);
      expect(field.focus).toHaveBeenCalledWith({ preventScroll: true });
      shown = false;
      scrollYouTarget("you-website-code");
      expect(card.focus).toHaveBeenCalledWith({ preventScroll: true });
    } finally { vi.unstubAllGlobals(); }
  });
  it("opens a section folded inside Settings & help and scrolls it just below the top", () => {
    const settings = { tagName: "DETAILS", open: false, parentElement: null };
    const summary = { focus: vi.fn() };
    const target = { tagName: "DETAILS", open: false, parentElement: settings, getBoundingClientRect: () => ({ top: 310 }), querySelector: (selector: string) => selector === 'summary' ? summary : null };
    const scroller = { scrollTop: 20, getBoundingClientRect: () => ({ top: 10 }), scrollTo: vi.fn() };
    vi.stubGlobal("document", { getElementById: () => target, querySelector: () => scroller });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    try {
      scrollYouTarget("you-service-admin");
      expect(target.open).toBe(true);
      expect(settings.open).toBe(true);
      expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 312, behavior: "smooth" });
      expect(summary.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([
    ["#attach-model", "you-worker"], ["#you-worker", "you-worker"],
    ["#connected-apps", "you-connected-apps"], ["#you-connected-apps", "you-connected-apps"],
    ["#you-recovery", "you-recovery"], ["#you-private-backup", "you-private-backup"], ["#you-packs", "you-packs"], ["#you-jobs", "you-jobs"],
    ["#you-phone", "you-phone"], ["#you-office", "you-office"], ["#you-company", "you-company"], ["#you-profile", "you-profile"],
    ["#you-website", "you-website"], ["#you-website-code", "you-website-code"],
    ["#you-advanced", "you-advanced"],
    ["#you-service-admin", "you-service-admin"],
    ["#you-memory", "you-memory"], ["#you-settings", "you-settings"],
    ["#you-browser", "you-browser"],
    ["#you-approvals", "you-approvals"], ["#you-rules", "you-approvals"],
  ])("resolves %s to its settings section", (hash, id) => {
    expect(youHashTarget(hash)).toBe(id);
  });
  it.each(["", "#unknown", "#you-recovery-extra"])("ignores unrelated locations: %s", (hash) => {
    expect(youHashTarget(hash)).toBeNull();
  });
  it('preserves the explicit private-backup destination when saved recovery refreshes', () => {
    expect(youRecoveryTarget('#you-private-backup')).toBe('you-private-backup');
  });
  it.each(['', '#you-recovery', '#you-private-backup-extra', '#you-profile', '#you-website', '#/desk', '#/you'])('keeps key recovery as the default for %s', hash => {
    expect(youRecoveryTarget(hash)).toBe('you-recovery');
  });
  it("opens every enclosing disclosure, including the target, without changing siblings", () => {
    const outer = { tagName: "DETAILS", open: false, parentElement: null };
    const sibling = { tagName: "DETAILS", open: false, parentElement: outer };
    const wrapper = { tagName: "DIV", parentElement: outer };
    const target = { tagName: "DETAILS", open: false, parentElement: wrapper };
    revealSettingsTarget(target as unknown as HTMLElement);
    expect(target.open).toBe(true);
    expect(outer.open).toBe(true);
    expect(sibling.open).toBe(false);
    revealSettingsTarget(target as unknown as HTMLElement);
    expect(target.open).toBe(true);
  });
});
