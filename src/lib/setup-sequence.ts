// One ordered setup path for a nontechnical operator: three numbered steps, one
// current step, one screen action each, and every step's state read from the
// host's own facts.
//
// Nothing here guesses. When the `/api/agency-setup` read has not answered, was
// refused or came back malformed, the affected step reads "Not checked yet" and
// can never read as finished. No step claims a run happened or will succeed.
import { agencyIsNamed } from "./office-setup";
import { AGENCY_WORKFLOWS, AGENCY_WORKFLOW_NAMES, type AgencyWorkflowId } from "../../shared/agency-setup";

export const SETUP_STEP_COUNT = 3;

export type SetupStepId = "agency" | "accounts" | "approve";

/**
 * `done` is a host-confirmed fact. `current` is the one step to act on now.
 * `later` is a readable step that is not this step's turn. `unknown` is a step
 * whose fact could not be read; it is never treated as done.
 */
export type SetupStepState = "done" | "current" | "later" | "unknown";

/**
 * Where this step's single action goes: the agency setup card on Schedule,
 * Connections on You, where accounts are actually connected, or the office
 * section on You, where this computer is linked with its RealBud account.
 */
export type SetupJumpTarget = "schedule-packs" | "you-connected-apps" | "you-office";

export interface SetupStep {
  id: SetupStepId;
  /** 1-based position in the fixed three-step path. */
  number: number;
  title: string;
  /** One sentence saying why this step exists. */
  why: string;
  state: SetupStepState;
  /** What the host currently reports about this step. */
  status: string;
  target: SetupJumpTarget;
  /** The accessible name of this step's single action control. */
  actionLabel: string;
}

/** A single readiness check as `/api/agency-setup` reports it. */
export interface AgencySetupCheckFacts {
  id: string;
  label: string;
  state: "passed" | "needed" | "unknown";
  /** The host's own sentence about this check. Steps render it, never invent it. */
  detail: string;
}

export interface AgencySetupWorkflowFacts {
  id: AgencyWorkflowId;
  title: string;
  selected: boolean;
  reviewed: boolean;
  readyForRun: boolean;
  checks: readonly AgencySetupCheckFacts[];
}

/** The re-validated subset of `GET /api/agency-setup` this sequence reads. */
export interface AgencySetupFacts {
  agencyName: string;
  timeZone: string;
  packSelected: boolean;
  workflows: readonly AgencySetupWorkflowFacts[];
}

/**
 * Host agency-setup facts, or `"unavailable"` when the read failed, was held or
 * returned a malformed body. `undefined` means it has not answered yet.
 */
export type AgencySetupRead = AgencySetupFacts | "unavailable" | undefined;

/**
 * This computer's link with its RealBud account, as `/api/office-link` reports
 * it. `undefined` until that read answers; `unavailable` when it failed or came
 * back malformed. Only `linked` lets the accounts step move on.
 */
export type WebsiteLinkRead = "linked" | "not-linked" | "unavailable" | undefined;

/** Re-validate the office-link status body; anything unrecognised is unavailable. */
export function readWebsiteLinkState(value: unknown): "linked" | "not-linked" | "unavailable" {
  const state = value && typeof value === "object" ? (value as { state?: unknown }).state : undefined;
  if (state === "linked") return "linked";
  if (state === "unlinked" || state === "pending" || state === "revoked") return "not-linked";
  return "unavailable";
}

export interface SetupSequenceInput {
  /**
   * The agency name recorded on You, when there is one. The agency form's own
   * saved name counts just as much, so neither surface demands the other.
   */
  officeAgencyName?: string;
  agencySetup: AgencySetupRead;
  /** The host's own loop facts. `undefined` until the loops read answers. */
  schedule?: ScheduleRead;
  /** This computer's RealBud account link. `undefined` until the read answers. */
  websiteLink?: WebsiteLinkRead;
}

/** One named loop as the host reports it on the RealBud clock. */
export interface ScheduleLoopFacts {
  id: string;
  available: boolean;
  enabled: boolean;
  /** The host's own next occurrence. A loop with no next run is not scheduled. */
  nextRunAt: number | null;
}

/**
 * The loops read: `loading` while it is in flight, `error` when it failed, and
 * `ready` with the host's loops. Anything but `ready` reads as not checked yet.
 */
export type ScheduleRead =
  | { read: "loading" | "error" }
  | { read: "ready"; loops: readonly ScheduleLoopFacts[] };

/**
 * The loop that actually carries each workflow. Only morning priorities has one:
 * `inbound-triage` is the loop the host gates on agency setup and plan review.
 * The other two workflows have no scheduled loop, which stays visible as
 * "not checked yet" rather than being mapped onto an unrelated book loop.
 */
export const WORKFLOW_LOOP_IDS: Record<AgencyWorkflowId, string | null> = {
  "bank-references": null,
  "bills-calendar": null,
  "morning-priorities": "inbound-triage",
};

/** What the host's facts say about one step, before ordering is applied. */
type Fact = { fact: "done" | "todo" | "unknown"; status: string; actionLabel?: string; target?: SetupJumpTarget };

const NOT_CHECKED = "Not checked yet.";
const OPEN_SETUP = "Open Agency workflow setup";

/**
 * Re-validate the agency-setup body before any of it can claim a step is done.
 * A malformed 200 is not a readiness fact, so it reads as unavailable.
 */
export function readAgencySetupFacts(value: unknown): AgencySetupFacts | "unavailable" {
  const body = value as { state?: unknown; workflows?: unknown } | null | undefined;
  const settings = (body?.state as { settings?: unknown } | undefined)?.settings as Record<string, unknown> | undefined;
  if (!settings || typeof settings !== "object") return "unavailable";
  if (typeof settings.agencyName !== "string" || typeof settings.timeZone !== "string") return "unavailable";
  const packId = settings.workflowPackId;
  if (packId !== null && typeof packId !== "string") return "unavailable";
  const list = body?.workflows;
  if (!Array.isArray(list)) return "unavailable";
  const workflows: AgencySetupWorkflowFacts[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") return "unavailable";
    const row = entry as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== "string" || !(AGENCY_WORKFLOWS as readonly string[]).includes(id)) return "unavailable";
    if (typeof row.title !== "string") return "unavailable";
    if (typeof row.selected !== "boolean" || typeof row.reviewed !== "boolean" || typeof row.readyForRun !== "boolean") return "unavailable";
    if (!Array.isArray(row.checks)) return "unavailable";
    const checks: AgencySetupCheckFacts[] = [];
    for (const item of row.checks) {
      if (!item || typeof item !== "object") return "unavailable";
      const check = item as Record<string, unknown>;
      if (typeof check.id !== "string" || typeof check.label !== "string" || typeof check.detail !== "string") return "unavailable";
      if (check.state !== "passed" && check.state !== "needed" && check.state !== "unknown") return "unavailable";
      checks.push({ id: check.id, label: check.label, state: check.state, detail: check.detail });
    }
    const workflowId = id as AgencyWorkflowId;
    workflows.push({
      id: workflowId,
      title: row.title.trim() || AGENCY_WORKFLOW_NAMES[workflowId],
      selected: row.selected,
      reviewed: row.reviewed,
      readyForRun: row.readyForRun,
      checks,
    });
  }
  return {
    agencyName: settings.agencyName,
    timeZone: settings.timeZone,
    packSelected: typeof packId === "string" && packId.length > 0,
    workflows,
  };
}

const list = (values: readonly string[]): string => values.join(", ");
const names = (rows: readonly AgencySetupWorkflowFacts[]): string => list(rows.map((row) => row.title));
/** The host's own sentence, or its label when the host sent no sentence. */
const said = (check: AgencySetupCheckFacts): string => check.detail.trim() || check.label;

/**
 * Step 1: one form holds the agency name, the timezone and the workflow pack.
 * The name saved on You counts as much as the one on the form, so the sequence
 * never demands both.
 */
function agencyFact(officeAgencyName: string, setup: AgencySetupFacts): Fact {
  const named = agencyIsNamed(setup.agencyName) || agencyIsNamed(officeAgencyName);
  const zone = setup.timeZone.trim();
  const missing = [
    named ? "" : "an agency name",
    zone ? "" : "a timezone",
    setup.packSelected ? "" : "a workflow pack",
  ].filter(Boolean);
  if (missing.length) {
    return { fact: "todo", status: `Still to save on this one form: ${list(missing)}. Nothing is chosen for you.` };
  }
  const shown = setup.agencyName.trim() || officeAgencyName.trim();
  return { fact: "done", status: `${shown} · ${zone} · a workflow pack is selected. Its plans are still approved separately.` };
}

/** Roll one named check up across the workflows that actually report it. */
function checkRollup(
  workflows: readonly AgencySetupWorkflowFacts[],
  checkId: string,
  absent: Fact,
): Fact {
  const rows = workflows
    .map((workflow) => ({ workflow, check: workflow.checks.find((item) => item.id === checkId) }))
    .filter((row): row is { workflow: AgencySetupWorkflowFacts; check: AgencySetupCheckFacts } => Boolean(row.check));
  if (!rows.length) return absent;
  const needed = rows.filter((row) => row.check.state === "needed");
  if (needed.length) return { fact: "todo", status: said(needed[0].check) };
  const unknown = rows.filter((row) => row.check.state === "unknown");
  if (unknown.length) return { fact: "unknown", status: `${NOT_CHECKED} ${said(unknown[0].check)}` };
  return { fact: "done", status: said(rows[0].check) };
}

const LINK_ACTION = "Link with your RealBud account";

/**
 * Step 2 starts with linking this computer to its RealBud account: that link is
 * how Bud's model access and the account connections arrive. Until the host
 * reports the link, nothing after it in this step can be the current action.
 */
function websiteLinkFact(link: WebsiteLinkRead): Fact | null {
  if (link === "linked") return null;
  const action = { actionLabel: LINK_ACTION, target: "you-office" as const };
  if (link === "not-linked") {
    return { fact: "todo", status: "Link this computer with your RealBud account first; your account then sets up Bud’s model access and account connections. Then connect the accounts your work reads.", ...action };
  }
  return {
    fact: "unknown",
    status: link === undefined ? `${NOT_CHECKED} Reading this computer’s RealBud account link…` : `${NOT_CHECKED} This computer’s RealBud account link could not be read.`,
    ...action,
  };
}

/**
 * Step 2, after the account link: the accounts the selected work reads,
 * connected through Connections and checked. Today the only account any
 * workflow requires is the private Gmail source, so that is the one host check
 * this rolls up. The status is whatever the host's own check says; this step
 * invents no fact about an account or about what has been collected from it.
 */
function accountsFact(setup: AgencySetupFacts, link: WebsiteLinkRead): Fact {
  const linkFirst = websiteLinkFact(link);
  if (linkFirst) return linkFirst;
  const selected = setup.workflows.filter((workflow) => workflow.selected);
  // Before any work is ticked the account is still the agency's own, so the
  // check is read across every workflow that reports one.
  const scope = selected.length ? selected : setup.workflows;
  return checkRollup(scope, "gmail", {
    fact: "done",
    status: "No connected account is needed for the work you chose.",
  });
}

const SEPARATE = "Enabling is a separate action on Schedule.";

function scheduleFact(schedule: ScheduleRead | undefined, selected: readonly AgencySetupWorkflowFacts[]): Fact {
  const label = "Open Schedule";
  if (!schedule || schedule.read !== "ready") return { fact: "unknown", status: `${NOT_CHECKED} ${SEPARATE}`, actionLabel: label };
  const off: string[] = [];
  const unreported: string[] = [];
  const on: string[] = [];
  for (const workflow of selected) {
    const loopId = WORKFLOW_LOOP_IDS[workflow.id];
    const loop = loopId ? schedule.loops.find((item) => item.id === loopId) : undefined;
    // No known loop, or a loop the host never reported, is not a schedule fact.
    if (!loop) unreported.push(workflow.title);
    // A loop with no next occurrence is not running, whatever its switch says.
    else if (loop.enabled && loop.available && loop.nextRunAt !== null) on.push(workflow.title);
    else off.push(workflow.title);
  }
  if (off.length) return { fact: "todo", status: `Off for ${list(off)}. ${SEPARATE}`, actionLabel: label };
  if (unreported.length) {
    return { fact: "unknown", status: `${NOT_CHECKED} No scheduled loop is reported for ${list(unreported)}. ${SEPARATE}`, actionLabel: label };
  }
  return {
    fact: "done",
    status: `On with a next run recorded for ${list(on)}. A run still asks before it sends, pays or signs anything.`,
    actionLabel: label,
  };
}

/**
 * Step 3: the selected work's own settings — property references included, for
 * the bank work that needs them — then approval, then the schedule switch. It is
 * done only when the host reports the loop enabled with a next run.
 */
function approveFact(setup: AgencySetupFacts, schedule: ScheduleRead | undefined): Fact {
  const selected = setup.workflows.filter((workflow) => workflow.selected);
  if (!selected.length) {
    return { fact: "todo", status: "No work is selected yet. Tick the work to set up in Review workflows, then approve its settings." };
  }
  // Property references exist only for bank work, and only inside this step.
  const mapping = checkRollup(selected, "mapping", { fact: "done", status: "" });
  if (mapping.fact !== "done") return mapping;
  const unreviewed = selected.filter((workflow) => !workflow.reviewed);
  const uncurrent = selected.filter((workflow) => workflow.reviewed && !workflow.readyForRun);
  if (unreviewed.length || uncurrent.length) {
    const parts = [
      unreviewed.length ? `Still to approve: ${names(unreviewed)}.` : "",
      uncurrent.length ? `Approved, but current checks are not passing: ${names(uncurrent)}.` : "",
    ].filter(Boolean);
    return { fact: "todo", status: parts.join(" ") };
  }
  return scheduleFact(schedule, selected);
}

const HELD = `${NOT_CHECKED} Workflow setup could not be read.`;

const ORDER: { id: SetupStepId; title: string; why: string; target: SetupJumpTarget; actionLabel: string }[] = [
  {
    id: "agency",
    title: "Your agency",
    why: "One form holds the agency name, the timezone its work follows and the workflow pack it uses.",
    target: "schedule-packs",
    actionLabel: OPEN_SETUP,
  },
  {
    id: "accounts",
    title: "Connect your accounts",
    why: "Link this computer with your RealBud account, then connect the accounts your work reads and check each one.",
    target: "you-connected-apps",
    actionLabel: "Open Connections",
  },
  {
    id: "approve",
    title: "Approve and schedule",
    why: "Review the selected work’s settings, approve them, then switch the schedule on yourself.",
    target: "schedule-packs",
    actionLabel: OPEN_SETUP,
  },
];

export function setupSequence(input: SetupSequenceInput): SetupStep[] {
  const setup = input.agencySetup;
  const unreadable = setup === undefined || setup === "unavailable";
  const held = (): Fact => ({
    fact: "unknown",
    status: setup === undefined ? `${NOT_CHECKED} Reading workflow setup…` : HELD,
  });

  const facts: Record<SetupStepId, Fact> = {
    agency: unreadable ? held() : agencyFact(input.officeAgencyName ?? "", setup),
    accounts: unreadable ? held() : accountsFact(setup, input.websiteLink),
    approve: unreadable ? held() : approveFact(setup, input.schedule),
  };

  let currentTaken = false;
  return ORDER.map((step, index) => {
    const { fact, status, actionLabel, target } = facts[step.id];
    let state: SetupStepState;
    if (fact === "done") state = "done";
    else if (!currentTaken) {
      state = "current";
      currentTaken = true;
    } else state = fact === "unknown" ? "unknown" : "later";
    return {
      ...step,
      number: index + 1,
      state,
      status,
      target: target ?? step.target,
      actionLabel: actionLabel ?? step.actionLabel,
    };
  });
}

export function currentSetupStep(steps: readonly SetupStep[]): SetupStep | null {
  return steps.find((step) => step.state === "current") ?? null;
}

/** True only when every step is a host-confirmed `done`. */
export function setupSequenceComplete(steps: readonly SetupStep[]): boolean {
  return steps.every((step) => step.state === "done");
}

/**
 * Bud is not a setup step: the office can read and review this whole path
 * before a worker is installed. It is one honest status line instead.
 */
export function budStatusLine(ready: boolean | "unknown"): string {
  if (ready === "unknown") return "Bud: not checked yet";
  return ready ? "Bud: ready" : "Bud: needs setup on You";
}
