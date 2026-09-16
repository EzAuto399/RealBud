import { mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const dataDir = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || "/tmp"}/realbud-pack-basics-${process.pid}-${Date.now()}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});
const { listRecipes } = await import("./recipes.ts");
const { installAustinPhase1Packs, installWorkflowPack, exportWorkflowPacks, importWorkflowPacks,
  listWorkflowPackDefinitions, listWorkflowPackStatus } = await import("./workflow-packs.ts");
beforeEach(() => { rmSync(dataDir, { recursive: true, force: true }); mkdirSync(dataDir, { recursive: true }); });
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("workflow packs", () => {
  it("lists independent definitions without inventing an office cadence", () => {
    const packs = listWorkflowPackDefinitions();
    expect(packs.map(p => p.id)).toEqual(["austin-expected-bills", "austin-payment-prep"]);
    expect(packs.every(p => p.requiresHermesPropertyPack && p.phase === "phase-1")).toBe(true);
    expect(packs.flatMap(p => p.recipes).every(r => r.schedule === null)).toBe(true);
    packs[0].recipes[0].capabilities.push("portal-submit");
    expect(listWorkflowPackDefinitions()[0].recipes[0].capabilities).not.toContain("portal-submit");
  });
  it("installs one pack and fills missing jobs without duplicates", () => {
    expect(listWorkflowPackStatus().every(p => !p.installed)).toBe(true);
    const first = installWorkflowPack("austin-expected-bills");
    expect(first.pack.installed).toBe(true);
    expect(first.recipes[0].status).toBe("shadow");
    expect(installWorkflowPack("austin-expected-bills")).toEqual(first);
    expect(listRecipes()).toHaveLength(1);
    expect(installAustinPhase1Packs().every(p => p.installed)).toBe(true);
    expect(listRecipes()).toHaveLength(2);
  });
  it("rejects an unknown pack without mutation", () => {
    expect(() => installWorkflowPack("nope")).toThrow(/No such workflow pack/);
    expect(listRecipes()).toEqual([]);
  });
  it("round trips an empty office without installing unrelated jobs", () => {
    const snapshot = exportWorkflowPacks();
    expect(importWorkflowPacks(snapshot).recipes).toEqual([]);
    expect(listWorkflowPackStatus().every(p => !p.installed)).toBe(true);
  });
  it.each([null, [], { version: 99 }, { version: 1 }, { version: 1, recipes: {} }])(
    "rejects malformed snapshots (%j)", payload => {
      expect(() => importWorkflowPacks(payload)).toThrow();
      expect(listRecipes()).toEqual([]);
    },
  );
});
