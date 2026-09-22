import { describe, expect, it } from "vitest";

import {
  SETUP_STEP_COUNT,
  budStatusLine,
  currentSetupStep,
  readAgencySetupFacts,
  setupSequence,
  setupSequenceComplete,
  type AgencySetupFacts,
  type AgencySetupWorkflowFacts,
  WORKFLOW_LOOP_IDS,
  type ScheduleLoopFacts,
  type SetupSequenceInput,
  type SetupStepId,
} from "./setup-sequence";

const check = (id: string, state: "passed" | "needed" | "unknown", detail = `${id} detail from the host`) => ({
  id,
  label: `${id} check`,
  state,
  detail,
});

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

const base: SetupSequenceInput = { agencySetup: undefined };
const stateOf = (input: SetupSequenceInput, id: SetupStepId) => setupSequence(input).find((step) => step.id === id)?.state;
const onlyOneCurrent = (input: SetupSequenceInput) => {
  const steps = setupSequence(input);
  expect(steps).toHaveLength(SETUP_STEP_COUNT);
  expect(steps.map((step) => step.number)).toEqual([1, 2, 3]);
  expect(steps.filter((step) => step.state === "current")).toHaveLength(1);
  // One screen action per step, each on a door that can actually take it.
  expect(steps.map((step) => step.target)).toEqual(["schedule-packs", "you-connected-apps", "schedule-packs"]);
  for (const step of steps) expect(step.actionLabel.length).toBeGreaterThan(0);
  // Nothing may claim done without a host fact saying so.
  for (const step of steps) if (step.state === "done") expect(step.status).not.toMatch(/Not checked yet/);
  return steps;
};

describe("the three-step workspace setup", () => {
  it("starts a fresh install at step 1 with every later step unresolved", () => {
    const steps = onlyOneCurrent(base);
    expect(currentSetupStep(steps)).toMatchObject({ number: 1, id: "agency", title: "Your agency", actionLabel: "Open Agency workflow setup" });
    expect(steps.some((step) => step.state === "done")).toBe(false);
    // The agency-setup read has not answered, so its steps are unknown, never later-but-fine.
    expect(steps.filter((step) => step.state === "unknown").map((step) => step.id)).toEqual(["accounts", "approve"]);
    expect(setupSequenceComplete(steps)).toBe(false);
  });

  it("holds step 1 until the name, timezone and pack are all saved on the one form", () => {
    const missing = { ...base, agencySetup: facts({ agencyName: "", timeZone: "", packSelected: false }) };
    expect(setupSequence(missing)[0].status).toBe("Still to save on this one form: an agency name, a timezone, a workflow pack. Nothing is chosen for you.");
    expect(stateOf({ ...missing, agencySetup: facts({ timeZone: "" }) }, "agency")).toBe("current");
    expect(setupSequence({ ...missing, agencySetup: facts({ timeZone: "" }) })[0].status).toBe("Still to save on this one form: a timezone. Nothing is chosen for you.");
    expect(stateOf({ ...missing, agencySetup: facts({ packSelected: false }) }, "agency")).toBe("current");
  });

  it("takes the agency name from either surface and never demands both", () => {
    // Named on the agency form only.
    const onForm = onlyOneCurrent({ agencySetup: facts() });
    expect(onForm[0].state).toBe("done");
    expect(onForm[0].status).toMatch(/^Harbour Agency · Australia\/Brisbane · a workflow pack is selected\./);
    // Named on You only, with the form's own name still empty.
    const onYou = onlyOneCurrent({ officeAgencyName: "Harbour Agency", agencySetup: facts({ agencyName: "" }) });
    expect(onYou[0].state).toBe("done");
    expect(onYou[0].status).toMatch(/^Harbour Agency · /);
  });

  it("moves to the accounts step and shows the host's own check sentence", () => {
    const steps = onlyOneCurrent({ agencySetup: facts() });
    expect(currentSetupStep(steps)).toMatchObject({
      number: 2,
      id: "accounts",
      title: "Connect your accounts",
      why: "Connect the accounts your work reads, then check each one.",
      target: "you-connected-apps",
      actionLabel: "Open Connections",
    });
    expect(steps[1].status).toBe("gmail detail from the host");
  });

  it("reads the account check across every workflow that reports one before work is ticked", () => {
    const unticked: SetupSequenceInput = {
      agencySetup: facts({
        workflows: [
          bank({ selected: false, checks: [check("mapping", "needed")] }),
          bank({ id: "morning-priorities", title: "Morning priorities", selected: false, checks: [check("gmail", "needed", "Choose an account and verify its current private read access.")] }),
        ],
      }),
    };
    const steps = onlyOneCurrent(unticked);
    expect(currentSetupStep(steps)).toMatchObject({ id: "accounts" });
    expect(steps[1].status).toBe("Choose an account and verify its current private read access.");
  });

  it("is done on the host's verified account and renders whatever detail the host sent", () => {
    const collecting = "Read access to this private account was verified and history collection has started.";
    const steps = onlyOneCurrent({
      agencySetup: facts({ workflows: [bank({ checks: [check("gmail", "passed", collecting), check("mapping", "needed")] })] }),
    });
    expect(steps[1].state).toBe("done");
    expect(steps[1].status).toBe(collecting);
    expect(currentSetupStep(steps)).toMatchObject({ number: 3, id: "approve" });
  });

  it("never reads an unreported account check as done", () => {
    const steps = onlyOneCurrent({
      agencySetup: facts({ workflows: [bank({ checks: [check("gmail", "unknown", "The host has not reported this account.")] })] }),
    });
    expect(currentSetupStep(steps)).toMatchObject({ id: "accounts" });
    expect(steps[1].state).not.toBe("done");
    expect(steps[1].status).toBe("Not checked yet. The host has not reported this account.");
  });

  it("needs no connected account when the selected work requires none", () => {
    // Bank references is the one workflow the host reports no account check for.
    const steps = onlyOneCurrent({
      agencySetup: facts({ workflows: [bank({ checks: [check("mapping", "passed")] })] }),
    });
    expect(steps[1].state).toBe("done");
    expect(steps[1].status).toBe("No connected account is needed for the work you chose.");
  });
});

describe("step 3 covers references, approval and the schedule switch", () => {
  const ready = (fields: Partial<AgencySetupWorkflowFacts> = {}) =>
    bank({ checks: [check("gmail", "passed"), check("mapping", "passed")], ...fields });
  const step3 = (input: SetupSequenceInput) => setupSequence(input)[2];

  it("asks for a workflow choice before anything else in this step", () => {
    const steps = onlyOneCurrent({ agencySetup: facts({ workflows: [bank({ selected: false, checks: [check("gmail", "passed")] })] }) });
    expect(currentSetupStep(steps)).toMatchObject({ number: 3, id: "approve" });
    expect(steps[2].status).toMatch(/No work is selected yet/);
  });

  it("shows the property reference need inside this step, for bank work only", () => {
    const needed = step3({ agencySetup: facts({ workflows: [ready({ checks: [check("gmail", "passed"), check("mapping", "needed", "Add a reviewed reference for each property in the selected bank scope.")] })] }) });
    expect(needed.state).toBe("current");
    expect(needed.status).toBe("Add a reviewed reference for each property in the selected bank scope.");
    const mailOnly = step3({ agencySetup: facts({ workflows: [bank({ id: "morning-priorities", title: "Morning priorities", checks: [check("gmail", "passed")] })] }) });
    expect(mailOnly.status).toMatch(/Still to approve: Morning priorities/);
  });

  it("holds the step until every selected workflow is approved with current checks", () => {
    expect(step3({ agencySetup: facts({ workflows: [ready()] }) }).status).toMatch(/Still to approve/);
    expect(step3({ agencySetup: facts({ workflows: [ready({ reviewed: true })] }) }).status).toMatch(/current checks are not passing/);
  });

  const approved: SetupSequenceInput = {
    agencySetup: facts({
      workflows: [ready({ id: "morning-priorities", title: "Morning priorities", checks: [check("gmail", "passed")], reviewed: true, readyForRun: true })],
    }),
  };
  const loop = (fields: Partial<ScheduleLoopFacts> = {}): ScheduleLoopFacts => ({ id: "inbound-triage", available: true, enabled: true, nextRunAt: 1_700_000_000_000, ...fields });

  it("binds morning priorities to the inbound-triage loop", () => {
    expect(WORKFLOW_LOOP_IDS["morning-priorities"]).toBe("inbound-triage");
  });

  it("is done only when the loop is enabled and its next run is recorded", () => {
    const on = setupSequence({ ...approved, schedule: { read: "ready", loops: [loop()] } });
    expect(on[2].state).toBe("done");
    expect(on[2].status).toMatch(/On with a next run recorded for Morning priorities/);
    expect(on[2].actionLabel).toBe("Open Schedule");
    expect(setupSequenceComplete(on)).toBe(true);
    expect(currentSetupStep(on)).toBeNull();
  });

  it("is current, not done, when the loop is on but has no next run", () => {
    const stalled = step3({ ...approved, schedule: { read: "ready", loops: [loop({ nextRunAt: null })] } });
    expect(stalled.state).toBe("current");
    expect(stalled.status).toMatch(/Off for Morning priorities\. Enabling is a separate action on Schedule\./);
    expect(step3({ ...approved, schedule: { read: "ready", loops: [loop({ enabled: false })] } }).state).toBe("current");
    expect(step3({ ...approved, schedule: { read: "ready", loops: [loop({ available: false })] } }).state).toBe("current");
  });

  it("reads an unfinished, failed or unreported loops read as not checked yet", () => {
    for (const schedule of [undefined, { read: "loading" as const }, { read: "error" as const }]) {
      const step = step3({ ...approved, schedule });
      expect(step.state).toBe("current");
      expect(step.status).toMatch(/^Not checked yet\. Enabling is a separate action on Schedule\.$/);
      expect(step.actionLabel).toBe("Open Schedule");
    }
    const missing = step3({ ...approved, schedule: { read: "ready", loops: [] } });
    expect(missing.state).toBe("current");
    expect(missing.status).toMatch(/No scheduled loop is reported for Morning priorities/);
  });

  it("does not map a workflow with no loop of its own onto an unrelated book loop", () => {
    const banked: SetupSequenceInput = {
      agencySetup: facts({ workflows: [ready({ reviewed: true, readyForRun: true })] }),
      schedule: { read: "ready", loops: [loop(), loop({ id: "morning-arrears" })] },
    };
    expect(WORKFLOW_LOOP_IDS["bank-references"]).toBeNull();
    const step = step3(banked);
    expect(step.state).toBe("current");
    expect(step.status).toMatch(/No scheduled loop is reported for Bank references/);
  });

  it("never lets an unreadable setup read as done", () => {
    for (const agencySetup of [undefined, "unavailable" as const]) {
      const steps = onlyOneCurrent({ officeAgencyName: "Harbour Agency", agencySetup });
      expect(currentSetupStep(steps)).toMatchObject({ number: 1, id: "agency" });
      for (const step of steps) expect(step.state).not.toBe("done");
      expect(setupSequenceComplete(steps)).toBe(false);
    }
    expect(setupSequence({ ...base, agencySetup: "unavailable" })[0].status).toMatch(/could not be read/);
    expect(setupSequence(base)[0].status).toMatch(/Reading workflow setup/);
  });
});

describe("Bud is a status line, not a step", () => {
  it("never appears among the three steps", () => {
    expect(setupSequence(base).map((step) => step.id)).toEqual(["agency", "accounts", "approve"]);
  });

  it("says what the host reports about Bud and nothing more", () => {
    expect(budStatusLine(true)).toBe("Bud: ready");
    expect(budStatusLine(false)).toBe("Bud: needs setup on You");
    expect(budStatusLine("unknown")).toBe("Bud: not checked yet");
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
    // A check with no sentence from the host is not a fact this path may render.
    expect(readAgencySetupFacts({ ...body, workflows: [{ ...body.workflows[0], checks: [{ id: "gmail", label: "Gmail", state: "passed" }] }] })).toBe("unavailable");
    expect(readAgencySetupFacts({ ...body, state: { settings: { agencyName: 1, timeZone: "UTC", workflowPackId: null } } })).toBe("unavailable");
    expect(readAgencySetupFacts({ ...body, state: { settings: { agencyName: "Harbour", workflowPackId: null } } })).toBe("unavailable");
  });

  it("reads an unselected pack and an unsaved timezone without inventing either", () => {
    const partial = readAgencySetupFacts({ ...body, state: { settings: { agencyName: "Harbour", timeZone: "", workflowPackId: null } } });
    expect(partial).toMatchObject({ packSelected: false, timeZone: "" });
  });
});
