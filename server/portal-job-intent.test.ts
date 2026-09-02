import { describe, expect, it, vi } from "vitest";

import type { Recipe } from "../shared/contracts.ts";

import { parsePortalJobIntent, portalJobIntentReply } from "./portal-job-intent.ts";

function recipe(partial: Partial<Recipe> = {}): Recipe {
  return {
    id: "rec-1",
    title: "Vantage levy",
    description: "download the levy report",
    steps: ["Open the portal", "Find the levy report", "Download the PDF"],
    allowedOrigins: ["portal.vantagestrata.com.au"],
    evidence: "Levy PDF is in Downloads",
    capabilities: ["read-book", "analyse", "draft"],
    limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
    status: "shadow",
    createdAt: 1,
    schedule: null,
    planApprovedAt: null,
    revision: 1,
    updatedAt: 1,
    approvedRevision: null,
    attachment: null,
    ...partial,
  } as Recipe;
}

describe("parsePortalJobIntent", () => {
  it("takes over the Vantage routine sentence without a hostname", () => {
    const intent = parsePortalJobIntent(
      "ok so login to it and sort things out for me completing the routine",
    );
    expect(intent).not.toBeNull();
    expect(intent?.site).toBeNull();
    expect(intent?.task).toBeTruthy();
    expect(intent?.origins).toEqual([]);
  });

  it("normalises a named portal host into origins", () => {
    const intent = parsePortalJobIntent(
      "log in to portal.vantagestrata.com.au and download the levy report",
    );
    expect(intent?.origins).toEqual(["portal.vantagestrata.com.au"]);
    expect(intent?.site).toBe("portal.vantagestrata.com.au");
  });

  it("treats a named bank site as portal work", () => {
    expect(parsePortalJobIntent("check the CBA business banking site every Monday")).not.toBeNull();
  });

  it("returns null for questions, greetings, book intents, and connect-app requests", () => {
    expect(parsePortalJobIntent("what is a strata portal?")).toBeNull();
    expect(parsePortalJobIntent("can you log in?")).toBeNull();
    expect(parsePortalJobIntent("hi")).toBeNull();
    expect(parsePortalJobIntent("What did Recheck find?")).toBeNull();
    expect(parsePortalJobIntent("connect Notion")).toBeNull();
  });

  it("leaves book talk alone when only a weak target is present", () => {
    // These read as Desk work, not a website: a saved job would be noise.
    expect(parsePortalJobIntent("check the account for 12 Oak St")).toBeNull();
    expect(parsePortalJobIntent("do the weekly owner letter now")).toBeNull();
    expect(parsePortalJobIntent("open the site notes for Harbour")).toBeNull();
    // A login verb makes the weak target unambiguous.
    expect(parsePortalJobIntent("sign in and do the weekly levy check")).not.toBeNull();
  });
});

describe("portalJobIntentReply", () => {
  it("returns null when the sentence is not portal work", async () => {
    expect(await portalJobIntentReply("hi", { recipes: () => [], draft: async () => recipe(), save: (row) => row })).toBeNull();
  });

  it("points at an existing saved job without drafting", async () => {
    const existing = recipe({ id: "rec-vantage", title: "Vantage levy" });
    const draft = vi.fn(async () => recipe());
    const save = vi.fn((row: Recipe) => row);
    const result = await portalJobIntentReply(
      "log in to portal.vantagestrata.com.au and download the levy report",
      { recipes: () => [existing], draft, save },
    );
    expect(draft).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(result?.recipeId).toBe("rec-vantage");
    expect(result?.reply).toBe(
      "**Vantage levy** is already a saved job for portal.vantagestrata.com.au. Open You → Bud's jobs and press **Run beside me** — you sign in when the page asks, I do the steps, and Submit or Pay stays with you.",
    );
  });

  it("points at Schedule when the saved job has a clock", async () => {
    const existing = recipe({ id: "rec-weekly", title: "Weekly levy", schedule: { time: "09:00", weekdays: [1] } });
    const result = await portalJobIntentReply("log in to portal.vantagestrata.com.au and download the levy report", {
      recipes: () => [existing],
      draft: async () => recipe(),
      save: (row) => row,
    });
    expect(result?.reply).toContain("Open Schedule and press **Run beside me**");
  });

  it("saves a drafted job card and states the human boundary", async () => {
    const drafted = recipe({
      id: "draft-1",
      steps: ["Open Vantage", "Read the levy page", "Export the PDF"],
      allowedOrigins: [],
      evidence: "Levy PDF downloaded",
    });
    const saved = { ...drafted, id: "saved-9" };
    const result = await portalJobIntentReply("login to the portal and complete the routine", {
      recipes: () => [],
      draft: async () => drafted,
      save: () => saved,
    });
    expect(result?.recipeId).toBe("saved-9");
    expect(result?.reply).toContain("I can take this over as a saved job. Here's the plan:");
    expect(result?.reply).toContain("1. Open Vantage");
    expect(result?.reply).toContain("2. Read the levy page");
    expect(result?.reply).toContain("3. Export the PDF");
    expect(result?.reply).toContain("Site: add the portal address on You → Bud's jobs");
    expect(result?.reply).toContain("Done when: Levy PDF downloaded");
    expect(result?.reply).toContain(
      "You sign in yourself, I read and prefill, and Submit, Pay and Send stay with you. Approve the plan on You → Bud's jobs, then press **Run beside me**.",
    );
  });

  it("falls back when the model cannot shape a card", async () => {
    const result = await portalJobIntentReply("login to the portal and complete the routine", {
      recipes: () => [],
      draft: async () => {
        throw new Error("worker down");
      },
      save: (row) => row,
    });
    expect(result?.recipeId).toBeUndefined();
    expect(result?.reply).toBe(
      "I can take this over as a saved job, but Bud's model isn't answering right now. Finish Bud on You, then say this again or describe it on Schedule → Give Bud any recurring job.",
    );
  });

  it("never echoes a password or long token from the PM's text", async () => {
    const secret = "password: hunter2secret";
    const token = "Abcd1234Efgh5678";
    const result = await portalJobIntentReply(
      `login to the portal ${secret} token ${token} and complete the routine`,
      {
        recipes: () => [],
        draft: async () =>
          recipe({
            steps: ["Open the portal", `Paste ${token}`],
            evidence: secret,
          }),
        save: (row) => row,
      },
    );
    expect(result?.reply).not.toMatch(/hunter2secret/);
    expect(result?.reply).not.toMatch(/Abcd1234Efgh5678/);
  });
});
