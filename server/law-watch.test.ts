import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-law-watch-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const {
  applyLawDrift,
  LAW_WATCH_ID,
  LAW_WATCH_UNAVAILABLE,
  loadLawWatch,
  persistLawWatchResult,
  setLawWatchScheduled,
} = await import("./law-watch.ts");
const { LAW_REFERENCE_FILE, LAW_REFERENCE_MARKDOWN } = await import("./law-reference.ts");
const { listRecipes } = await import("./recipes.ts");
const { seedVault } = await import("./vault.ts");

const driftItem = {
  jurisdiction: "ACT",
  topic: "rent-increase",
  reference: "once per 12 months, 8 weeks' written notice",
  current: "once per 12 months, 8 weeks' written notice",
  note: "Matches the shop reference.",
};

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  rmSync(join(dataDir, "law-watch.json"), { force: true });
  rmSync(join(dataDir, "recipes.json"), { force: true });
  seedVault();
});

describe("law watch check", () => {
  it("says plainly that no search provider is configured, and has no worker to start", async () => {
    expect(LAW_WATCH_UNAVAILABLE).toBe("Search provider not configured: Bud can't re-read the legislation sites yet, so the shop reference was not checked. Nothing was changed.");
    expect(await import("./law-watch.ts")).not.toHaveProperty("runLawWatch");
  });
});

describe("applyLawDrift", () => {
  it("appends a dated section to the shop reference and drops the item", () => {
    const vault = seedVault();
    writeFileSync(join(vault, LAW_REFERENCE_FILE), LAW_REFERENCE_MARKDOWN, { mode: 0o600 });
    persistLawWatchResult({
      drift: [driftItem, { ...driftItem, topic: "bond-cap", note: "Still current." }],
      checkedSources: ["https://legislation.gov.au/act"],
    });
    const next = applyLawDrift(0);
    expect(next.drift).toEqual([{ ...driftItem, topic: "bond-cap", note: "Still current." }]);
    expect(loadLawWatch().drift).toHaveLength(1);

    const day = new Date().toISOString().slice(0, 10);
    const body = readFileSync(join(dataDir, "vault", LAW_REFERENCE_FILE), "utf8");
    expect(body).toContain(`## Confirmed drift — ${day}`);
    expect(body).toContain(
      `- ACT · rent-increase: ${driftItem.current} (reference said: ${driftItem.reference}) — ${driftItem.note}`,
    );
  });

  it("rejects a bad index", () => {
    persistLawWatchResult({ drift: [driftItem], checkedSources: [] });
    try {
      applyLawDrift(3);
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
    }
  });
});

describe("setLawWatchScheduled", () => {
  it("creates exactly one law-watch recipe and removes it", () => {
    const first = setLawWatchScheduled(true);
    expect(first.filter((row) => row.id === LAW_WATCH_ID)).toHaveLength(1);
    expect(first.find((row) => row.id === LAW_WATCH_ID)).toMatchObject({
      id: LAW_WATCH_ID,
      title: "Law watch",
      status: "shadow",
      planApprovedAt: null,
      schedule: { time: "08:00", weekdays: [1] },
      allowedOrigins: [
        "legislation.gov.au",
        "legislation.nsw.gov.au",
        "legislation.vic.gov.au",
        "legislation.qld.gov.au",
      ],
    });

    const again = setLawWatchScheduled(true);
    expect(again.filter((row) => row.id === LAW_WATCH_ID)).toHaveLength(1);
    expect(listRecipes().filter((row) => row.id === LAW_WATCH_ID)).toHaveLength(1);

    expect(setLawWatchScheduled(false).find((row) => row.id === LAW_WATCH_ID)).toBeUndefined();
    expect(setLawWatchScheduled(false).find((row) => row.id === LAW_WATCH_ID)).toBeUndefined();
  });
});
