// Bud's working-rules tools: a read with no card, every change and restore behind
// the one-time card, the stores' revision checks, and kept earlier versions.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
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
import type { LoopbackToolServer } from "./web-research-broker.ts";
import { bindWorkflowSettings, clockLabel, dateRanges, friendly, SETTINGS_CONFLICT, startWorkflowSettingsBroker, type BudWorkflowSettings } from "./workflow-settings-broker.ts";

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock("./managed-service.ts", () => ({ managedService: { assertCapability } }));

const directories: string[] = [];
async function stores() {
  const directory = await mkdtemp(join(tmpdir(), "realbud-bud-settings-")); directories.push(directory);
  const maintenance = createMaintenanceReviewStore({ file: join(directory, "maintenance-review.json"), now: () => 5_000 });
  const inspection = createInspectionRulesStore({ file: join(directory, "inspection-rules.json"), now: () => 5_000 });
  const agencyService = createAgencySetupService({ directory, workspaceId: randomUUID(), actorId: () => "fictional-actor", now: () => 5_000 });
  const agencySaves = vi.fn(async (body: Parameters<typeof agencyService.save>[0]) => { await agencyService.save(body); });
  let refusal: string | null = null;
  const settings: BudWorkflowSettings = bindWorkflowSettings({ maintenance, inspection, agency: { read: agencyService.getConfiguration, save: agencySaves }, writable: () => refusal });
  return { maintenance, inspection, agencyService, agencySaves, settings, refuse: (value: string | null) => { refusal = value; } };
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
});

describe("working rules broker", () => {
  let broker: LoopbackToolServer | undefined;
  afterEach(async () => { broker?.close(); broker = undefined; await Promise.all(directories.splice(0).map(path => removeFixture(path))); });
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
});

describe("working rules mount in an ACP turn", () => {
  const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
  let instance: ProviderInstance | undefined, recorder: EventRecorder | undefined, scratch = "";
  afterEach(async () => {
    delete process.env.FAKE_ACP_MODE; delete process.env.FAKE_ACP_DUMP;
    recorder?.stop(); await instance?.dispose();
    if (scratch) await removeFixture(scratch);
    await Promise.all(directories.splice(0).map(path => removeFixture(path)));
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
