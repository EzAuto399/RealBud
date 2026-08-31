// Distill a job from the last run: stub worker, keep origins and evidence.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeHermes } from "./testing/fake-hermes.ts";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-distill-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const { distillRecipe } = await import("./recipe-distill.ts");
const { saveRecipe, getRecipe } = await import("./recipes.ts");
const { createSession, appendEvidence, transitionSession } = await import("./portal-sessions.ts");
const { appendHistory } = await import("./computer-history.ts");

const dirs: string[] = [];

function trackFake(answer: string, exitCode = 0) {
  const fake = fakeHermes(answer, exitCode);
  dirs.push(fake.dir);
  return fake;
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  rmSync(join(dataDir, "recipes.json"), { force: true });
  rmSync(join(dataDir, "portal-sessions.json"), { force: true });
  rmSync(join(dataDir, "computer-history.json"), { force: true });
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const card = {
  id: "rec-distill-1",
  title: "Friday arrears",
  steps: ["Open the portal", "Find late rent", "Park them on Desk"],
  allowedOrigins: ["https://www.PropertyMe.com.au/report"],
  evidence: "arrears rows and the URL",
  status: "shadow" as const,
  createdAt: 12,
};

describe("distillRecipe", () => {
  it("rewrites steps from the last run and leaves origins and evidence alone", async () => {
    saveRecipe(card);
    let session = createSession({
      recipeId: card.id,
      allowedOrigins: ["propertyme.com.au"],
      shadow: true,
      state: "running",
    });
    session = appendEvidence(session, "Would open Arrears on propertyme.com.au");
    transitionSession(session, "done", "Shadow run — nothing was browsed or clicked.");
    appendHistory({ kind: "tool", name: "Read", ok: true, detail: "" });

    const { dir, script } = trackFake(
      `Here you go.\n{"steps":["Open Arrears on propertyme.com.au","Park 7+ day late rows on Desk"],"allowedOrigins":["evil.example"],"evidence":"drop this"}`,
    );
    const result = await distillRecipe(card.id, { cli: script, root: dir });
    expect(result.previousSteps).toEqual(card.steps);
    expect(result.recipe).toMatchObject({
      id: card.id,
      title: "Friday arrears",
      steps: ["Open Arrears on propertyme.com.au", "Park 7+ day late rows on Desk"],
      allowedOrigins: ["propertyme.com.au"],
      evidence: "arrears rows and the URL",
      status: "shadow",
      createdAt: 12,
    });
    expect(getRecipe(card.id)?.steps).toEqual(result.recipe.steps);
  });

  it("returns 503 and leaves the recipe unchanged when the worker answers junk", async () => {
    saveRecipe(card);
    const { dir, script } = trackFake("Sure, just click around until it looks right.");
    try {
      await distillRecipe(card.id, { cli: script, root: dir });
      expect.unreachable();
    } catch (error) {
      expect(statusOf(error)).toBe(503);
      expect(String(error)).toMatch(/could not tighten those steps/i);
    }
    expect(getRecipe(card.id)?.steps).toEqual(card.steps);
    expect(getRecipe(card.id)?.allowedOrigins).toEqual(["propertyme.com.au"]);
    expect(getRecipe(card.id)?.evidence).toBe("arrears rows and the URL");
  });

  it("returns 503 when rewritten steps are not usable", async () => {
    saveRecipe(card);
    const { dir, script } = trackFake(`{"steps":[]}`);
    try {
      await distillRecipe(card.id, { cli: script, root: dir });
      expect.unreachable();
    } catch (error) {
      expect(statusOf(error)).toBe(503);
      expect(String(error)).toMatch(/not usable/i);
    }
    expect(getRecipe(card.id)?.steps).toEqual(card.steps);
  });
});
