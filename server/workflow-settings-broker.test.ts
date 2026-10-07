// Bud's working-rules tools: a read with no card, every change and restore behind
import { privateTempRoot } from "./testing/private-fixture.ts";
// the one-time card, the stores' revision checks, and kept earlier versions.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgencySetupService } from "./agency-setup.ts";
import { ensureDirs } from "./config.ts";
import type { ProviderInstance } from "./contracts.ts";
import { HermesAgentDriver } from "./drivers/acp/hermes.ts";
import { createInspectionRulesStore } from "./inspection-rules.ts";
import { createMaintenanceReviewStore } from "./maintenance-review.ts";
import { recordEvents, type EventRecorder } from "./testing/events.ts";
import { removeFixture } from "./testing/private-fixture.ts";
import { LoopManager, type LoopManagerOptions } from "./routines.ts";
import type { LoopbackToolServer } from "./web-research-broker.ts";
import { createApprovalSettings } from "./approval-settings.ts";
import { defaultApprovalSettings, type ApprovalSettings } from "../shared/approval-settings.ts";
import { APPROVAL_POLICY_CONFLICT, bindApprovalPolicy, bindWorkflowSettings, clockLabel, dateRanges, friendly, LOOP_SCHEDULE_CONFLICT, scheduleWords, SETTINGS_CONFLICT, startWorkflowSettingsBroker, type BudWorkflowSettings } from "./workflow-settings-broker.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("./managed-service.ts", () => ({ managedService: { assertCapability } }));

const directories: string[] = [], managers: LoopManager[] = [];
const cleanUp = async () => { managers.splice(0).forEach(manager => manager.close()); await Promise.all(directories.splice(0).map(path => removeFixture(path))); };
async function stores(listRecipes?: LoopManagerOptions["listRecipes"], approvals?: Parameters<typeof bindWorkflowSettings>[0]["approvals"]) {
  const directory = privateTempRoot(join(tmpdir(), "realbud-bud-settings-")); directories.push(directory);
  const maintenance = createMaintenanceReviewStore({ file: join(directory, "maintenance-review.json"), now: () => 5_000 });
  const inspection = createInspectionRulesStore({ file: join(directory, "inspection-rules.json"), now: () => 5_000 });
  const agencyService = createAgencySetupService({ directory, workspaceId: randomUUID(), actorId: () => "fictional-actor", now: () => 5_000 });
  const agencySaves = vi.fn(async (body: Parameters<typeof agencyService.save>[0]) => { await agencyService.save(body); });
  const loops = new LoopManager({ file: join(directory, "loops.json"), hostTimezone: "UTC", now: () => Date.parse("2026-10-06T09:00:00Z"), listRecipes,
    execute: async () => ({ ok: true, detail: "Fictional run." }) });
  managers.push(loops);
  let refusal: string | null = null;
  const settings: BudWorkflowSettings = bindWorkflowSettings({ maintenance, inspection, agency: { read: agencyService.getConfiguration, save: agencySaves }, loops, writable: () => refusal, approvals });
  return { maintenance, inspection, agencyService, agencySaves, loops, settings, loop: (id: string) => loops.listLoops().find(row => row.id === id)!, refuse: (value: string | null) => { refusal = value; } };
}

describe("review card wording", () => {
  it("collapses consecutive closed days into ranges and reads values plainly", () => {
    const closed = ["2026-12-25", "2026-12-24", "2026-12-26", "2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"];
    expect(dateRanges(closed)).toBe("24 Dec 2026 – 2 Jan 2027");
    expect(dateRanges(["2027-01-26", "2026-12-25", "2026-12-26", "2026-12-25"])).toBe("25 Dec 2026 – 26 Dec 2026, 26 Jan 2027");
    expect(dateRanges(["2026-02-28", "2026-03-01"])).toBe("28 Feb 2026 – 1 Mar 2026");
    expect(dateRanges(["soon"])).toBe("soon");
    expect([clockLabel("09:00"), clockLabel("09:30"), clockLabel("00:15"), clockLabel("12:00"), clockLabel("17:45"), clockLabel("9am")]).toEqual(["9:00 am", "9:30 am", "12:15 am", "12:00 pm", "5:45 pm", "9am"]);
    expect(friendly("inspectors", ["Sherry", "Tom"])).toBe("Sherry, Tom");
    expect(friendly("closedDates", [])).toBe("none");
    expect(friendly("basis", "receivedDate")).toBe("date received");
    expect(friendly("workingDays", [1, 2, 3])).toBe("Mon, Tue, Wed");
    expect(friendly("dailyCapacity", 5)).toBe("5");
  });

  it("reads a workflow clock in plain words", () => {
    expect(scheduleWords({ time: "08:00", weekdays: [1] })).toBe("Mondays 8:00 am");
    expect(scheduleWords({ time: "08:00", weekdays: [1, 4] })).toBe("Mondays and Thursdays 8:00 am");
    expect(scheduleWords({ time: "16:00", weekdays: [1, 3, 5] })).toBe("Mondays, Wednesdays and Fridays 4:00 pm");
    expect(scheduleWords({ time: "07:30", weekdays: [1, 2, 3, 4, 5] })).toBe("Weekdays 7:30 am");
    expect(scheduleWords({ time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("Every day 8:00 am");
    expect(scheduleWords({ time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6], intervalDays: 2, anchorDate: "2026-10-02" })).toBe("Every 2 days from 2 Oct 2026, 8:00 am");
    expect(scheduleWords({ time: "09:00", weekdays: [1, 2, 3, 4, 5], monthly: "first-weekday" })).toBe("First weekday of each month, 9:00 am");
  });
});

describe("working rules broker", () => {
  let broker: LoopbackToolServer | undefined;
  afterEach(async () => { broker?.close(); broker = undefined; await cleanUp(); });
  const call = async (name: string, args: unknown, id = 1) => ((await (await fetch(broker!.descriptor.url, { method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(broker!.descriptor.headers.map(row => [row.name, row.value])) },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) })).json()) as any).result;
  const start = async (settings: BudWorkflowSettings, approve: (summary: string) => Promise<boolean>) => {
    const cards: string[] = [];
    broker = await startWorkflowSettingsBroker({ turnId: () => "turn-1", settings: () => settings, approve: async summary => { cards.push(summary); return approve(summary); } });
    return cards;
  };

  it("reads every target with no card", async () => {
    const { settings } = await stores();
    const approve = vi.fn(async () => true);
    const cards = await start(settings, approve);
    const result = await call("workflow_settings_read", {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.settings).toMatchObject({
      maintenance_month_rule: { revision: 0, values: { basis: "invoiceDate", span: "calendarMonth" }, previous: [] },
      inspection_rules: { revision: 0, values: { cycleMonths: 6, cycleBasis: "completed" }, previous: [] },
      morning_priorities: { revision: 0, values: { localTime: "07:30", weekdays: [1, 2, 3, 4, 5], followUpAfterDays: 3 }, previous: null },
    });
    expect(cards).toEqual([]);
    expect(approve).not.toHaveBeenCalled();
  });

  it("shows before → after on one card, and a denial writes nothing", async () => {
    const { settings, maintenance, inspection, agencySaves } = await stores();
    const cards = await start(settings, async () => false);
    expect(await call("workflow_settings_propose", { target: "maintenance_month_rule", values: { span: "rolling30" }, reason: "Sherry compares the last 30 days." }))
      .toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not approve") }] });
    expect(cards[0]).toBe("Change maintenance month rule\nComparison window: calendar month → rolling 30 days\nWhy: Sherry compares the last 30 days.");
    expect(await call("workflow_settings_propose", { target: "morning_priorities", values: { localTime: "07:00", weekdays: [1, 3, 5] }, reason: "Earlier\nstart‮" })).toMatchObject({ isError: true });
    expect(cards[1]).toBe("Change Morning priorities preferences\nTime: 7:30 am → 7:00 am\nDays: Mon, Tue, Wed, Thu, Fri → Mon, Wed, Fri\nSaving changes the agency setup, so Morning priorities and Weekly bills turn off until their setup is reviewed again.\nWhy: Earlier start");
    // Bud's reason never adds lines of its own to the card.
    expect(cards.map(card => card.split("\n").length)).toEqual([3, 5]);
    expect((await maintenance.read()).revision).toBe(0);
    expect((await inspection.read()).revision).toBe(0);
    expect(agencySaves).not.toHaveBeenCalled();
  });

  it("saves an approved change with revision + 1 and keeps the previous version", async () => {
    const { settings, maintenance, inspection, agencyService } = await stores();
    const cards = await start(settings, async () => true);
    expect((await call("workflow_settings_propose", { target: "maintenance_month_rule", values: { basis: "receivedDate" }, reason: "Use received date." })).isError).toBeUndefined();
    expect(await maintenance.read()).toMatchObject({ revision: 1, rule: { basis: "receivedDate", span: "calendarMonth" }, ruleHistory: [{ rule: { basis: "invoiceDate", span: "calendarMonth" }, replacedAt: 5_000 }] });
    expect((await call("workflow_settings_propose", { target: "inspection_rules", values: { cycleMonths: 4, inspectors: ["fictional-inspector-A"] }, reason: "Four-monthly." })).isError).toBeUndefined();
    expect(await inspection.read()).toMatchObject({ revision: 1, rules: { cycleMonths: 4, inspectors: ["fictional-inspector-A"] }, history: [{ rules: { cycleMonths: 6, inspectors: [] } }] });
    expect(cards[1]).toBe("Change inspection rules\nInspect every (months): 6 → 4\nInspectors: none → fictional-inspector-A\nWhy: Four-monthly.");
    const morning = await call("workflow_settings_propose", { target: "morning_priorities", values: { followUpAfterDays: 5 }, reason: "Wait longer." });
    expect(morning.isError).toBeUndefined();
    expect(morning.content[0].text).toContain("it was: Follow up after (days): 3");
    expect(await agencyService.getConfiguration()).toMatchObject({ revision: 1, settings: { morningReview: { followUpAfterDays: 5 } } });
  });

  it("reports a conflict when the setting changed while the card was open", async () => {
    const { settings, maintenance } = await stores();
    await start(settings, async () => { await maintenance.setRule({ rule: { basis: "invoiceDate", span: "rolling30" }, expectedRevision: 0 }); return true; });
    expect(await call("workflow_settings_propose", { target: "maintenance_month_rule", values: { basis: "receivedDate" }, reason: "x" })).toMatchObject({ isError: true, content: [{ text: SETTINGS_CONFLICT }] });
    expect((await maintenance.read()).rule).toEqual({ basis: "invoiceDate", span: "rolling30" });
  });

  it("does not conflict when a maintenance loop run saves findings while the card is open", async () => {
    const { settings, maintenance } = await stores();
    await start(settings, async () => {
      await maintenance.record({ findings: [], run: { runId: "fictional-run", checkedBills: 0, coverage: { from: "2026-09-01", to: "2026-09-30", complete: true }, gaps: [], coverageKey: "a".repeat(64) } });
      return true;
    });
    expect((await call("workflow_settings_propose", { target: "maintenance_month_rule", values: { basis: "receivedDate" }, reason: "x" })).isError).toBeUndefined();
    expect(await maintenance.read()).toMatchObject({ revision: 2, ruleRevision: 1, rule: { basis: "receivedDate", span: "calendarMonth" } });
  });

  it("rejects invalid values with a plain message before any card", async () => {
    const { settings, inspection } = await stores();
    const approve = vi.fn(async () => true);
    const cards = await start(settings, approve);
    expect(await call("workflow_settings_propose", { target: "inspection_rules", values: { cycleMonths: 0 }, reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("whole months") }] });
    expect(await call("workflow_settings_propose", { target: "maintenance_month_rule", values: { span: "fortnight" }, reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("calendar month or rolling 30 days") }] });
    expect(await call("workflow_settings_propose", { target: "morning_priorities", values: { localTime: "8am" }, reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("local morning time") }] });
    expect(await call("workflow_settings_propose", { target: "inspection_rules", values: { planStart: "2026-01-01" }, reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("has the fields") }] });
    expect(await call("workflow_settings_propose", { target: "inspection_rules", values: { cycleMonths: 6 }, reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("already has") }] });
    expect(await call("workflow_settings_propose", { target: "payroll", values: {}, reason: "x" })).toMatchObject({ isError: true });
    expect(await call("workflow_settings_propose", { target: "inspection_rules", values: { cycleMonths: 3 }, reason: "  " })).toMatchObject({ isError: true });
    expect(cards).toEqual([]);
    expect((await inspection.read()).revision).toBe(0);
  });

  it("restores the previous version only after approval, and refuses where none is kept", async () => {
    const { settings, inspection } = await stores();
    let allow = true;
    const cards = await start(settings, async () => allow);
    await call("workflow_settings_propose", { target: "inspection_rules", values: { cycleMonths: 3 }, reason: "Try three." });
    allow = false;
    expect(await call("workflow_settings_restore", { target: "inspection_rules", reason: "Go back." })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not approve") }] });
    expect((await inspection.read()).rules.cycleMonths).toBe(3);
    allow = true;
    expect((await call("workflow_settings_restore", { target: "inspection_rules", reason: "Go back." })).isError).toBeUndefined();
    expect(cards.at(-1)).toBe("Restore earlier inspection rules\nInspect every (months): 3 → 6\nWhy: Go back.");
    expect(await inspection.read()).toMatchObject({ revision: 2, rules: { cycleMonths: 6 }, history: [{ rules: { cycleMonths: 3 } }, { rules: { cycleMonths: 6 } }] });
    expect(await call("workflow_settings_restore", { target: "inspection_rules", previous: 5, reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("from 1 to 2") }] });
    expect(await call("workflow_settings_restore", { target: "morning_priorities", reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("not kept") }] });
    expect(await call("workflow_settings_restore", { target: "maintenance_month_rule", reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("no earlier version") }] });
  });

  it("holds the write when the host refuses after the card (recovery or member change)", async () => {
    const { settings, inspection, refuse } = await stores();
    await start(settings, async () => { refuse("Recover the private book before changing working rules. Nothing was changed."); return true; });
    expect(await call("workflow_settings_propose", { target: "inspection_rules", values: { cycleMonths: 3 }, reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Recover the private book") }] });
    expect((await inspection.read()).revision).toBe(0);
  });

  describe("workflow schedules (loop_schedule)", () => {
    it("reads every workflow's clock with no card", async () => {
      const { settings } = await stores();
      const approve = vi.fn(async () => true);
      await start(settings, approve);
      const result = await call("workflow_settings_read", { target: "loop_schedule" });
      expect(result.content[0].text).toContain('- loop_schedule weekly-bills "Weekly bills review" (revision 1, off): Mondays 8:00 am {"time":"08:00","weekdays":[1]}');
      expect(result.content[0].text).toContain('- loop_schedule inbound-triage "Morning priorities" (revision 1, off, time set by agency setup)');
      expect(result.structuredContent.loops.find((row: any) => row.loopId === "morning-arrears")).toEqual({ loopId: "morning-arrears", name: "Morning money check",
        enabled: true, revision: 1, schedule: { time: "07:30", weekdays: [1, 2, 3, 4, 5] }, waitingForPlan: false, agencyTimed: false });
      expect(approve).not.toHaveBeenCalled();
    });

    it("shows before → after in plain words and saves only on Allow, leaving an off workflow off", async () => {
      const { settings, loop } = await stores();
      let allow = false;
      const cards = await start(settings, async () => allow);
      const propose = () => call("workflow_settings_propose", { target: "loop_schedule", values: { loopId: "weekly-bills", schedule: { weekdays: [4, 1] } }, reason: "Bills land on Thursdays too." });
      expect(await propose()).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not approve") }] });
      expect(cards[0]).toBe("Change workflow schedule\nWeekly bills review: Mondays 8:00 am → Mondays and Thursdays 8:00 am\nIt stays off until someone switches it on in Schedule.\nWhy: Bills land on Thursdays too.");
      expect(loop("weekly-bills")).toMatchObject({ revision: 1, enabled: false, schedule: { time: "08:00", weekdays: [1] } });
      allow = true;
      const saved = await propose();
      expect(saved.isError).toBeUndefined();
      expect(saved.content[0].text).toContain("it was: Mondays 8:00 am");
      expect(loop("weekly-bills")).toMatchObject({ revision: 2, enabled: false, nextRunAt: null, schedule: { time: "08:00", weekdays: [1, 4] } });
      // An on workflow stays on, and its card has no off line.
      expect((await call("workflow_settings_propose", { target: "loop_schedule", values: { loopId: "morning-arrears", schedule: { time: "08:15" } }, reason: "Later start." })).isError).toBeUndefined();
      expect(cards.at(-1)).toBe("Change workflow schedule\nMorning money check: Weekdays 7:30 am → Weekdays 8:15 am\nWhy: Later start.");
      expect(loop("morning-arrears")).toMatchObject({ enabled: true, schedule: { time: "08:15" } });
    });

    it("refuses a stale revision when the schedule changed while the card was open", async () => {
      const { settings, loops, loop } = await stores();
      await start(settings, async () => { loops.patchClock("weekly-bills", { time: "09:15" }); return true; });
      expect(await call("workflow_settings_propose", { target: "loop_schedule", values: { loopId: "weekly-bills", schedule: { weekdays: [1, 4] } }, reason: "x" }))
        .toMatchObject({ isError: true, content: [{ text: LOOP_SCHEDULE_CONFLICT }] });
      expect(loop("weekly-bills")).toMatchObject({ revision: 2, schedule: { time: "09:15", weekdays: [1] } });
    });

    it("cannot switch a workflow on, enable an opt-in one, or move Morning priorities' agency clock", async () => {
      const { settings, loop } = await stores();
      const cards = await start(settings, async () => true);
      const propose = (values: unknown) => call("workflow_settings_propose", { target: "loop_schedule", values, reason: "x" });
      expect(await propose({ loopId: "maintenance-review", schedule: { enabled: true } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("schedule takes time, weekdays") }] });
      expect(await propose({ loopId: "maintenance-review", schedule: { time: "09:00" }, enabled: true })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("loopId and schedule") }] });
      expect(await propose({ loopId: "inbound-triage", schedule: { time: "06:00" } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("agency setup") }] });
      expect(await propose({ loopId: "morning-arrears", schedule: { intervalDays: 2, anchorDate: "2026-10-07" } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("schedule takes time, weekdays.") }] });
      expect(await propose({ loopId: "weekly-bills", schedule: { time: "8am" } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("HH:MM") }] });
      expect(await propose({ loopId: "weekly-bills", schedule: { intervalDays: 40, anchorDate: "2026-10-05" } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("1–31") }] });
      expect(await propose({ loopId: "no-such-workflow", schedule: { time: "09:00" } })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("loopId") }] });
      expect(await call("workflow_settings_restore", { target: "loop_schedule", reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("not kept") }] });
      expect(cards).toEqual([]);
      expect(loop("inbound-triage")).toMatchObject({ revision: 1, enabled: false, schedule: { time: "07:30" } });
      // An opt-in workflow's time changes; it stays off and opt-in.
      expect((await propose({ loopId: "maintenance-review", schedule: { time: "09:00" } })).isError).toBeUndefined();
      expect(loop("maintenance-review")).toMatchObject({ revision: 2, enabled: false, nextRunAt: null, schedule: { time: "09:00" } });
      // Where Schedule lets the every-N-days cadence change, Bud can propose it too.
      expect((await propose({ loopId: "bank-references", schedule: { intervalDays: 3 } })).isError).toBeUndefined();
      expect(cards.at(-1)).toContain("Bank reference review: Every 2 days from 2 Oct 2026, 8:00 am → Every 3 days from 2 Oct 2026, 8:00 am");
      expect(loop("bank-references")).toMatchObject({ enabled: false, schedule: { intervalDays: 3, anchorDate: "2026-10-02" } });
    });

    it("keeps a job waiting for plan approval waiting", async () => {
      const job = { id: "fictional-job", title: "Fictional Friday check", status: "shadow" as const, schedule: { time: "16:00", weekdays: [5] }, planApprovedAt: null, revision: 1, approvedRevision: null };
      const { settings, loop } = await stores(() => [job]);
      const cards = await start(settings, async () => true);
      expect((await call("workflow_settings_propose", { target: "loop_schedule", values: { loopId: "recipe-fictional-job", schedule: { time: "15:00" } }, reason: "Earlier." })).isError).toBeUndefined();
      expect(cards[0]).toBe("Change workflow schedule\nFictional Friday check: Fridays 4:00 pm → Fridays 3:00 pm\nIt still waits for its plan to be approved, and approving the plan uses the plan's own time.\nWhy: Earlier.");
      expect(loop("recipe-fictional-job")).toMatchObject({ waitingForPlan: true, enabled: false, nextRunAt: null, schedule: { time: "15:00", weekdays: [5] } });
    });
  });
});

describe("approval settings (approval_policy)", () => {
  let broker: LoopbackToolServer | undefined;
  afterEach(async () => { broker?.close(); broker = undefined; await cleanUp(); });
  const call = async (name: string, args: unknown) => ((await (await fetch(broker!.descriptor.url, { method: "POST",
    headers: { "content-type": "application/json", ...Object.fromEntries(broker!.descriptor.headers.map(row => [row.name, row.value])) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()) as any).result;
  /** A single desktop's real store, bound the way the host binds it. */
  async function desktop(approve: (summary: string) => Promise<boolean> | boolean = () => true) {
    const directory = privateTempRoot(join(tmpdir(), "realbud-bud-approvals-")); directories.push(directory);
    const store = createApprovalSettings({ dataDir: directory, seatIdentity: async () => null, company: async () => ({ status: 503, body: null }) });
    const { settings } = await stores(undefined, bindApprovalPolicy(store, () => ({ headers: {} })));
    const cards: string[] = [];
    broker = await startWorkflowSettingsBroker({ turnId: () => "turn-1", settings: () => settings, approve: async summary => { cards.push(summary); return approve(summary); } });
    const saved = async () => (await store.handle("/api/approvals", "GET", { headers: {} }, new URLSearchParams())).body as { local: { revision: number; settings: ApprovalSettings } };
    const put = async (groups: ApprovalSettings["groups"]) => store.handle("/api/approvals", "PUT", { headers: {} }, new URLSearchParams(),
      { expectedRevision: (await saved()).local.revision, settings: { ...defaultApprovalSettings(), groups } });
    return { cards, saved, put };
  }
  const propose = (changes: unknown, extra: Record<string, unknown> = {}) => call("workflow_settings_propose", { target: "approval_policy", values: { changes, ...extra }, reason: "Sherry wants to check these first." });

  it("reads the settings with no card and saves a stricter change only on Allow", async () => {
    let allow = false;
    const { cards, saved } = await desktop(() => allow);
    const read = await call("workflow_settings_read", { target: "approval_policy" });
    expect(read.content[0].text).toContain('- approval_policy this computer "This computer" (revision 0, you can change it): nothing saved');
    expect(cards).toEqual([]);
    const stricter = [{ group: "app:gmail", choice: "ask" }, { group: "class:pay", choice: "deny" }];
    expect(await propose(stricter)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("did not approve") }] });
    expect(cards[0]).toBe("Change approval settings\nGmail: Recommended → Ask every time\nAlways asks: Payments: Recommended → Don't use\nWhy: Sherry wants to check these first.");
    expect((await saved()).local.revision).toBe(0);
    allow = true;
    expect((await propose(stricter)).isError).toBeUndefined();
    expect((await saved()).local).toMatchObject({ revision: 1, settings: { groups: { "app:gmail": "ask", "class:pay": "deny" } } });
  });

  it("refuses group-level widening, widening a write, lifting Don't use and reviewedReads changes before any card", async () => {
    const { cards, saved, put } = await desktop();
    await put({ "app:gmail": "ask", "site:portal.fictional.test": "deny", "class:send": "deny" });
    const refused = async (changes: unknown, text: string, extra?: Record<string, unknown>) =>
      expect(await propose(changes, extra)).toMatchObject({ isError: true, content: [{ text: expect.stringContaining(text) }] });
    // A saved choice covers the whole row, so Bud never widens an app: the row would cover more than the tools it named.
    await refused([{ group: "app:gmail", choice: "read-without-asking" }], "Bud can only make Gmail stricter");
    await refused([{ group: "app:gmail", choice: "read-without-asking", tools: ["GMAIL_FETCH_EMAILS"] }], "Bud can only make Gmail stricter");
    await refused([{ group: "site:other.fictional.test", choice: "read-without-asking", tools: ["browser_click"] }], "name browser_read and browser_navigate");
    await refused([{ group: "site:portal.fictional.test", choice: "ask" }], "set to Don't use");
    await refused([{ group: "class:send", choice: "ask" }], "set to Don't use");
    await refused([{ group: "class:pay", choice: "read-without-asking", tools: ["GMAIL_FETCH_EMAILS"] }], "only make Always asks: Payments stricter");
    await refused([{ group: "connector:fictional-crm", choice: "read-without-asking", tools: ["list_contacts"] }], "only make Office connector fictional-crm stricter");
    await refused([{ group: "app:gmail", choice: "deny", tools: ["GMAIL_FETCH_EMAILS"] }], "tools only name");
    await refused([{ group: "app:gmail", choice: "ask" }], "already has those approval settings");
    await refused([{ group: "everything", choice: "deny" }], "Choose each group");
    await refused([{ group: "app:gmail", choice: "deny" }], "Only the owner marks", { reviewedReads: ["GMAIL_FETCH_EMAILS"] });
    expect(await call("workflow_settings_restore", { target: "approval_policy", reason: "x" })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Propose the settings you want") }] });
    expect(cards).toEqual([]);
    expect((await saved()).local.revision).toBe(1);
  });

  it("widens only a website's reading, after a card that states the whole effect", async () => {
    const { cards, saved, put } = await desktop();
    await put({ "app:gmail": "ask", "site:portal.fictional.test": "ask" });
    expect((await propose([{ group: "site:portal.fictional.test", choice: "read-without-asking", tools: ["browser_read", "browser_navigate"] }])).isError).toBeUndefined();
    expect(cards[0]).toBe("Change approval settings\nportal.fictional.test: Ask every time → Read without asking (reading pages and moving between them; filling, uploading and submitting still ask)\n" +
      "Why: Sherry wants to check these first.");
    expect((await saved()).local.settings.groups).toEqual({ "app:gmail": "ask", "site:portal.fictional.test": "read-without-asking" });
    expect((await propose([{ group: "site:portal.fictional.test", choice: "read-without-asking", tools: ["browser_click"] }]))).toMatchObject({ isError: true });
  });

  it("reports a conflict when the settings changed while the card was open", async () => {
    let put: Awaited<ReturnType<typeof desktop>>["put"] | undefined;
    const env = await desktop(async () => { await put!({ "app:outlook": "deny" }); return true; });
    put = env.put;
    expect(await propose([{ group: "app:gmail", choice: "ask" }])).toMatchObject({ isError: true, content: [{ text: APPROVAL_POLICY_CONFLICT }] });
    expect((await env.saved()).local.settings.groups).toEqual({ "app:outlook": "deny" });
  });

  it("needs edit rights: a read-only member is refused before the card, and the store refuses a save without them", async () => {
    const member = { headers: { "x-realbud-member-session": "synthetic-member-session" } };
    const departmentId = "00000000-0000-4000-8000-0000000000a1";
    let canEdit = false;
    const directory = privateTempRoot(join(tmpdir(), "realbud-bud-approvals-office-")); directories.push(directory);
    const store = createApprovalSettings({ dataDir: directory, seatIdentity: async () => "fictional-member-0001", company: async (path, request) => {
      if (request.headers["x-realbud-member-session"] !== "synthetic-member-session") return { status: 401, body: {} };
      const departments = [{ id: departmentId, name: "Accounts", canEdit, governs: true, revision: "0", settings: defaultApprovalSettings() }];
      if (path === "/api/company/approvals/mine") return { status: 200, body: { member: { id: "fictional-member-0001", displayName: "Fictional Sam", role: "member" }, departments } };
      return canEdit ? { status: 200, body: { revision: "1" } } : { status: 403, body: {} };
    } });
    const { settings } = await stores(undefined, bindApprovalPolicy(store, () => member));
    const approve = vi.fn(async () => { canEdit = false; return true; });
    broker = await startWorkflowSettingsBroker({ turnId: () => "turn-1", settings: () => settings, approve });
    expect(await propose([{ group: "app:gmail", choice: "deny" }], { departmentId })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Only people who can edit Accounts") }] });
    expect(await propose([{ group: "app:gmail", choice: "deny" }])).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Only people who can edit the departments") }] });
    expect(approve).not.toHaveBeenCalled();
    // Rights lost while the card was open: the store's own check refuses the save.
    canEdit = true;
    expect(await propose([{ group: "app:gmail", choice: "deny" }], { departmentId })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Only people who can edit Accounts") }] });
    expect(approve).toHaveBeenCalledOnce();
  });

  it("says so when the conversation has no approval settings bound", async () => {
    const { settings } = await stores();
    broker = await startWorkflowSettingsBroker({ turnId: () => "turn-1", settings: () => settings, approve: async () => true });
    expect((await call("workflow_settings_read", {})).content[0].text).toContain("- approval_policy: not available in this conversation.");
    expect(await propose([{ group: "app:gmail", choice: "deny" }])).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("Workspace → Approvals") }] });
  });
});

describe("working rules mount in an ACP turn", () => {
  const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
  let instance: ProviderInstance | undefined, recorder: EventRecorder | undefined, scratch = "";
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE; delete process.env.FAKE_ACP_DUMP;
    recorder?.stop(); await instance?.dispose();
    if (scratch) await removeFixture(scratch);
    await cleanUp();
  });

  it("mounts the tools for the current turn and shows RealBud's card before a change", async () => {
    delete process.env.NODE_V8_COVERAGE;
    ensureDirs(); chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-acp-settings-"));
    process.env.FAKE_ACP_DUMP = join(scratch, "mount.json"); process.env.FAKE_ACP_MODE = "hang";
    instance = await HermesAgentDriver.create({ instanceId: "acp-settings", displayName: "ACP Settings", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    const { settings, inspection } = await stores();
    await instance.adapter.sendTurn({ threadId: "t-settings", text: "four-monthly", integrations: { workflowSettings: settings } });
    const dump = () => JSON.parse(readFileSync(join(scratch, "mount.json"), "utf8"));
    await vi.waitFor(() => expect(dump().promptCount).toBe(1));
    const descriptor = dump().mcpServers.find((row: any) => row.name === "workflow-settings");
    expect(descriptor).toEqual({ type: "http", name: "workflow-settings", url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
      headers: [{ name: "authorization", value: expect.stringMatching(/^Bearer [a-f0-9]{64}$/) }] });
    const post = (id: number, name: string, args: unknown) => fetch(descriptor.url, { method: "POST", headers: Object.fromEntries(descriptor.headers.map((row: any) => [row.name, row.value])),
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) }).then(r => r.json() as Promise<any>);
    expect((await post(1, "workflow_settings_read", { target: "inspection_rules" })).result.isError).toBeUndefined();
    expect(recorder.events.some(event => event.type === "request.opened")).toBe(false);
    const pending = post(2, "workflow_settings_propose", { target: "inspection_rules", values: { cycleMonths: 4 }, reason: "Four-monthly." });
    const opened = await recorder.until(event => event.type === "request.opened");
    expect(opened).toMatchObject({ summary: "Change inspection rules\nInspect every (months): 6 → 4\nWhy: Four-monthly." });
    expect((await inspection.read()).revision).toBe(0);
    // A session-wide grant never authorizes the change.
    await instance.adapter.respondToRequest("t-settings", opened.requestId!, { behavior: "allow", scope: "session" });
    expect((await pending).result.isError).toBe(true);
    expect((await inspection.read()).revision).toBe(0);
    const again = post(3, "workflow_settings_propose", { target: "inspection_rules", values: { cycleMonths: 4 }, reason: "Four-monthly." });
    const second = await recorder.until(event => event.type === "request.opened" && event.requestId !== opened.requestId);
    await instance.adapter.respondToRequest("t-settings", second.requestId!, { behavior: "allow", scope: "once" });
    expect((await again).result.isError).toBeUndefined();
    expect((await inspection.read()).rules.cycleMonths).toBe(4);
    await instance.adapter.interruptTurn("t-settings");
  });
});
