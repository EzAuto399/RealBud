import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeHermes } from "./testing/fake-hermes.ts";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-law-watch-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const {
  applyLawDrift,
  LAW_WATCH_ID,
  loadLawWatch,
  persistLawWatchResult,
  runLawWatch,
  setLawWatchScheduled,
} = await import("./law-watch.ts");
const { LAW_REFERENCE_FILE, LAW_REFERENCE_MARKDOWN } = await import("./law-reference.ts");
const { listRecipes } = await import("./recipes.ts");
const { seedVault } = await import("./vault.ts");

const dirs: string[] = [];

const driftItem = {
  jurisdiction: "ACT",
  topic: "rent-increase",
  reference: "once per 12 months, 8 weeks' written notice",
  current: "once per 12 months, 8 weeks' written notice",
  note: "Matches the shop reference.",
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  rmSync(join(dataDir, "law-watch.json"), { force: true });
  rmSync(join(dataDir, "recipes.json"), { force: true });
  seedVault();
});

describe("runLawWatch", () => {
  it("parses a drift report and persists it", async () => {
    const { dir, script } = fakeHermes(
      `{"drift":[${JSON.stringify(driftItem)}],"checkedSources":["https://legislation.gov.au/act"]}`,
    );
    dirs.push(dir);
    const result = await runLawWatch({ cli: script, root: dir, jurisdictions: ["ACT"] });
    expect(result).toEqual({
      drift: [driftItem],
      checkedSources: ["https://legislation.gov.au/act"],
    });
    const saved = persistLawWatchResult(result!);
    expect(saved.drift).toEqual([driftItem]);
    expect(saved.checkedSources).toEqual(["https://legislation.gov.au/act"]);
    expect(saved.lastCheckedAt).toBeGreaterThan(0);
    expect(loadLawWatch()).toEqual(saved);
  });

  it("treats empty drift as current", async () => {
    const { dir, script } = fakeHermes(`{"drift":[],"checkedSources":["https://legislation.nsw.gov.au/x"]}`);
    dirs.push(dir);
    const result = await runLawWatch({ cli: script, root: dir, jurisdictions: ["NSW"] });
    expect(result).toEqual({
      drift: [],
      checkedSources: ["https://legislation.nsw.gov.au/x"],
    });
  });

  it("returns null when the worker answers junk", async () => {
    const { dir, script } = fakeHermes("The Acts look about the same to me.");
    dirs.push(dir);
    expect(await runLawWatch({ cli: script, root: dir })).toBeNull();
  });

  it("returns null when a drift item is missing a field", async () => {
    const { dir, script } = fakeHermes(`{"drift":[{"jurisdiction":"ACT","topic":"bond-cap"}],"checkedSources":[]}`);
    dirs.push(dir);
    expect(await runLawWatch({ cli: script, root: dir })).toBeNull();
  });

  it("does not spawn the live worker under VITEST without a cli stub", async () => {
    expect(await runLawWatch()).toBeNull();
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
