import { describe, expect, it, vi } from "vitest";
import { allowWorkspaceNavigation, changesWorkspacePage, registerNavigationGuard } from "./navigation-guard";

describe("unsaved workspace navigation", () => {
  it("checks each navigation attempt once and permits an explicitly accepted leave", () => {
    const decide = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const remove = registerNavigationGuard(decide);
    try {
      expect(allowWorkspaceNavigation("showYou", "schedule")).toBe(false);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(allowWorkspaceNavigation("showYou", "schedule")).toBe(true);
      expect(decide).toHaveBeenCalledTimes(2);
    } finally { remove(); }
  });
  it("does not ask for same-page actions or asynchronous record updates", () => {
    const decide = vi.fn(() => false), remove = registerNavigationGuard(decide);
    try {
      for (const action of ["showRoutines", "jobRun", "hermesStatus", "deskSnapshot", "hydrate", "jobDraft"]) {
        expect(allowWorkspaceNavigation(action, "schedule")).toBe(true);
      }
      expect(decide).not.toHaveBeenCalled();
    } finally { remove(); }
  });
  it("removes an unmounted editor's guard without affecting another editor", () => {
    const first = vi.fn(() => false), second = vi.fn(() => true);
    const removeFirst = registerNavigationGuard(first), removeSecond = registerNavigationGuard(second);
    removeFirst(); removeFirst();
    try {
      expect(allowWorkspaceNavigation("showDesk", "schedule")).toBe(true);
      expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
    } finally { removeSecond(); }
    expect(allowWorkspaceNavigation("showDesk", "schedule")).toBe(true);
  });
  it.each(["showDesk", "showAsk", "stageAskContext", "showYou", "showWorkspaceTab", "select", "newBot", "duplicateBot", "createGroup"])("covers the %s page-changing action", action => {
    expect(changesWorkspacePage(action, "schedule")).toBe(true);
  });
});
