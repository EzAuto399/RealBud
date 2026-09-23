import { describe, expect, it, vi } from "vitest";
import { revealSettingsTarget, scrollYouTarget, youHashTarget, youRecoveryTarget } from "./you-navigation";

describe("settings navigation", () => {
  it.each(['you-website', 'you-private-backup'])("reveals and focuses %s without another scroll", id => {
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
  it("keeps a revealed target below the sticky jump navigation", () => {
    const target = { tagName: "DETAILS", open: false, parentElement: null, getBoundingClientRect: () => ({ top: 310 }) };
    const scroller = { scrollTop: 20, getBoundingClientRect: () => ({ top: 10 }),
      querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 70 }) }), scrollTo: vi.fn() };
    vi.stubGlobal("document", { getElementById: () => target, querySelector: () => scroller });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    try {
      scrollYouTarget("you-service-admin");
      expect(target.open).toBe(true);
      expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 252, behavior: "auto" });
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([
    ["#attach-model", "you-worker"], ["#you-worker", "you-worker"],
    ["#connected-apps", "you-connected-apps"], ["#you-connected-apps", "you-connected-apps"],
    ["#you-recovery", "you-recovery"], ["#you-private-backup", "you-private-backup"], ["#you-packs", "you-packs"], ["#you-jobs", "you-jobs"],
    ["#you-phone", "you-phone"], ["#you-office", "you-office"], ["#you-profile", "you-profile"],
    ["#you-website", "you-website"],
    ["#you-advanced", "you-advanced"],
    ["#you-service-admin", "you-service-admin"],
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
