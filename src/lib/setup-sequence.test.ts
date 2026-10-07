import { describe, expect, it } from "vitest";

import type { AustinChecklistItem, AustinPackView } from "../../shared/austin-pack";
import {
  SETUP_STEP_COUNT,
  currentSetupStep,
  officeAppsToConnect,
  readAgencySetupFacts,
  readWebsiteLinkState,
  setupSequence,
  setupSequenceComplete,
  sharedGmailNotAllowed,
  type AgencySetupFacts,
  type AgencySetupWorkflowFacts,
  WORKFLOW_LOOP_IDS,
  type ScheduleLoopFacts,
  type SetupSequenceInput,
  type SetupStepId,
} from "./setup-sequence";

const check = (id: string, state: "passed" | "needed" | "unknown", detail = `${id} detail from the host`) => ({ id, label: `${id} check`, state, detail });

const bank = (fields: Partial<AgencySetupWorkflowFacts> = {}): AgencySetupWorkflowFacts => ({
  id: "bank-references",
  title: "Bank references and reconciliation handoff",
  selected: true,
  reviewed: false,
  readyForRun: false,
  checks: [check("agency", "passed"), check("pack", "passed"), check("gmail", "needed"), check("mapping", "needed"), check("execution", "needed")],
  ...fields,
});

const facts = (fields: Partial<AgencySetupFacts> = {}): AgencySetupFacts => ({
  agencyName: "Harbour Agency",
  timeZone: "Australia/Brisbane",
  packSelected: true,
  workflows: [bank()],
  ...fields,
});

const plan = { reads: "r", waitsFor: "w", notifies: "n", approval: "a" };
/** A fictional role pack with three workflows, installed on this computer. */
const pack = (done: Partial<Record<AustinChecklistItem["id"], boolean>> = {}, installed = true): AustinPackView => ({
  pack: { id: "fictional-pack", revision: 1, title: "Fictional Accounts pack" },
  timeZone: "Australia/Brisbane",
  timeZoneFromOffice: true,
  installed: installed ? { revision: 1, at: 1, loopIds: ["bank-references", "inbound-triage", "maintenance-review"] } : null,
  loops: ["bank-references", "inbound-triage", "maintenance-review"].map((loopId) => ({ loopId, owner: "Accounts", plan, needs: [] })),
  rules: [],
  checklist: [
    { id: "gmail", label: "Gmail connected", done: Boolean(done.gmail), detail: "Gmail detail" },
    { id: "workflows", label: "Each workflow reviewed and switched on", done: Boolean(done.workflows), detail: "1 of 3 on. Open each one.", ...(done.workflows ? {} : { next: "inbound-triage" }) },
  ],
});
const loop = (fields: Partial<ScheduleLoopFacts> = {}): ScheduleLoopFacts => ({ id: "inbound-triage", available: true, enabled: true, nextRunAt: 1_700_000_000_000, ...fields });
const loopsOn = (on: readonly string[]) => ({
  read: "ready" as const,
  loops: [
    loop({ id: "bank-references", name: "Bank reference review", enabled: on.includes("bank-references") }),
    loop({ id: "inbound-triage", name: "Morning priorities", enabled: on.includes("inbound-triage") }),
    loop({ id: "maintenance-review", name: "Maintenance checks", enabled: on.includes("maintenance-review") }),
  ],
});

const ready = { ready: true, working: false, detail: null };
const installing = { ready: false, working: true, detail: null };
const base: SetupSequenceInput = { agencySetup: undefined };
const step = (input: SetupSequenceInput, id: SetupStepId) => setupSequence(input).find((item) => item.id === id)!;
const onlyOneCurrent = (input: SetupSequenceInput) => {
  const steps = setupSequence(input);
  expect(steps).toHaveLength(SETUP_STEP_COUNT);
  expect(steps.map((item) => item.number)).toEqual([1, 2, 3, 4, 5]);
  expect(steps.filter((item) => item.state === "current").length).toBeLessThanOrEqual(1);
  for (const item of steps) expect(item.actionLabel.length).toBeGreaterThan(0);
  // Nothing may claim done without a host fact saying so.
  for (const item of steps) if (item.state === "done") expect(item.status).not.toMatch(/Not checked yet/);
  return steps;
};

describe("Get started: five steps in Kevin's order", () => {
  it("starts a fresh install at step 1 with nothing done and unread steps not checked yet", () => {
    const steps = onlyOneCurrent(base);
    expect(steps.map((item) => item.id)).toEqual(["link", "bud", "pack", "gmail", "workflows"]);
    expect(currentSetupStep(steps)).toMatchObject({ number: 1, id: "link", target: "you-website", actionLabel: "Enter link code" });
    expect(steps.some((item) => item.state === "done")).toBe(false);
    expect(steps.filter((item) => item.state === "unknown").map((item) => item.id)).toEqual(["bud", "pack", "gmail", "workflows"]);
    for (const item of steps.slice(1)) expect(item.status).toMatch(/^Not checked yet\. /);
    expect(setupSequenceComplete(steps)).toBe(false);
  });

  it("ticks step 1 only on a host-reported link", () => {
    expect(step({ ...base, websiteLink: "linked" }, "link")).toMatchObject({ state: "done" });
    expect(step({ ...base, websiteLink: "not-linked" }, "link")).toMatchObject({ state: "current", status: "Your office owner sends this code. Ask them if you don’t have one yet." });
    expect(step({ ...base, websiteLink: undefined }, "link").status).toMatch(/Reading this computer’s office link/);
    expect(step({ ...base, websiteLink: "unavailable" }, "link").status).toMatch(/could not be read/);
  });

  it("reads the office-link status without guessing", () => {
    expect(readWebsiteLinkState({ state: "linked" })).toBe("linked");
    for (const state of ["unlinked", "pending", "revoked"]) expect(readWebsiteLinkState({ state })).toBe("not-linked");
    for (const body of [null, undefined, "linked", {}, { state: "approved" }]) expect(readWebsiteLinkState(body)).toBe("unavailable");
  });
});

describe("step 2: Bud sets itself up and blocks nothing", () => {
  const linked: SetupSequenceInput = { agencySetup: facts(), websiteLink: "linked", austinPack: pack() };

  it("shows as working while installing and lets the next open step be current", () => {
    const steps = onlyOneCurrent({ ...linked, bud: installing });
    expect(steps[1]).toMatchObject({ state: "working", actionLabel: "See progress", target: "bud-setup" });
    expect(steps[1].status).toBe("This usually takes about 10 minutes and you don’t need to do anything.");
    expect(currentSetupStep(steps)?.id).toBe("gmail");
  });

  it("ticks only on the server's ready, never on progress or a hold", () => {
    expect(step({ ...linked, bud: ready }, "bud")).toMatchObject({ state: "done", title: "Bud is set up" });
    expect(step({ ...linked, bud: installing }, "bud")).toMatchObject({ state: "working", title: "Bud is setting itself up" });
    const held = step({ ...linked, bud: { ready: false, working: false, detail: "Bud’s setup stopped before it finished." } }, "bud");
    expect(held).toMatchObject({ state: "later", status: "Bud’s setup stopped before it finished." });
    expect(step({ ...linked, bud: undefined }, "bud")).toMatchObject({ state: "unknown" });
    expect(step({ ...base, websiteLink: "not-linked", bud: { ready: false, working: false, detail: null } }, "bud").status).toBe("Starts by itself once this computer is connected.");
  });

  it("is never the current step", () => {
    for (const bud of [undefined, installing, { ready: false, working: false, detail: null }]) {
      expect(step({ ...base, bud }, "bud").state).not.toBe("current");
    }
  });
});

describe("step 3: the office's pack", () => {
  it("is done once the role pack is installed", () => {
    expect(step({ agencySetup: undefined, austinPack: pack() }, "pack")).toMatchObject({ state: "done", status: "Imported: Fictional Accounts pack." });
  });

  it("falls back to a saved agency setup for an office without a role pack", () => {
    expect(step({ agencySetup: facts(), austinPack: pack({}, false) }, "pack").state).toBe("done");
    // The name saved on You counts as much as the form's own.
    expect(step({ officeAgencyName: "Harbour Agency", agencySetup: facts({ agencyName: "" }), austinPack: "unavailable" }, "pack").state).toBe("done");
    // Name alone, or no pack, does not finish it.
    expect(step({ agencySetup: facts({ timeZone: "" }), austinPack: pack({}, false), websiteLink: "linked" }, "pack")).toMatchObject({ state: "current", actionLabel: "Open packs from your office", target: "schedule-packs" });
    expect(step({ agencySetup: facts({ packSelected: false }), austinPack: pack({}, false), websiteLink: "linked" }, "pack").state).toBe("current");
  });

  it("never reads unread packs as done", () => {
    for (const austinPack of [undefined, "unavailable" as const]) {
      const item = step({ agencySetup: facts({ packSelected: false }), austinPack, websiteLink: "linked" }, "pack");
      expect(item.state).not.toBe("done");
      expect(item.status).toMatch(/^Not checked yet\. /);
    }
  });
});

describe("step 4: the office Gmail", () => {
  const linked = { websiteLink: "linked" as const, agencySetup: facts() };

  it("reads the role pack's own Gmail check", () => {
    expect(step({ ...linked, austinPack: pack() }, "gmail")).toMatchObject({ state: "current", actionLabel: "Connect Gmail", target: "you-connected-apps", status: "Sign in to the office Gmail in your browser." });
    expect(step({ ...linked, austinPack: pack({ gmail: true }) }, "gmail").state).toBe("done");
    const noGmail = { ...pack(), checklist: pack().checklist.filter((item) => item.id !== "gmail") };
    expect(step({ ...linked, austinPack: noGmail }, "gmail")).toMatchObject({ state: "done", status: "No Gmail is needed for the work you chose." });
  });

  it("falls back to the agency Gmail check without a role pack", () => {
    const none = pack({}, false);
    expect(step({ ...linked, austinPack: none }, "gmail").status).toBe("Sign in to the office Gmail in your browser.");
    const verified = facts({ workflows: [bank({ checks: [check("gmail", "passed", "Verified."), check("mapping", "needed")] })] });
    expect(step({ ...linked, agencySetup: verified, austinPack: none }, "gmail")).toMatchObject({ state: "done" });
    expect(step({ ...linked, agencySetup: facts({ workflows: [bank({ checks: [check("gmail", "unknown", "Not reported.")] })] }), austinPack: none }, "gmail").status).toBe("Not checked yet. The office Gmail hasn’t been checked.");
    // An app the linked service offers with no account is named on the action.
    expect(step({ ...linked, agencySetup: verified, austinPack: none, appsToConnect: ["gmail"] }, "gmail")).toMatchObject({ state: "current", actionLabel: "Connect Gmail" });
    expect(step({ ...linked, agencySetup: "unavailable", austinPack: none }, "gmail").status).toMatch(/^Not checked yet\. /);
  });

  it("lists only fresh, managed, personal apps with no account as still to connect", () => {
    const now = new Date().toISOString();
    const offered = { configured: true, checkedAt: now, tools: { available: false, names: [] }, services: {
      gmail: { connected: false, status: "NOT_CONNECTED", accountSelectionRequired: false, accounts: [] },
    } };
    expect(officeAppsToConnect(offered, true)).toEqual(["gmail"]);
    expect(officeAppsToConnect(offered, false)).toEqual([]);
    expect(officeAppsToConnect({ ...offered, error: "unreachable" }, true)).toEqual([]);
    expect(officeAppsToConnect({ ...offered, sourceKind: "office_shared" }, true)).toEqual([]);
    expect(officeAppsToConnect({ ...offered, checkedAt: "2020-01-01T00:00:00.000Z" }, true)).toEqual([]);
    expect(officeAppsToConnect(null, true)).toEqual([]);
    const connected = { ...offered, services: { gmail: { connected: true, status: "ACTIVE", accountSelectionRequired: false, accounts: [{ id: "fictional-1", status: "ACTIVE" }] } } };
    expect(officeAppsToConnect(connected, true)).toEqual([]);
  });

  it("sends a computer the office hasn't allowed on its shared Gmail to the owner, not to a sign-in", () => {
    const shared = { configured: true, checkedAt: new Date().toISOString(), sourceKind: "office_shared" as const, tools: { available: false, names: [] }, services: {
      gmail: { connected: false, status: "NOT_CONNECTED", accountSelectionRequired: false, accounts: [] },
    } };
    expect(sharedGmailNotAllowed(shared, true)).toBe(true);
    expect(sharedGmailNotAllowed(shared, false)).toBe(false);
    expect(sharedGmailNotAllowed({ ...shared, sourceKind: "personal" }, true)).toBe(false);
    expect(sharedGmailNotAllowed({ ...shared, error: "unreachable" }, true)).toBe(false);
    expect(sharedGmailNotAllowed({ ...shared, checkedAt: "2020-01-01T00:00:00.000Z" }, true)).toBe(false);
    expect(sharedGmailNotAllowed({ ...shared, services: { gmail: { connected: true, status: "ACTIVE", accountSelectionRequired: false, accounts: [{ id: "fictional-1", status: "ACTIVE" }] } } }, true)).toBe(false);
    const ask = { state: "current", status: "Ask the office owner to allow this computer on realbud.app.", actionLabel: "Open connected apps", target: "you-connected-apps" };
    expect(step({ ...linked, austinPack: pack(), sharedGmailBlocked: true }, "gmail")).toMatchObject(ask);
    expect(step({ ...linked, austinPack: pack({}, false), sharedGmailBlocked: true }, "gmail")).toMatchObject(ask);
    expect(step({ ...linked, austinPack: pack({ gmail: true }), sharedGmailBlocked: true }, "gmail").state).toBe("done");
  });
});

describe("step 5: review and switch on the workflows", () => {
  const ahead: SetupSequenceInput = { websiteLink: "linked", agencySetup: facts(), austinPack: pack({ gmail: true }), bud: ready };

  it("counts the pack's workflows that are on and opens the next one that is off", () => {
    const item = step({ ...ahead, schedule: loopsOn(["bank-references"]) }, "workflows");
    expect(item).toMatchObject({ state: "current", actionLabel: "Review Morning priorities", target: "job-inbound-triage" });
    expect(item.status).toBe("1 of 3 on. Open each workflow, read what it does, then switch it on.");
    expect(step({ ...ahead, schedule: loopsOn(["bank-references", "inbound-triage"]) }, "workflows").status).toMatch(/^2 of 3 on\./);
  });

  describe("names what the next workflow still needs before it can switch on", () => {
    const kevin = (done: Partial<Record<AustinChecklistItem["id"], boolean>> = {}): AustinPackView => ({
      ...pack({ gmail: true }),
      loops: [["bank-references", ["redbark", "tenants", "rei"]], ["weekly-bills", ["gmail"]], ["inbound-triage", ["gmail"]]].map(([loopId, needs]) =>
        ({ loopId: loopId as string, owner: "Accounts", plan, needs: needs as AustinChecklistItem["id"][] })),
      checklist: [
        { id: "gmail", label: "Gmail", done: done.gmail ?? true, detail: "Connect the office Gmail in Connected apps." },
        { id: "redbark", label: "Redbark", done: Boolean(done.redbark), detail: "Connect Redbark in Connected apps, or add the ANZ CSV in the bank review each time." },
        { id: "rei", label: "REI", done: Boolean(done.rei), detail: "In Bank reference review, choose Refresh from REI and sign in on REI’s own page." },
        { id: "tenants", label: "Tenants", done: Boolean(done.tenants), detail: "In Bank reference review, choose Refresh from REI to save the tenant list." },
        { id: "workflows", label: "Workflows", done: false, detail: "0 of 3 on." },
      ],
    });
    const loops = (on: readonly string[]) => ({ read: "ready" as const, loops: [
      loop({ id: "bank-references", name: "Bank reference review", enabled: on.includes("bank-references") }),
      loop({ id: "weekly-bills", name: "Weekly bills review", enabled: on.includes("weekly-bills") }),
      loop({ id: "inbound-triage", name: "Morning priorities", enabled: on.includes("inbound-triage") }),
    ] });
    const agency = (ready: boolean) => facts({ workflows: [
      bank({ id: "bills-calendar", title: "Bills", readyForRun: ready, reviewed: ready }),
      bank({ id: "morning-priorities", title: "Morning priorities", readyForRun: true, reviewed: true }),
    ] });

    it("shows the first unmet need in checklist order, keeping the job as the action", () => {
      const item = step({ ...ahead, austinPack: kevin(), schedule: loops([]) }, "workflows");
      expect(item).toMatchObject({ state: "current", actionLabel: "Review Bank reference review", target: "job-bank-references" });
      expect(item.status).toBe("0 of 3 on. Before Bank reference review: Connect Redbark in Connected apps, or add the ANZ CSV in the bank review each time.");
      // REI sign-in comes before the tenant list it saves.
      expect(step({ ...ahead, austinPack: kevin({ redbark: true }), schedule: loops([]) }, "workflows").status).toMatch(/Before Bank reference review: In Bank reference review, choose Refresh from REI and sign in/);
      expect(step({ ...ahead, austinPack: kevin({ redbark: true, rei: true, tenants: true }), schedule: loops([]) }, "workflows").status).toBe("0 of 3 on. Open each workflow, read what it does, then switch it on.");
    });

    it("points weekly bills and morning priorities at Agency workflow setup until the host reports them ready", () => {
      const done = { redbark: true, rei: true, tenants: true };
      const held = step({ ...ahead, agencySetup: agency(false), austinPack: kevin(done), schedule: loops(["bank-references"]) }, "workflows");
      expect(held).toMatchObject({ state: "current", actionLabel: "Open Agency workflow setup", target: "schedule-agency" });
      expect(held.status).toBe("1 of 3 on. Before Weekly bills review can switch on, finish Agency workflow setup and approve it there.");
      // Ready: the job itself is the next action. Gmail stays step 4's, never named here.
      expect(step({ ...ahead, agencySetup: agency(true), austinPack: kevin(done), schedule: loops(["bank-references"]) }, "workflows")).toMatchObject({ actionLabel: "Review Weekly bills review", target: "job-weekly-bills" });
      expect(step({ ...ahead, agencySetup: agency(true), austinPack: kevin({ ...done, gmail: false }), schedule: loops(["bank-references"]) }, "workflows").status).toBe("1 of 3 on. Open each workflow, read what it does, then switch it on.");
      // An unread or unreported agency workflow is not a reason to hold.
      for (const agencySetup of [undefined, "unavailable" as const, facts()]) {
        expect(step({ ...ahead, agencySetup, austinPack: kevin(done), schedule: loops(["bank-references"]) }, "workflows").target).toBe("job-weekly-bills");
      }
    });
  });

  it("uses the pack's own checklist while the loops are unread", () => {
    expect(step({ ...ahead, schedule: { read: "loading" } }, "workflows")).toMatchObject({ state: "current", status: "1 of 3 on. Open each one.", target: "job-inbound-triage" });
  });

  it("hides the whole card only when every step, Bud included, is done", () => {
    const all = setupSequence({ ...ahead, schedule: loopsOn(["bank-references", "inbound-triage", "maintenance-review"]) });
    expect(all.map((item) => item.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(setupSequenceComplete(all)).toBe(true);
    expect(currentSetupStep(all)).toBeNull();
    const budStill = setupSequence({ ...ahead, bud: installing, schedule: loopsOn(["bank-references", "inbound-triage", "maintenance-review"]) });
    expect(setupSequenceComplete(budStill)).toBe(false);
  });

  describe("without a role pack: approval and the schedule switch", () => {
    const none = pack({}, false);
    const approved = (schedule?: SetupSequenceInput["schedule"]): SetupSequenceInput => ({
      websiteLink: "linked",
      austinPack: none,
      schedule,
      agencySetup: facts({ workflows: [bank({ id: "morning-priorities", title: "Morning priorities", checks: [check("gmail", "passed")], reviewed: true, readyForRun: true })] }),
    });

    it("asks for a choice, references and approval before the switch", () => {
      expect(step({ websiteLink: "linked", austinPack: none, agencySetup: facts({ workflows: [bank({ selected: false, checks: [check("gmail", "passed")] })] }) }, "workflows").status).toBe("Open each workflow, read what it does, then switch it on.");
      expect(step({ websiteLink: "linked", austinPack: none, agencySetup: facts({ workflows: [bank({ checks: [check("gmail", "passed"), check("mapping", "needed", "Add references.")] })] }) }, "workflows").status).toBe("Add references.");
      expect(step({ websiteLink: "linked", austinPack: none, agencySetup: facts({ workflows: [bank({ checks: [check("gmail", "passed"), check("mapping", "passed")] })] }) }, "workflows").status).toMatch(/Still to approve/);
    });

    it("binds morning priorities to the inbound-triage loop and is done only with a next run", () => {
      expect(WORKFLOW_LOOP_IDS["morning-priorities"]).toBe("inbound-triage");
      expect(WORKFLOW_LOOP_IDS["bank-references"]).toBeNull();
      expect(step(approved({ read: "ready", loops: [loop()] }), "workflows").state).toBe("done");
      expect(step(approved({ read: "ready", loops: [loop({ nextRunAt: null })] }), "workflows").status).toMatch(/Off for Morning priorities/);
      for (const schedule of [undefined, { read: "loading" as const }, { read: "error" as const }]) {
        expect(step(approved(schedule), "workflows")).toMatchObject({ state: "current", actionLabel: "Open Schedule" });
      }
      expect(step(approved({ read: "ready", loops: [] }), "workflows").status).toMatch(/No scheduled loop is reported/);
    });

    it("never lets an unreadable setup read as done", () => {
      for (const agencySetup of [undefined, "unavailable" as const]) {
        const steps = onlyOneCurrent({ websiteLink: "linked", officeAgencyName: "Harbour Agency", agencySetup, austinPack: none });
        for (const id of ["gmail", "workflows"] as const) expect(steps.find((item) => item.id === id)!.state).not.toBe("done");
      }
    });
  });
});

describe("agency setup validation", () => {
  const body = {
    state: { settings: { agencyName: "Harbour Agency", timeZone: "Australia/Brisbane", workflowPackId: "office-core" } },
    workflows: [{ id: "bank-references", title: "Bank references", selected: true, reviewed: true, readyForRun: true, checks: [{ id: "gmail", label: "Gmail", state: "passed", detail: "Verified" }] }],
  };

  it("accepts a well-formed body", () => {
    expect(readAgencySetupFacts(body)).toMatchObject({ agencyName: "Harbour Agency", timeZone: "Australia/Brisbane", packSelected: true });
  });

  it("rejects malformed, foreign or partial bodies instead of guessing", () => {
    expect(readAgencySetupFacts(null)).toBe("unavailable");
    expect(readAgencySetupFacts({ workflows: [] })).toBe("unavailable");
    expect(readAgencySetupFacts({ ...body, workflows: [{ ...body.workflows[0], id: "not-a-workflow" }] })).toBe("unavailable");
    expect(readAgencySetupFacts({ ...body, workflows: [{ ...body.workflows[0], readyForRun: "yes" }] })).toBe("unavailable");
    expect(readAgencySetupFacts({ ...body, workflows: [{ ...body.workflows[0], checks: [{ id: "gmail", label: "Gmail", state: "ok", detail: "" }] }] })).toBe("unavailable");
    expect(readAgencySetupFacts({ ...body, workflows: [{ ...body.workflows[0], checks: [{ id: "gmail", label: "Gmail", state: "passed" }] }] })).toBe("unavailable");
    expect(readAgencySetupFacts({ ...body, state: { settings: { agencyName: 1, timeZone: "UTC", workflowPackId: null } } })).toBe("unavailable");
    expect(readAgencySetupFacts({ ...body, state: { settings: { agencyName: "Harbour", workflowPackId: null } } })).toBe("unavailable");
  });

  it("reads an unselected pack and an unsaved timezone without inventing either", () => {
    const partial = readAgencySetupFacts({ ...body, state: { settings: { agencyName: "Harbour", timeZone: "", workflowPackId: null } } });
    expect(partial).toMatchObject({ packSelected: false, timeZone: "" });
  });
});
