// REI Cloud as Desk's source of truth (docs/decisions/2026-10-06-rei-source-of-truth-and-client-packs.md):
// REI wins, a Desk edit is held as "Differs from REI" until a person picks,
// new properties are cards, unmatched or ambiguous rows are held, and only
// parts read completely are fresh. FICTIONAL data and the fictional REI portal
// only: this proves RealBud's mapping and rules, never REI Cloud's columns.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserApprovalStore } from "./browser-authority.ts";
import { BrowserTaskStore } from "./browser-grants.ts";
import { BrowserRuntime } from "./browser-runtime.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { encryptJson } from "./desk-crypto.ts";
import { Desk, fixtureBook } from "./desk.ts";
import { emptyV2 } from "./desk-store.ts";
import { migrateV2ToV3 } from "./desk-v3-migrate.ts";
import type { PortalRecipeResult, PortalRunRequest } from "./portal-recipe-runner.ts";
import { portalRecipeTaskProposal, runPortalRecipeTask } from "./portal-recipe-task.ts";
import { reiDeskSyncLine, syncReiReadIntoDesk } from "./rei-desk-sync.ts";
import { morningCheckResult, ownerLetterResult } from "./routines.ts";
import { REI_FRESH_MS, reiPartsFreshness } from "./source-gate.ts";
import { FICTIONAL_BUSINESS, FICTIONAL_REICID, FICTIONAL_TENANT_COLUMNS, fictionalReiPack, fictionalReiPortal } from "./testing/fictional-rei-portal.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeFixture(dir); });
const KEY = Buffer.alloc(32, 7);
const T0 = new Date(2026, 9, 6, 7, 0, 0).getTime();

function liveDesk(file?: string) {
  const dir = file ? "" : mkdtempSync(join(tmpdir(), "realbud-rei-desk-"));
  if (dir) dirs.push(dir);
  let now = T0;
  const desk = new Desk({ file: file ?? join(dir, "desk.json"), now: () => now, key: KEY });
  if (!file) desk.startLiveBook();
  return { desk, file: file ?? join(dir, "desk.json"), tick: (ms: number) => { now += ms; return now; }, now: () => now };
}

const TENANTS: PortalRunRequest = { recipe: "find-record", inputs: { list: "Tenants", query: "" } };
const ARREARS: PortalRunRequest = { recipe: "arrears-review", inputs: { min_days: "1" } };
const OWNERS: PortalRunRequest = { recipe: "find-record", inputs: { list: "Owners", query: "" } };
const done = (recipe: string, rows: Array<Record<string, string>>, extra: Partial<PortalRecipeResult> = {}): PortalRecipeResult =>
  ({ recipe, outcome: "completed", rows, filters: {}, table: rows.length ? "rows" : "empty", pages: 1, footer: rows.length, stopBefore: [], ...extra });
const tenantRow = (cells: string[]) => Object.fromEntries(FICTIONAL_TENANT_COLUMNS.map((col, i) => [col, cells[i] ?? ""]));
const bravo = (rent = "$540.00 per week", owner = "Fictional Owner One", surname = "Bravo") =>
  tenantRow(["FT-BRAVO", surname, "Fictional", "FP-02", rent, "2026-09-12", "0.00", "-9", "540.00", "2027-03-31", "", owner, "4470002"]);
const readTenants = (desk: Desk, rows: Array<Record<string, string>>, observedAt: number) =>
  syncReiReadIntoDesk(desk, { runs: [TENANTS], results: [done("find-record", rows)], observedAt })!;
const bravoProperty = (desk: Desk) => desk.snapshot().properties.find((property) => property.propertyCode === "FP-02")!;

describe("REI wins, Desk edits are held", () => {
  it("updates REI fields, holds a Desk-edited field as Differs from REI, and a person's pick settles it", () => {
    const { desk, file, tick } = liveDesk();
    desk.addProperty({ address: "2 Fictional St", propertyCode: "FP-02", tenantName: "Fictional Bravo", tenantPhone: "0400 000 002", weeklyRentCents: 50_000 });
    const first = readTenants(desk, [bravo()], tick(1000));
    let property = bravoProperty(desk);
    // Rent was typed in Desk and REI disagrees: held, not overwritten. The rest comes from REI.
    expect(property.weeklyRentCents).toBe(50_000);
    expect(property.differs).toEqual([{ field: "weeklyRentCents", rei: 54_000, observedAt: T0 + 1000 }]);
    expect(property).toMatchObject({ owner: { name: "Fictional Owner One", contact: "" }, amountOwingCents: 54_000, paidTo: "2026-09-12", rei: { property: "FP-02", tenancy: "FT-BRAVO" } });
    expect(property.origins).toMatchObject({ tenantName: { source: "rei" }, ownerName: { source: "rei", observedAt: T0 + 1000 }, weeklyRentCents: { source: "desk" }, address: { source: "desk" } });
    expect(first).toMatchObject({ updated: 1, differs: 1, held: 0, proposed: 0 });
    expect(reiDeskSyncLine(first)).toMatch(/1 Desk value differs from REI and waits for you to pick/);

    // A REI-sourced field follows REI; the held REI value moves with REI; the Desk value still stands.
    readTenants(desk, [bravo("$560.00 per week", "Fictional Owner One", "Bravo-Renamed")], tick(1000));
    property = bravoProperty(desk);
    expect(property.tenantName).toBe("Fictional Bravo-Renamed");
    expect(property.weeklyRentCents).toBe(50_000);
    expect(property.differs).toEqual([{ field: "weeklyRentCents", rei: 56_000, observedAt: T0 + 2000 }]);

    // A person edits the owner in Desk: the next REI read holds it instead of overwriting it.
    desk.editPropertyFacts(property.id, { ownerName: "Owner Typed In Desk" });
    readTenants(desk, [bravo("$560.00 per week", "Fictional Owner One", "Bravo-Renamed")], tick(1000));
    property = bravoProperty(desk);
    expect(property.owner?.name).toBe("Owner Typed In Desk");
    expect(property.differs?.map((item) => item.field).sort()).toEqual(["ownerName", "weeklyRentCents"]);

    // Keep Desk: the value stays and the same REI value is not raised again; a new REI value is.
    desk.resolveReiDiffer(property.id, "weeklyRentCents", "desk");
    // Use REI: REI's value replaces Desk's and REI owns the field again.
    desk.resolveReiDiffer(property.id, "ownerName", "rei");
    property = bravoProperty(desk);
    expect(property.weeklyRentCents).toBe(50_000);
    expect(property.owner?.name).toBe("Fictional Owner One");
    expect(property.origins?.ownerName).toMatchObject({ source: "rei" });
    expect(property.differs).toBeUndefined();
    expect(readTenants(desk, [bravo("$560.00 per week", "Fictional Owner One", "Bravo-Renamed")], tick(1000)).differs).toBe(0);
    expect(bravoProperty(desk).differs).toBeUndefined();
    readTenants(desk, [bravo("$575.00 per week", "Fictional Owner One", "Bravo-Renamed")], tick(1000));
    expect(bravoProperty(desk).differs).toEqual([{ field: "weeklyRentCents", rei: 57_500, observedAt: T0 + 5000 }]);
    expect(() => desk.resolveReiDiffer(property.id, "weeklyRentCents", "both")).toThrow(/Pick REI or Desk/);
    expect(() => desk.resolveReiDiffer(property.id, "tenantName", "rei")).toThrow(/already settled/);
    expect(() => desk.editPropertyFacts(property.id, { tenantPhone: "1" })).toThrow(/Change only/);

    // Everything above survives a restart.
    const reopened = new Desk({ file, now: () => T0, key: KEY });
    expect(bravoProperty(reopened)).toMatchObject({ weeklyRentCents: 50_000, propertyCode: "FP-02", differs: [{ field: "weeklyRentCents", rei: 57_500 }], origins: { weeklyRentCents: { source: "desk", declinedRei: 56_000 } } });
  });
});

describe("new properties", () => {
  it("proposes a property REI has and Desk doesn't as a card, never adds it, and allowing it keeps REI as the source", () => {
    const { desk, tick } = liveDesk();
    const row = tenantRow(["FT-FOXTROT", "Foxtrot", "Fictional", "FP-09", "$480.00 per week", "2026-09-22", "0.00", "0", "0.00", "2027-03-31", "", "Fictional Owner Two", "4470010"]);
    expect(readTenants(desk, [row], tick(1000))).toMatchObject({ proposed: 1, updated: 0 });
    expect(readTenants(desk, [row], tick(1000)).proposed).toBe(0);
    const snap = desk.snapshot();
    expect(snap.properties).toEqual([]);
    expect(snap.book?.bookProposals).toEqual([expect.objectContaining({ address: "FP-09", tenantName: "Fictional Foxtrot", tenantPhone: "", weeklyRentCents: 48_000, ownerName: "Fictional Owner Two", origin: "rei" })]);
    // A request body cannot pose as REI.
    desk.proposeBook({ items: [{ address: "9 Other St", tenantName: "T", tenantPhone: "", weeklyRentCents: 1, ownerName: "x", rei: { property: "FP-99" } }] });
    expect(desk.snapshot().book?.bookProposals).toHaveLength(1);
    desk.allowBookProposal(snap.book!.bookProposals[0].id);
    const added = desk.snapshot().properties[0];
    expect(added).toMatchObject({ address: "FP-09", owner: { name: "Fictional Owner Two" }, rei: { property: "FP-09", tenancy: "FT-FOXTROT" }, origins: { address: { source: "rei" }, tenantName: { source: "rei" }, weeklyRentCents: { source: "rei" } } });
    // REI owns it: the next read updates it directly.
    readTenants(desk, [{ ...row, Rent: "$500.00 per week" }], tick(1000));
    expect(desk.snapshot().properties[0]).toMatchObject({ weeklyRentCents: 50_000, paidTo: "2026-09-22", amountOwingCents: 0 });
    expect(desk.snapshot().properties[0].differs).toBeUndefined();
  });
});

describe("one write per read", () => {
  it("a read with more new properties than one staging allows changes nothing: no stamps, updates or cards", () => {
    const { desk, file, tick } = liveDesk();
    desk.addProperty({ address: "2 Fictional St", propertyCode: "FP-02", tenantName: "Fictional Tenant Bravo", tenantPhone: "1", weeklyRentCents: 50_000 });
    const many = Array.from({ length: 1001 }, (_, i) => tenantRow([`FT-N${i}`, `New${i}`, "Fictional Tenant", `FN-${i}`, "$400.00 per week", "2026-09-20", "0.00", "0", "0.00"]));
    const before = desk.snapshot();
    expect(() => readTenants(desk, [bravo("$540.00 per week", "Fictional Owner One"), ...many], tick(1000))).toThrow(/at most 1000/);
    const after = new Desk({ file, now: () => T0, key: KEY }).snapshot();
    expect(after.sources.filter((source) => source.id.startsWith("src-rei-"))).toEqual([]);
    expect(after.properties).toEqual(before.properties);
    expect(after.book?.bookProposals ?? []).toEqual([]);
    expect(desk.snapshot().properties).toEqual(before.properties);
  });
});

describe("only parts read whole are applied", () => {
  it("a partial owners or arrears read changes nothing and holds nothing", () => {
    const { desk, tick } = liveDesk();
    desk.addProperty({ address: "2 Fictional St", propertyCode: "FP-02", tenantName: "Fictional Tenant Bravo", tenantPhone: "1", weeklyRentCents: 54_000 });
    const before = desk.snapshot().properties;
    const partialOwners = done("find-record", [{ Name: "Fictional Owner Nobody", Reference: "FO-9", Email: "x" }], { footer: 40 });
    const partialArrears = done("arrears-review", [{ Name: "Fictional Tenant Bravo", "Paid to": "2026-09-01", "Amount owing": "999.00" }, { Name: "Nobody On Desk", "Paid to": "2026-09-01", "Amount owing": "1.00" }], { footer: 12 });
    const sync = syncReiReadIntoDesk(desk, { runs: [OWNERS, ARREARS], results: [partialOwners, partialArrears], observedAt: tick(1000) })!;
    expect(sync).toMatchObject({ held: 0, updated: 0, fresh: [] });
    expect(desk.snapshot().book?.importIssues ?? []).toEqual([]);
    expect(desk.snapshot().properties).toEqual(before);
  });
});

describe("rows Desk cannot place", () => {
  it("holds unmatched and ambiguous rows as held work and changes nothing for them", () => {
    const { desk, tick } = liveDesk();
    desk.addProperty({ address: "2 Fictional St", propertyCode: "FP-02", tenantName: "Fictional Bravo", tenantPhone: "1", weeklyRentCents: 54_000 });
    desk.addProperty({ address: "6 Fictional St", tenantName: "Shared Name", tenantPhone: "1", weeklyRentCents: 50_000 });
    desk.addProperty({ address: "7 Fictional St", tenantName: "Shared Name", tenantPhone: "1", weeklyRentCents: 52_000 });
    const before = desk.snapshot().properties.map((property) => ({ ...property }));
    const kilo = tenantRow(["FT-KILO", "Kilo", "", "", "$400.00 per week"]);
    const india = tenantRow(["FT-INDIA", "India", "Fictional", "FP-04", "$600.00 per week", "2026-08-30", "0.00", "-22", "1320.00"]);
    const bravoTwo = tenantRow(["FT-BRAVO2", "Bravo-Two", "Fictional", "FP-04", "$600.00 per week", "2026-09-21"]);
    const arrears = [
      { Name: "Shared Name", Status: "Active", "Paid to": "2026-09-01", "Rent credit": "0.00", Days: "20", "Amount owing": "800.00" },
      { Name: "Nobody On Desk", Status: "Active", "Paid to": "2026-09-01", "Rent credit": "0.00", Days: "20", "Amount owing": "800.00" },
    ];
    const sync = syncReiReadIntoDesk(desk, { runs: [TENANTS, ARREARS], results: [done("find-record", [kilo, india, bravoTwo]), done("arrears-review", arrears)], observedAt: tick(1000) })!;
    expect(sync).toMatchObject({ held: 4, updated: 0, proposed: 0 });
    const issues = desk.snapshot().book!.importIssues.map(({ kind, rawIdentity }) => ({ kind, rawIdentity }));
    expect(issues).toEqual(expect.arrayContaining([
      { kind: "unmatched", rawIdentity: "REI tenant FT-KILO" },
      { kind: "ambiguous", rawIdentity: "REI property FP-04" },
      { kind: "ambiguous", rawIdentity: "REI arrears Shared Name" },
      { kind: "unmatched", rawIdentity: "REI arrears Nobody On Desk" },
    ]));
    expect(issues).toHaveLength(4);
    expect(desk.snapshot().properties).toEqual(before);
    expect(desk.snapshot().book?.bookProposals).toEqual([]);
    // The same rows read again do not pile up.
    syncReiReadIntoDesk(desk, { runs: [TENANTS, ARREARS], results: [done("find-record", [kilo, india, bravoTwo]), done("arrears-review", arrears)], observedAt: tick(1000) });
    expect(desk.snapshot().book!.importIssues).toHaveLength(4);
  });
});

describe("freshness per part", () => {
  it("stamps only parts read completely; a partial or searched read leaves its part stale and the book's check untouched", () => {
    const { desk, tick, now } = liveDesk();
    const before = desk.snapshot();
    const partialArrears = done("arrears-review", [{ Name: "Fictional Tenant Bravo", "Paid to": "2026-09-12", "Amount owing": "540.00" }], { outcome: "blocked", pages: 1, footer: 6 });
    const sync = syncReiReadIntoDesk(desk, { runs: [TENANTS, ARREARS, OWNERS], results: [done("find-record", [bravo()]), partialArrears, done("find-record", [], { outcome: "not-run", table: "unread", pages: 0, footer: undefined })], observedAt: tick(1000) })!;
    expect(sync.fresh).toEqual(["tenants"]);
    expect(sync.stale).toEqual(["arrears", "owners"]);
    expect(reiDeskSyncLine(sync)).toMatch(/Not fresh from REI: arrears, owners\./);
    const snap = desk.snapshot();
    expect(snap.lastRunAt).toBe(before.lastRunAt);
    expect(snap.hands).toBe(before.hands);
    expect(snap.sources.find((source) => source.id === "src-rei-tenants")?.lastCheckedAt).toBe(T0 + 1000);
    expect(snap.sources.some((source) => source.id === "src-rei-arrears")).toBe(false);
    // A grid footer above the rows read is also partial, even when the recipe finished.
    expect(syncReiReadIntoDesk(desk, { runs: [ARREARS], results: [done("arrears-review", [], { footer: 3 })], observedAt: tick(1000) })!.fresh).toEqual([]);
    // Without the grid's own record count nothing proves the read whole: a footerless empty grid, or page 1 of 2.
    expect(syncReiReadIntoDesk(desk, { runs: [ARREARS], results: [done("arrears-review", [], { footer: undefined })], observedAt: tick(1000) })!.fresh).toEqual([]);
    expect(syncReiReadIntoDesk(desk, { runs: [ARREARS], results: [done("arrears-review", [{ Name: "Fictional Tenant Bravo", "Paid to": "2026-09-12", "Amount owing": "540.00" }], { footer: undefined, pages: 1 })], observedAt: tick(1000) })!.fresh).toEqual([]);
    expect(desk.snapshot().sources.some((source) => source.id === "src-rei-arrears")).toBe(false);
    // A search reads some tenants, never the list.
    expect(syncReiReadIntoDesk(desk, { runs: [{ recipe: "find-record", inputs: { list: "Tenants", query: "Bravo" } }], results: [done("find-record", [bravo()])], observedAt: tick(1000) })!.fresh).toEqual([]);
    // A complete part goes stale a day later.
    expect(reiPartsFreshness(["tenants", "arrears"], desk.snapshot().sources, now())).toEqual({ tenants: true, arrears: false });
    expect(reiPartsFreshness(["tenants"], desk.snapshot().sources, T0 + 1000 + REI_FRESH_MS + 1)).toEqual({ tenants: false });
    // A run with no Desk part is not a Desk read.
    expect(syncReiReadIntoDesk(desk, { runs: [{ recipe: "tasks-due" }], results: [done("tasks-due", [])], observedAt: now() })).toBeNull();
  });
});

describe("older books", () => {
  it("loads a V3 book written before REI facts and a V2 book, keeps their values as Desk's, and saves the new facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-rei-old-")); dirs.push(dir);
    const file = join(dir, "desk.json");
    const old = migrateV2ToV3(emptyV2(fixtureBook()), T0);
    writeFileSync(file, JSON.stringify(encryptJson(KEY, old)), { mode: 0o600 });
    const { desk } = liveDesk(file);
    expect(desk.recovery.active).toBe(false);
    const props = desk.snapshot().properties;
    expect(props.map((property) => property.id)).toEqual(fixtureBook().properties.map((property) => property.id));
    expect(props.every((property) => property.origins === undefined && property.owner === undefined && property.differs === undefined)).toBe(true);
    // A value older than sources is treated as Desk's: REI never silently overwrites it.
    const oak = props[0];
    const row = tenantRow(["FT-OAK", "Different", "Tenant", oak.address, "$1.00 per week", "2026-09-30", "0.00", "0", "12.34", "", "", "Fictional Owner Three"]);
    syncReiReadIntoDesk(desk, { runs: [TENANTS], results: [done("find-record", [row])], observedAt: T0 + 1 });
    const updated = desk.snapshot().properties[0];
    expect(updated.tenantName).toBe(oak.tenantName);
    expect(updated.differs?.map((item) => item.field).sort()).toEqual(["tenantName", "weeklyRentCents"]);
    expect(updated).toMatchObject({ owner: { name: "Fictional Owner Three" }, amountOwingCents: 1234, paidTo: "2026-09-30" });
    expect(new Desk({ file, now: () => T0, key: KEY }).snapshot().properties[0]).toMatchObject({ owner: { name: "Fictional Owner Three" }, differs: expect.any(Array), rei: { property: oak.address } });

    const v2File = join(mkdtempSync(join(tmpdir(), "realbud-rei-v2-")), "desk.json"); dirs.push(join(v2File, ".."));
    writeFileSync(v2File, JSON.stringify(encryptJson(KEY, emptyV2(fixtureBook()))), { mode: 0o600 });
    const v2 = new Desk({ file: v2File, now: () => T0, key: KEY });
    expect(v2.recovery.active).toBe(false);
    expect(v2.snapshot().properties).toHaveLength(fixtureBook().properties.length);
  });
});

describe("REI read through the fictional portal into Desk", () => {
  async function portal(options: Parameters<typeof fictionalReiPortal>[0] = {}) {
    const root = privateTempRoot(join(tmpdir(), "rb-rei-desk-")); dirs.push(root);
    const store = new BrowserTaskStore({ file: join(root, "browser-tasks.json") });
    const mock = fictionalReiPortal(options);
    const runtime = new BrowserRuntime({ root, command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
    await runtime.connect(); await runtime.select("work");
    const stores = { operations: new ConnectedAppOperationStore({ file: join(root, "operations.json") }), approvals: new BrowserApprovalStore({ file: join(root, "approvals.json") }),
      rules: () => [], assertCapability: () => {}, pollMs: 0, workroom: join(root, "work") };
    const proposal = await portalRecipeTaskProposal({ threadId: "thread-ask", messageId: "m1", portal: "rei-cloud", target: "find-record", inputs: TENANTS.inputs, account: { urlValue: FICTIONAL_REICID, marker: FICTIONAL_BUSINESS } }, async () => fictionalReiPack());
    proposal.recipe.runs.push({ ...ARREARS, inputs: { ...ARREARS.inputs! } }, { ...OWNERS, inputs: { ...OWNERS.inputs! } });
    const started = await store.start((await store.propose(proposal, Date.now())).id, { threadId: "thread-ask", browserId: "work" }, Date.now());
    const result = await runPortalRecipeTask({ record: started, grant: started.grant, runtime, approve: async () => false, signal: new AbortController().signal, isActive: () => true, load: async () => fictionalReiPack(), ...stores });
    return { mock, result, runs: started.recipe!.runs };
  }

  it("reads tenants, arrears and owners read-only and lands them on Desk under the rules", async () => {
    const { mock, result, runs } = await portal();
    expect(result.outcome, result.detail).toBe("completed");
    expect(mock.effects).toEqual([]);
    const { desk, tick } = liveDesk();
    desk.addProperty({ address: "2 Fictional St", propertyCode: "FP-02", tenantName: "Fictional Tenant Bravo", tenantPhone: "1", weeklyRentCents: 50_000 });
    const sync = syncReiReadIntoDesk(desk, { runs, results: result.results, observedAt: tick(1000) })!;
    expect(sync.fresh).toEqual(["tenants", "arrears", "owners"]);
    expect(sync.stale).toEqual([]);
    const snap = desk.snapshot();
    expect(bravoProperty(desk)).toMatchObject({ weeklyRentCents: 50_000, differs: [{ field: "weeklyRentCents", rei: 54_000 }], owner: { name: "Fictional Owner One" }, amountOwingCents: 54_000, rei: { property: "FP-02", tenancy: "FT-BRAVO" } });
    // Every other property REI lists is a card; nothing was added.
    expect(snap.properties).toHaveLength(1);
    expect(snap.book!.bookProposals.map((card) => card.address).sort()).toEqual(["FP-01", "FP-03", "FP-05", "FP-06", "FP-07", "FP-08", "FP-09", "FP-10"]);
    expect(snap.book!.bookProposals.find((card) => card.address === "FP-10")).toMatchObject({ weeklyRentCents: 55_385, ownerName: "Fictional Owner One" });
    // FT-KILO has no property and FP-04 shows two tenancies. The arrears grid names tenants as the tenants grid
    // does, so Bravo's arrears row lands; Juliet's (spelled differently by REI, deliberately) is held.
    const issues = snap.book!.importIssues.map((issue) => `${issue.kind} ${issue.rawIdentity}`);
    expect(issues).toEqual(expect.arrayContaining(["unmatched REI tenant FT-KILO", "ambiguous REI property FP-04", "unmatched REI arrears Fictional Juliet"]));
    expect(issues.some((issue) => issue.includes("Fictional Tenant Bravo"))).toBe(false);
    expect(issues.some((issue) => issue.includes("REI owner"))).toBe(false);
    expect(snap.lastRunAt).toBeNull();
  });

  it("keeps the unread parts stale when pagination stalls mid-read", async () => {
    const { mock, result, runs } = await portal({ stuckPagination: true });
    expect(result.outcome).not.toBe("completed");
    expect(mock.effects).toEqual([]);
    const { desk, tick } = liveDesk();
    const sync = syncReiReadIntoDesk(desk, { runs, results: result.results, observedAt: tick(1000) })!;
    expect(sync.fresh).toEqual(["tenants"]);
    expect(sync.stale).toEqual(["arrears", "owners"]);
  });
});

describe("morning money check on REI facts", () => {
  it("holds a proposal built on REI facts while REI tenants or arrears are not fresh; Desk-only properties still draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-rei-money-"));
    dirs.push(dir);
    let now = T0;
    // Every property is 3 days late with no rent landed: a courtesy draft unless something holds it.
    const desk = new Desk({ file: join(dir, "desk.json"), now: () => now, key: KEY,
      hermes: async (ids) => ({ rows: ids.map((propertyId) => ({ propertyId, daysSinceDue: 3, rentLanded: false, levyPaid: false, daysSinceCourtesy: null })), detail: "Worker answered." }) });
    desk.startLiveBook();
    desk.addProperty({ address: "1 Desk Only St", tenantName: "Fictional Desk", tenantPhone: "0400 000 001", weeklyRentCents: 40_000 });
    desk.addProperty({ address: "2 Fictional St", propertyCode: "FP-02", tenantName: "Fictional Bravo", tenantPhone: "0400 000 002", weeklyRentCents: 50_000 });
    const deskOnly = desk.snapshot().properties.find((property) => property.propertyCode !== "FP-02")!.id;
    const bravoId = bravoProperty(desk).id;
    const outcome = (snap: Awaited<ReturnType<Desk["runMorningCheckLive"]>>, id: string) => snap.results.find((row) => row.propertyId === id);

    // A Desk-only book with REI never read: nothing is gated.
    let snap = await desk.runMorningCheckLive();
    expect(outcome(snap, deskOnly)).toMatchObject({ outcome: "draft" });
    expect(outcome(snap, bravoId)).toMatchObject({ outcome: "draft" });
    expect(morningCheckResult(snap, now)).toEqual({ ok: true, detail: "Worker answered." });

    // Tenants read whole (REI now owns Bravo's tenant name), arrears never read: Bravo is held with a plain reason.
    now += 1000;
    readTenants(desk, [bravo()], now);
    snap = await desk.runMorningCheckLive();
    expect(outcome(snap, deskOnly)).toMatchObject({ outcome: "draft" });
    expect(outcome(snap, bravoId)).toMatchObject({ outcome: "hold", reason: "stale-source" });
    expect(snap.workItems.find((item) => item.propertyId === bravoId && item.state === "held")?.holdReason)
      .toBe("stale-source: REI arrears not fresh: run the REI morning refresh or sign in to REI.");
    expect(morningCheckResult(snap, now)).toEqual({ ok: false, covered: 1, uncovered: 1,
      detail: "Worker answered. 1 property held: REI arrears not fresh: run the REI morning refresh or sign in to REI." });

    // Arrears read whole too: Bravo's proposal goes ahead.
    now += 1000;
    syncReiReadIntoDesk(desk, { runs: [ARREARS], results: [done("arrears-review", [])], observedAt: now });
    snap = await desk.runMorningCheckLive();
    expect(outcome(snap, bravoId)).toMatchObject({ outcome: "draft" });
    expect(morningCheckResult(snap, now).ok).toBe(true);

    // A day later both parts are stale again.
    now += REI_FRESH_MS + 1;
    snap = await desk.runMorningCheckLive();
    expect(outcome(snap, bravoId)).toMatchObject({ outcome: "hold", reason: "stale-source" });
    expect(morningCheckResult(snap, now).detail).toMatch(/1 property held: REI tenants and arrears not fresh/);
  });
});

describe("owner letters on REI facts", () => {
  it("holds a letter built on REI owner or arrears facts while REI is not fresh; Desk-only properties still get one", () => {
    const { desk, tick, now } = liveDesk();
    desk.addProperty({ address: "1 Desk Only St", tenantName: "Fictional Desk", tenantPhone: "0400 000 001", weeklyRentCents: 40_000 });
    desk.addProperty({ address: "2 Fictional St", propertyCode: "FP-02", tenantName: "Fictional Bravo", tenantPhone: "0400 000 002", weeklyRentCents: 50_000 });
    const bravoId = bravoProperty(desk).id;
    const letters = () => desk.snapshot().drafts.filter((d) => d.kind === "owner-letter");
    const lettersFor = (id: string) => letters().filter((d) => d.propertyId === id).length;
    const letterHolds = () => desk.snapshot().workItems.filter((w) => w.kind === "owner-letter" && w.state === "held");

    // A Desk-only book with REI never read: every property gets its letter, as before.
    let snap = desk.draftOwnerLetters();
    expect(letters()).toHaveLength(2);
    expect(ownerLetterResult(snap, 0, now())).toEqual({ ok: true, detail: "Owner letters on Desk: 2 (2 new this week)." });

    // Next week: tenants read whole (REI now owns Bravo's owner, amount owing and paid-to), arrears and owners never read.
    tick(7 * 24 * 60 * 60_000);
    readTenants(desk, [bravo()], tick(1000));
    snap = desk.draftOwnerLetters();
    desk.draftOwnerLetters(); // a second run the same week stacks nothing
    snap = desk.snapshot();
    expect(lettersFor(bravoId)).toBe(1);
    expect(letters()).toHaveLength(3);
    expect(letterHolds()).toHaveLength(1);
    expect(letterHolds()[0]).toMatchObject({ propertyId: bravoId,
      holdReason: "stale-source: REI arrears and owners not fresh: run the REI morning refresh or sign in to REI." });
    expect(ownerLetterResult(snap, 2, now())).toEqual({ ok: false, covered: 1, uncovered: 1,
      detail: "Owner letters on Desk: 3 (1 new this week). 1 property held: REI arrears and owners not fresh: run the REI morning refresh or sign in to REI." });

    // Arrears and owners read whole too: Bravo's letter goes ahead.
    syncReiReadIntoDesk(desk, { runs: [ARREARS, OWNERS], results: [done("arrears-review", []), done("find-record", [])], observedAt: tick(1000) });
    snap = desk.draftOwnerLetters();
    expect(lettersFor(bravoId)).toBe(2);
    expect(ownerLetterResult(snap, 3, now())).toEqual({ ok: true, detail: "Owner letters on Desk: 4 (1 new this week)." });
  });
});
