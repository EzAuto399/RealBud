import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Desk } from "./desk.ts";
import { EMPTY_BOOK_DETAIL, morningCheckResult } from "./routines.ts";
import { removeFixture } from "./testing/private-fixture.ts";

const dirs: string[] = [];
function tempDesk() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-live-book-"));
  dirs.push(dir);
  const now = () => new Date(2026, 8, 30, 8, 0, 0).getTime();
  return { dir, now, desk: new Desk({ file: join(dir, "desk.json"), now }) };
}
const reopen = (dir: string, now: () => number) => new Desk({ file: join(dir, "desk.json"), now });
const realProperty = { address: "1 Fictional Way, Testville", tenantName: "Fictional Tenant", tenantPhone: "0400 000 000", weeklyRentCents: 50_000 };

afterEach(async () => { for (const dir of dirs.splice(0)) await removeFixture(dir); });

describe("office book after linking", () => {
  it("replaces an untouched sample with an empty live book, durably and idempotently", () => {
    const { desk, dir, now } = tempDesk();
    expect(desk.snapshot().mode).toBe("demo");
    expect(desk.isUntouchedSample()).toBe(true);
    const before = desk.revision;
    expect(desk.startLiveBookIfUntouched()).toBe(true);
    const snap = desk.snapshot();
    expect(snap).toMatchObject({ mode: "live", demo: false, properties: [], ledger: [], drafts: [], escalations: [], lastRunAt: null });
    expect(snap.sources.some(source => source.kind === "demo")).toBe(false);
    expect(snap.book?.cases ?? []).toEqual([]);
    expect(snap.book?.agency.name).toBe("");
    expect(desk.revision).toBe(before + 1);

    // Restart: still live and empty, no sample re-seeded, a second start is a no-op.
    const again = reopen(dir, now);
    expect(again.snapshot()).toMatchObject({ mode: "live", properties: [] });
    const revision = again.revision;
    expect(again.startLiveBookIfUntouched()).toBe(false);
    expect(again.startLiveBook().revision).toBe(revision);
  });

  it("keeps an edited sample and leaves the choice to the person", () => {
    const { desk } = tempDesk();
    const first = desk.snapshot().properties[0]!;
    desk.patchProperty(first.id, { graceDays: first.options.graceDays + 1 });
    expect(desk.isUntouchedSample()).toBe(false);
    expect(desk.startLiveBookIfUntouched()).toBe(false);
    expect(desk.snapshot().mode).toBe("demo");
    expect(desk.snapshot().properties.length).toBeGreaterThan(0);

    expect(() => desk.startLiveBook({ expectedRevision: desk.revision - 1 })).toThrow(/changed/);
    expect(desk.snapshot().mode).toBe("demo");
    const live = desk.startLiveBook({ expectedRevision: desk.revision });
    expect(live).toMatchObject({ mode: "live", properties: [] });
  });

  it("treats a sample that was used, not just edited, as touched", () => {
    const { desk } = tempDesk();
    desk.runMorningCheck();
    expect(desk.isUntouchedSample()).toBe(false);
    expect(desk.startLiveBookIfUntouched()).toBe(false);
    expect(desk.snapshot().mode).toBe("demo");
  });

  it("never wipes a live book that holds real properties", () => {
    const { desk, dir, now } = tempDesk();
    desk.startLiveBookIfUntouched();
    desk.addProperty(realProperty);
    const revision = desk.revision;
    expect(desk.startLiveBookIfUntouched()).toBe(false);
    expect(desk.startLiveBook({ expectedRevision: revision }).properties).toHaveLength(1);
    expect(reopen(dir, now).snapshot()).toMatchObject({ mode: "live", properties: [{ address: realProperty.address }] });
  });

  it("keeps a sample that still holds fixture rows when a property is added", () => {
    const { desk } = tempDesk();
    const snap = desk.addProperty(realProperty);
    expect(snap.mode).toBe("demo");
    expect(snap.properties.some(property => property.address === realProperty.address)).toBe(true);
  });

  it("becomes the office book when the first real property lands on a sample with no fixture rows left", () => {
    const { desk } = tempDesk();
    for (const property of desk.snapshot().properties) desk.removeProperty(property.id);
    expect(desk.snapshot().mode).toBe("demo");
    const snap = desk.addProperty(realProperty);
    expect(snap.mode).toBe("live");
    expect(snap.properties.map(property => property.address)).toEqual([realProperty.address]);
    // Scrubbed like a started office book: no sample source, recipe, cards or name.
    expect(snap.sources.some(source => source.kind === "demo")).toBe(false);
    expect(snap).toMatchObject({ demo: false, drafts: [], escalations: [], lastRunAt: null });
    expect(snap.book?.agency.name).toBe("");
    expect(JSON.stringify(snap)).not.toContain("fake-building-portal");
  });

  it("becomes the office book when the first book proposal is accepted on a cleared sample", () => {
    const { desk } = tempDesk();
    for (const property of desk.snapshot().properties) desk.removeProperty(property.id);
    desk.proposeBook({ items: [realProperty, { ...realProperty, address: "2 Fictional Way, Testville" }] }, "manual");
    const [first] = desk.snapshot().book?.bookProposals ?? [];
    const snap = desk.allowBookProposal(first!.id);
    expect(snap.mode).toBe("live");
    expect(snap.properties.map(property => property.address)).toEqual([realProperty.address]);
    expect(snap.book?.bookProposals.map(proposal => proposal.address)).toEqual(["2 Fictional Way, Testville"]);
  });

  it("rechecks an empty office book calmly without asking Bud, then checks normally once a property lands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-live-book-"));
    dirs.push(dir);
    const now = () => new Date(2026, 8, 30, 7, 30, 0).getTime();
    const asked: string[][] = [];
    const desk = new Desk({ file: join(dir, "desk.json"), now, hermes: async (ids) => { asked.push(ids); return { rows: null, detail: "Bud found no ledger facts — facts stay held." }; } });
    desk.startLiveBookIfUntouched();

    const empty = await desk.runMorningCheckLive();
    expect(asked).toEqual([]);
    expect(empty).toMatchObject({ mode: "live", properties: [], handsDetail: EMPTY_BOOK_DETAIL, lastRunAt: null, results: [] });
    expect(morningCheckResult(empty)).toEqual({ ok: true, detail: EMPTY_BOOK_DETAIL, quiet: true });
    // A second empty run is a no-op, not another revision every morning.
    const revision = desk.revision;
    await desk.runMorningCheckLive();
    expect(desk.revision).toBe(revision);

    desk.addProperty(realProperty);
    const held = await desk.runMorningCheckLive();
    expect(asked).toHaveLength(1);
    expect(held.hands).toBe("held");
    expect(held.handsDetail).toMatch(/facts stay held/);
    expect(morningCheckResult(held).ok).toBe(false);
  });
});
