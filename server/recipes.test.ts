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
      description: "",
      steps: ["Open the arrears report", "Put 7+ day late tenancies on Desk"],
      allowedOrigins: ["propertyme.com.au"],
      evidence: "arrears rows and the URL",
      capabilities: ["read-book", "analyse", "draft"],
      limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
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

  it("accepts only bounded prepare capabilities and limits", () => {
    expect(
      validateRecipe({
        ...card,
        description: "  Prepare the weekly exception list.  ",
        capabilities: ["read-book", "read-files", "analyse"],
        limits: { maxRuntimeMinutes: 3, maxTurns: 8 },
      }),
    ).toMatchObject({
      description: "Prepare the weekly exception list.",
      capabilities: ["read-book", "read-files", "analyse"],
      limits: { maxRuntimeMinutes: 3, maxTurns: 8 },
    });
    expect(() => validateRecipe({ ...card, capabilities: ["send"] })).toThrow(/cannot be granted/i);
    expect(() => validateRecipe({ ...card, limits: { maxRuntimeMinutes: 10, maxTurns: 6 } })).toThrow(/1 and 5/i);
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
      revision: 1,
      updatedAt: 12,
      approvedRevision: null,
      attachment: null,
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
        description: "",
        capabilities: ["read-book", "analyse", "draft"],
        limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
        schedule: null,
        planApprovedAt: null,
        siteNotes: null,
        revision: 1,
        updatedAt: 9,
        approvedRevision: null,
        attachment: null,
        submitAcknowledgedAt: null,
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
    expect(approved[0]?.approvedRevision).toBe(1);
    expect(recipeClockRunnable(approved[0]!)).toBe(true);

    const stamp = approved[0]!.planApprovedAt;
    expect(patchRecipe("rec-1", { planApproved: true })[0]?.planApprovedAt).toBe(stamp);
    expect(patchRecipeStatus("rec-1", "paused")[0]).toMatchObject({ status: "paused", planApprovedAt: stamp });
    expect(recipeClockRunnable(getRecipe("rec-1")!)).toBe(false);
  });

  it("preserves approval on an idempotent save but invalidates it on a material edit", () => {
    saveRecipe({ ...card, id: "rec-1", createdAt: 12 });
    patchRecipe("rec-1", { planApproved: true });
    const approved = getRecipe("rec-1")!;
    const same = saveRecipe({ ...approved });
    expect(same[0]).toMatchObject({
      revision: 1,
      approvedRevision: 1,
      planApprovedAt: approved.planApprovedAt,
    });

    saveRecipe({ ...card, id: "rec-1", createdAt: 12, title: "Friday arrears retitled" });
    expect(getRecipe("rec-1")).toMatchObject({
      title: "Friday arrears retitled",
      revision: 2,
      planApprovedAt: null,
      approvedRevision: null,
    });
    expect(recipeClockRunnable(getRecipe("rec-1")!)).toBe(false);
    patchRecipe("rec-1", { planApproved: true });
    expect(getRecipe("rec-1")).toMatchObject({ approvedRevision: 2, status: "active" });
    expect(recipeClockRunnable(getRecipe("rec-1")!)).toBe(true);
  });

  it("migrates a legacy approval onto revision one only", () => {
    writeFileSync(
      join(dataDir, "recipes.json"),
      JSON.stringify({
        recipes: [
          {
            ...card,
            id: "legacy",
            status: "active",
            createdAt: 9,
            planApprovedAt: 10,
          },
        ],
      }),
    );
    expect(getRecipe("legacy")).toMatchObject({
      revision: 1,
      updatedAt: 9,
      approvedRevision: 1,
    });
    expect(recipeClockRunnable(getRecipe("legacy")!)).toBe(true);
  });

  it("requires a portal site for portal capabilities and implies read from prefill", () => {
    expect(() => validateRecipe({ ...card, allowedOrigins: [], capabilities: ["portal-read"] })).toThrow(
      /portal site/i,
    );
    expect(() => validateRecipe({ ...card, capabilities: ["send"] })).toThrow(/cannot be granted/i);
    expect(
      validateRecipe({
        ...card,
        capabilities: ["portal-prefill"],
      }).capabilities,
    ).toEqual(["portal-read", "portal-prefill"]);
  });

  it("requires prefill and a site for portal-submit, and clears acknowledgement on edit", () => {
    expect(() =>
      validateRecipe({ ...card, capabilities: ["portal-submit"], allowedOrigins: ["propertyme.com.au"] }),
    ).toThrow(/prefill/i);
    expect(
      validateRecipe({
        ...card,
        capabilities: ["portal-prefill", "portal-submit"],
      }).capabilities,
    ).toEqual(["portal-read", "portal-prefill", "portal-submit"]);

    saveRecipe({
      ...card,
      id: "rec-submit",
      capabilities: ["portal-read", "portal-prefill", "portal-submit"],
      createdAt: 12,
    });
    expect(() => patchRecipe("rec-submit", { submitAcknowledged: true })).not.toThrow();
    expect(typeof getRecipe("rec-submit")?.submitAcknowledgedAt).toBe("number");
    // Turning Submit asks off only narrows Bud; it never needs a capability check.
    expect(() => patchRecipe("rec-submit", { submitAcknowledged: false })).not.toThrow();
    expect(getRecipe("rec-submit")?.submitAcknowledgedAt).toBeNull();

    saveRecipe({
      ...card,
      id: "rec-bare-submit",
      capabilities: ["portal-read"],
      createdAt: 12,
    });
    try {
      patchRecipe("rec-bare-submit", { submitAcknowledged: true });
      expect.unreachable();
    } catch (err) {
      expect(statusOf(err)).toBe(409);
      expect(String(err)).toMatch(/portal-submit capability/);
    }

    const acked = patchRecipe("rec-submit", { submitAcknowledged: true })[0];
    expect(acked?.submitAcknowledgedAt).toBeTruthy();
    saveRecipe({
      ...card,
      id: "rec-submit",
      capabilities: ["portal-read", "portal-prefill"],
      createdAt: 12,
    });
    expect(getRecipe("rec-submit")?.submitAcknowledgedAt).toBeNull();
  });

  it("attaches only after a portal site and capability, and clears attach when origins change", () => {
    saveRecipe({
      ...card,
      id: "rec-portal",
      capabilities: ["portal-read"],
      createdAt: 12,
    });
    expect(() => patchRecipe("rec-portal", { attach: true })).not.toThrow();
    const attached = getRecipe("rec-portal");
    expect(attached?.attachment).toMatchObject({ acknowledged: "human-login-and-submit" });
    expect(typeof attached?.attachment?.attachedAt).toBe("number");

    expect(patchRecipe("rec-portal", { attach: false })[0]?.attachment).toBeNull();
    patchRecipe("rec-portal", { attach: true });

    saveRecipe({
      ...card,
      id: "rec-portal",
      capabilities: ["portal-read"],
      allowedOrigins: ["vantagestrata.com.au"],
      createdAt: 12,
    });
    expect(getRecipe("rec-portal")?.attachment).toBeNull();

    saveRecipe({
      ...card,
      id: "rec-bare",
      allowedOrigins: [],
      createdAt: 12,
    });
    try {
      patchRecipe("rec-bare", { attach: true });
      expect.unreachable();
    } catch (err) {
      expect(statusOf(err)).toBe(409);
      expect(String(err)).toMatch(/Add the portal site and a portal capability before attaching it/);
    }
  });
});
