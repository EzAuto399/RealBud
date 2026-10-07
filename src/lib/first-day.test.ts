import { describe, expect, it } from "vitest";
import type { AustinPackView } from "../../shared/austin-pack";
import { FIRST_DAY_ITEMS, firstDayContext, firstDayItems } from "./first-day";

const view = (installed: AustinPackView["installed"]): AustinPackView => ({
  pack: { id: "fictional", revision: 1, title: "Fictional" }, timeZone: "Australia/Brisbane", timeZoneFromOffice: true, installed, loops: [], rules: [], checklist: [] });

describe("first-day workflows", () => {
  it("follows the role packs on this computer: Kevin's three, Sherry's two, the whole office's five, none without a pack", () => {
    const names = (pack: Parameters<typeof firstDayItems>[0]) => firstDayItems(pack).map(item => item.name);
    expect(names(view({ revision: 1, at: 1, loopIds: ["bank-references", "inbound-triage", "weekly-bills"] }))).toEqual(["Bank reference review", "Weekly bills review", "Morning priorities"]);
    expect(names(view({ revision: 1, at: 1, loopIds: ["maintenance-review", "rei-supplier-check", "inspection-draft"] }))).toEqual(["Maintenance checks", "Inspection draft"]);
    expect(names(view({ revision: 1, at: 1 }))).toHaveLength(5);
    expect(names(view(null))).toEqual([]);
    expect(names("unavailable")).toEqual([]);
    expect(names(undefined)).toEqual([]);
  });

  it("puts an editable request in Work that keeps every send, payment, upload and booking with the person", () => {
    for (const item of FIRST_DAY_ITEMS) {
      for (const line of [item.does, item.reads, item.asks]) expect(line.length).toBeLessThanOrEqual(90);
      expect(item.prompt).toMatch(/Don't /);
      const context = firstDayContext(item, "fictional-id");
      expect(context).toMatchObject({ id: "fictional-id", sourceKey: `first-day-${item.loopId}`, title: item.name, instruction: item.prompt });
      expect(context.text).toContain(`Needs your approval: ${item.asks}`);
      expect(`${item.prompt} ${context.text}`).not.toMatch(/Hermes|MCP|broker|cookie|token|password/i);
    }
  });
});
