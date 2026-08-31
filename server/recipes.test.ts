// Recipe book: persist, validate, and skip junk on disk.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-recipes-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const {
  deleteRecipe,
  getRecipe,
  listRecipes,
  loadRecipes,
  patchRecipe,
  patchRecipeStatus,
  recipeClockRunnable,
  saveRecipe,
  validateRecipe,
} = await import("./recipes.ts");
const { join } = await import("node:path");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  rmSync(join(dataDir, "recipes.json"), { force: true });
});

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

const card = {
  title: "Friday arrears",
  steps: ["Open the arrears report", "Put 7+ day late tenancies on Desk"],
  allowedOrigins: ["https://www.PropertyMe.com.au/report"],
  evidence: "arrears rows and the URL",
};

describe("validateRecipe", () => {
  it("normalizes a portal URL to a bare host", () => {
    expect(validateRecipe(card)).toEqual({
      title: "Friday arrears",
      steps: ["Open the arrears report", "Put 7+ day late tenancies on Desk"],
      allowedOrigins: ["propertyme.com.au"],
      evidence: "arrears rows and the URL",
      schedule: null,
      siteNotes: null,
    });
  });

  it("accepts a valid cadence and drops a junk one", () => {
    expect(validateRecipe({ ...card, schedule: { time: "16:00", weekdays: [5] } }).schedule).toEqual({
      time: "16:00",
      weekdays: [5],
    });
    expect(validateRecipe({ ...card, schedule: { time: "4pm", weekdays: ["Friday"] } }).schedule).toBeNull();
    expect(validateRecipe({ ...card, schedule: null }).schedule).toBeNull();
  });

  it("rejects a bad origin", () => {
    try {
      validateRecipe({ ...card, allowedOrigins: ["not a host"] });
      expect.unreachable();
    } catch (err) {
      expect(statusOf(err)).toBe(400);
      expect(String(err)).toMatch(/hostname/i);
    }
  });

  it("rejects too many steps", () => {
    try {
      validateRecipe({ ...card, steps: Array.from({ length: 13 }, (_, i) => `Step ${i + 1}`) });
      expect.unreachable();
    } catch (err) {
      expect(statusOf(err)).toBe(400);
      expect(String(err)).toMatch(/12 steps/);
    }
  });

  it("allows a job with no portal named yet", () => {
    expect(validateRecipe({ ...card, allowedOrigins: [] }).allowedOrigins).toEqual([]);
  });
});

describe("recipe store", () => {
  it("saves, lists, patches, and deletes", () => {
    const created = saveRecipe({ ...card, id: "rec-1", status: "shadow", createdAt: 12 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: "rec-1",
      title: "Friday arrears",
      allowedOrigins: ["propertyme.com.au"],
      status: "shadow",
      createdAt: 12,
      planApprovedAt: null,
    });
    expect(listRecipes()).toEqual(created);
    expect(getRecipe("rec-1")?.id).toBe("rec-1");

    const patched = patchRecipeStatus("rec-1", "active");
    expect(patched[0]?.status).toBe("active");

    expect(deleteRecipe("rec-1")).toEqual([]);
    expect(getRecipe("rec-1")).toBeUndefined();
    expect(() => deleteRecipe("rec-1")).toThrow(/no such recipe/);
    expect(() => patchRecipeStatus("rec-1", "paused")).toThrow(/no such recipe/);
  });

  it("skips junk on disk and never throws", () => {
    writeFileSync(join(dataDir, "recipes.json"), "{not json");
    expect(loadRecipes()).toEqual([]);

    writeFileSync(
      join(dataDir, "recipes.json"),
      JSON.stringify([
        { id: 1, title: "nope" },
        null,
        {
          id: "ok",
          title: "Levy check",
          steps: ["Open levies"],
          allowedOrigins: ["propertyme.com.au"],
          evidence: "levy column",
          status: "paused",
          createdAt: 9,
        },
      ]),
    );
    expect(loadRecipes()).toEqual([
      {
        id: "ok",
        title: "Levy check",
        steps: ["Open levies"],
        allowedOrigins: ["propertyme.com.au"],
        evidence: "levy column",
        status: "paused",
        createdAt: 9,
        schedule: null,
        planApprovedAt: null,
        siteNotes: null,
      },
    ]);
  });

  it("loads a missing plan stamp as null and PATCH planApproved sets it once", () => {
    const created = saveRecipe({ ...card, id: "rec-1", status: "active", createdAt: 12 });
    expect(created[0]?.planApprovedAt).toBeNull();
    expect(recipeClockRunnable(created[0]!)).toBe(false);

    const before = Date.now();
    const approved = patchRecipe("rec-1", { planApproved: true });
    expect(approved[0]?.planApprovedAt).toBeGreaterThanOrEqual(before);
    expect(approved[0]?.status).toBe("active");
    expect(recipeClockRunnable(approved[0]!)).toBe(true);

    const stamp = approved[0]!.planApprovedAt;
    expect(patchRecipe("rec-1", { planApproved: true })[0]?.planApprovedAt).toBe(stamp);
    expect(patchRecipeStatus("rec-1", "paused")[0]).toMatchObject({ status: "paused", planApprovedAt: stamp });
    expect(recipeClockRunnable(getRecipe("rec-1")!)).toBe(false);
  });

  it("does not let a save wipe an approved plan", () => {
    saveRecipe({ ...card, id: "rec-1", createdAt: 12 });
    patchRecipe("rec-1", { planApproved: true });
    const stamp = getRecipe("rec-1")!.planApprovedAt;
    saveRecipe({ ...card, id: "rec-1", createdAt: 12, title: "Friday arrears retitled" });
    expect(getRecipe("rec-1")).toMatchObject({ title: "Friday arrears retitled", planApprovedAt: stamp });
  });
});
