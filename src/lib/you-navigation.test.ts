import { describe, expect, it } from "vitest";
import { revealSettingsTarget, youHashTarget } from "./you-navigation";

describe("settings navigation", () => {
  it.each([
    ["#attach-model", "you-worker"], ["#you-worker", "you-worker"],
    ["#connected-apps", "you-connected-apps"], ["#you-connected-apps", "you-connected-apps"],
    ["#you-recovery", "you-recovery"], ["#you-jobs", "you-jobs"],
    ["#you-phone", "you-phone"], ["#you-office", "you-office"], ["#you-profile", "you-profile"],
    ["#you-advanced", "you-advanced"],
  ])("resolves %s to its settings section", (hash, id) => {
    expect(youHashTarget(hash)).toBe(id);
  });
  it.each(["", "#unknown", "#you-recovery-extra"])("ignores unrelated locations: %s", (hash) => {
    expect(youHashTarget(hash)).toBeNull();
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
