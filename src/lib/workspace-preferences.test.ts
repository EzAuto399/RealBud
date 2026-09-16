import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE, portfolioLayout, readWorkspacePreferences } from "./workspace-preferences";

describe("portfolio layout preferences", () => {
  it.each([20, 50, 100, 150, 200, 500])("adapts the default layout for %i properties", count => {
    expect(portfolioLayout(DEFAULT_WORKSPACE, count)).toEqual({ compact: count >= 50, table: count >= 50 });
  });
  it("honours explicit choices at any portfolio size", () => {
    expect(portfolioLayout({ ...DEFAULT_WORKSPACE, density: "comfortable", propertyView: "cards" }, 500)).toEqual({ compact: false, table: false });
    expect(portfolioLayout({ ...DEFAULT_WORKSPACE, density: "compact", propertyView: "table" }, 20)).toEqual({ compact: true, table: true });
  });
  it("validates persisted preferences, clamps widths, and excludes unrelated data", () => {
    expect(readWorkspacePreferences(null)).toEqual(DEFAULT_WORKSPACE);
    expect(readWorkspacePreferences({ pageSize: 10000, density: "bad", queueWidth: -1, showBud: "false", propertySort: "bad", propertyGrouping: "invalid", tenant: "private" })).toEqual({ ...DEFAULT_WORKSPACE, queueWidth: 240 });
    expect(readWorkspacePreferences({ queueWidth: Infinity }).queueWidth).toBe(280);
    expect(readWorkspacePreferences({ queueWidth: 900 }).queueWidth).toBe(360);
    expect(readWorkspacePreferences({ pageSize: 100, showBud: false, propertyView: "table", propertyGrouping: "building" })).toMatchObject({ pageSize: 100, showBud: false, propertyView: "table", propertyGrouping: "building" });
  });
});
