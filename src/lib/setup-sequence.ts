// "Get started": one ordered setup path for a new staff member's first day.
// Five numbered steps, one current step, one screen action each, and every
// step's state read from the host's own facts.
//
// Nothing here guesses. A read that has not answered, was refused or came back
// malformed leaves its step "Not checked yet", and such a step can never read
// as finished. Bud's own setup (step 2) runs by itself: it shows as working
// while it installs, ticks only on the server's own `ready`, and never blocks
// the steps after it. No step claims a run happened or will succeed.
//
// With a role pack from the office (`/api/austin-pack` reports it installed),
// steps 3 to 5 read that pack's own checklist. An office without a role pack
// falls back to the agency setup facts (`/api/agency-setup`).
import { agencyIsNamed } from "./office-setup";
import { AGENCY_WORKFLOWS, AGENCY_WORKFLOW_NAMES, type AgencyWorkflowId } from "../../shared/agency-setup";
import type { AustinPackView } from "../../shared/austin-pack";
import { officeAppLabel, officeSourceState, type ConnectedAppsStatus } from "../../shared/office-sources";

export const SETUP_STEP_COUNT = 5;

export type SetupStepId = "link" | "bud" | "pack" | "gmail" | "workflows";

/**
 * `done` is a host-confirmed fact. `current` is the one step to act on now.
 * `working` is Bud setting itself up: nothing to do, and it blocks nothing.
 * `later` is a readable step that is not this step's turn. `unknown` is a step
 * whose fact could not be read; it is never treated as done. `skipped` is a
 * step the person put aside for now on this computer: never done, and the next
 * open step becomes current.
 */
export type SetupStepState = "done" | "current" | "working" | "later" | "unknown" | "skipped";

/**
 * Where this step's single action goes: the link-code entry in Workspace, Bud's
 * setup progress, the packs from the office on Schedule, Agency workflow setup
 * on Schedule, Connections in Workspace, or one Schedule job (`job-<loop id>`).
 */
export type SetupJumpTarget = "you-website" | "bud-setup" | "schedule-packs" | "schedule-agency" | "you-connected-apps" | `job-${string}`;

export interface SetupStep {
  id: SetupStepId;
  /** 1-based position in the fixed five-step path. */
  number: number;
  title: string;
  state: SetupStepState;
  /** What the host currently reports about this step, in one sentence. */
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

/** The office's role pack view; same reading of `undefined` and `"unavailable"`. */
export type AustinPackRead = AustinPackView | "unavailable" | undefined;

/**
 * This computer's link with its office, as `/api/office-link` reports it.
 * `undefined` until that read answers; `unavailable` when it failed or came
 * back malformed. Only `linked` finishes step 1.
 */
export type WebsiteLinkRead = "linked" | "not-linked" | "unavailable" | undefined;

/** Re-validate the office-link status body; anything unrecognised is unavailable. */
export function readWebsiteLinkState(value: unknown): "linked" | "not-linked" | "unavailable" {
  const state = value && typeof value === "object" ? (value as { state?: unknown }).state : undefined;
  if (state === "linked") return "linked";
  if (state === "unlinked" || state === "pending" || state === "revoked") return "not-linked";
  return "unavailable";
}

/**
 * Bud on this computer, from the server's own status. `ready` is the server's
 * readiness verdict; `working` means automatic setup is running and needs
 * nobody; `detail` is the product sentence for a hold, when there is one.
 * `undefined` until the status read answers.
 */
export type BudRead = { ready: boolean; working: boolean; detail: string | null } | undefined;

export interface SetupSequenceInput {
  /**
   * The agency name recorded on You, when there is one. The agency form's own
   * saved name counts just as much, so neither surface demands the other.
   */
  officeAgencyName?: string;
  agencySetup: AgencySetupRead;
  /** The office's role pack. `undefined` until that read answers. */
  austinPack?: AustinPackRead;
  /** Bud's server status. `undefined` until it answers. */
  bud?: BudRead;
  /** The host's own loop facts. `undefined` until the loops read answers. */
  schedule?: ScheduleRead;
  /** This computer's office link. `undefined` until the read answers. */
  websiteLink?: WebsiteLinkRead;
  /**
   * Office apps the linked service offers that have no account yet, from
   * `officeAppsToConnect`. Connecting one is the person's own sign-in.
   */
  appsToConnect?: readonly string[];
  /** The office shared Gmail is this computer's mailbox, but the owner hasn't allowed this computer (`sharedGmailNotAllowed`). */
  sharedGmailBlocked?: boolean;
  /** Steps the person skipped for now on this computer. Bud's own step can't be skipped. */
  skipped?: readonly SetupStepId[];
}

/**
 * Apps the office's managed connection service offers on this computer with no
 * account connected yet. Only a fresh, error-free read counts, and an office
 * shared mailbox is the owner's to connect, never this person's.
 */
export function officeAppsToConnect(access: ConnectedAppsStatus | null | undefined, managed: boolean): string[] {
  if (!managed || !access?.configured || access.error || access.sourceKind === "office_shared") return [];
  return Object.keys(access.services).filter((slug) => officeSourceState(access, slug) === "connect" && !access.services[slug]?.accounts.length);
}

/**
 * The office shared Gmail is this computer's mailbox and the managed service
 * reports it not connected here: only the office owner can allow this computer
 * on realbud.app. Only a fresh, error-free read counts.
 */
export function sharedGmailNotAllowed(access: ConnectedAppsStatus | null | undefined, managed: boolean): boolean {
  return managed && access?.sourceKind === "office_shared" && officeSourceState(access, "gmail") === "connect";
}

/** One named loop as the host reports it on the RealBud clock. */
export interface ScheduleLoopFacts {
  id: string;
  /** The loop's display name, used to name the next workflow to review. */
  name?: string;
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
 * The loop that actually carries each agency workflow (offices without a role
 * pack). Only morning priorities has one: `inbound-triage` is the loop the host
 * gates on agency setup and plan review. The other two workflows have no
 * scheduled loop, which stays visible as "not checked yet" rather than being
 * mapped onto an unrelated book loop.
 */
export const WORKFLOW_LOOP_IDS: Record<AgencyWorkflowId, string | null> = {
  "bank-references": null,
  "bills-calendar": null,
  "morning-priorities": "inbound-triage",
};

/** What the host's facts say about one step, before ordering is applied. */
type Fact = { fact: "done" | "todo" | "unknown"; status: string; actionLabel?: string; target?: SetupJumpTarget };

const NOT_CHECKED = "Not checked yet.";

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

/** Step 1: this computer's link with its office. */
function linkFact(link: WebsiteLinkRead): Fact {
  if (link === "linked") return { fact: "done", status: "This computer is connected to your office." };
  if (link === "not-linked") return { fact: "todo", status: "Your office owner sends this code. Ask them if you don’t have one yet." };
  return {
    fact: "unknown",
    status: link === undefined ? `${NOT_CHECKED} Reading this computer’s office link…` : `${NOT_CHECKED} This computer’s office link could not be read.`,
  };
}

const BUD_WORKING = "This usually takes about 10 minutes and you don’t need to do anything.";

/** Step 2: done only on the server's own `ready`; working while setup runs. */
function budStep(bud: BudRead, link: WebsiteLinkRead): { state: SetupStepState; status: string } {
  if (!bud) return { state: "unknown", status: `${NOT_CHECKED} Reading Bud’s setup…` };
  if (bud.ready) return { state: "done", status: "Bud is set up on this computer." };
  if (bud.working) return { state: "working", status: BUD_WORKING };
  if (bud.detail) return { state: "later", status: bud.detail };
  return {
    state: "later",
    status: link === "linked" ? "Bud is not set up yet. See progress for what it is waiting on." : "Starts by itself once this computer is connected.",
  };
}

/**
 * Fallback for step 3 without a role pack: the agency form holds the agency
 * name, the timezone and the workflow pack. The name saved on You counts as
 * much as the one on the form.
 */
function agencyComplete(officeAgencyName: string, setup: AgencySetupFacts): boolean {
  const named = agencyIsNamed(setup.agencyName) || agencyIsNamed(officeAgencyName);
  return named && Boolean(setup.timeZone.trim()) && setup.packSelected;
}

/** Step 3: the office's pack is imported (or, without one, the agency form is saved). */
function packFact(pack: AustinPackRead, setup: AgencySetupRead, officeAgencyName: string): Fact {
  if (pack && pack !== "unavailable" && pack.installed) return { fact: "done", status: `Imported: ${pack.pack.title}.` };
  if (setup && setup !== "unavailable" && agencyComplete(officeAgencyName, setup)) {
    return { fact: "done", status: "Your agency setup and its workflow pack are saved." };
  }
  if (pack && pack !== "unavailable") {
    return { fact: "todo", status: "Import the pack your office shared with you. Each workflow arrives switched off." };
  }
  return { fact: "unknown", status: pack === undefined ? `${NOT_CHECKED} Reading packs from your office…` : `${NOT_CHECKED} Packs from your office could not be read.` };
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

const NO_GMAIL = "No Gmail is needed for the work you chose.";
const SIGN_IN_GMAIL = "Sign in to the office Gmail in your browser.";
const ASK_OWNER: Fact = { fact: "todo", status: "Ask the office owner to allow this computer on realbud.app.", actionLabel: "Open connected apps" };
const REVIEW_EACH = "Open each workflow, read what it does, then switch it on.";

/**
 * Step 4: the office Gmail. With a role pack this is the pack's own Gmail
 * check; without one, the agency setup's Gmail check, after any app the linked
 * service offers that has no account yet. Signing in is the person's own.
 */
function gmailFact(pack: AustinPackRead, setup: AgencySetupRead, appsToConnect: readonly string[], sharedBlocked: boolean): Fact {
  // A shared mailbox is the owner's to allow; signing in here would not help.
  const signIn: Fact = sharedBlocked ? ASK_OWNER : { fact: "todo", status: SIGN_IN_GMAIL };
  if (pack && pack !== "unavailable" && pack.installed) {
    const item = pack.checklist.find((entry) => entry.id === "gmail");
    if (!item) return { fact: "done", status: NO_GMAIL };
    return item.done ? { fact: "done", status: "The office Gmail is connected." } : signIn;
  }
  if (!setup || setup === "unavailable") return { fact: "unknown", status: `${NOT_CHECKED} Your office’s connections could not be read yet.` };
  if (appsToConnect.length) {
    const labels = appsToConnect.map(officeAppLabel);
    return {
      fact: "todo",
      status: `Sign in to ${labels[0]} in your browser.`,
      actionLabel: `Connect ${labels[0]}`,
    };
  }
  const selected = setup.workflows.filter((workflow) => workflow.selected);
  // Before any work is ticked the account is still the agency's own, so the
  // check is read across every workflow that reports one.
  const rolled = checkRollup(selected.length ? selected : setup.workflows, "gmail", { fact: "done", status: NO_GMAIL });
  // The host's check wording is diagnostic; the step stays one plain sentence.
  if (rolled.fact === "todo") return signIn;
  if (rolled.fact === "unknown") return { fact: "unknown", status: `${NOT_CHECKED} The office Gmail hasn’t been checked.` };
  return rolled.status === NO_GMAIL ? rolled : { fact: "done", status: "The office Gmail is connected." };
}

const SEPARATE = "Switching on is a separate action on Schedule.";

function scheduleFact(schedule: ScheduleRead | undefined, selected: readonly AgencySetupWorkflowFacts[]): Fact {
  const label = "Open Schedule";
  const target = "schedule-packs" as const;
  if (!schedule || schedule.read !== "ready") return { fact: "unknown", status: `${NOT_CHECKED} ${SEPARATE}`, actionLabel: label, target };
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
  if (off.length) return { fact: "todo", status: `Off for ${list(off)}. ${SEPARATE}`, actionLabel: label, target };
  if (unreported.length) {
    return { fact: "unknown", status: `${NOT_CHECKED} No scheduled loop is reported for ${list(unreported)}. ${SEPARATE}`, actionLabel: label, target };
  }
  return {
    fact: "done",
    status: `On with a next run recorded for ${list(on)}. A run still asks before it sends, pays or signs anything.`,
  };
}

/**
 * Step 5 fallback without a role pack: the selected work's own settings
 * (property references included, for the bank work that needs them), then
 * approval, then the schedule switch. Done only when the host reports the
 * loop enabled with a next run.
 */
function approveFact(setup: AgencySetupFacts, schedule: ScheduleRead | undefined): Fact {
  const selected = setup.workflows.filter((workflow) => workflow.selected);
  if (!selected.length) {
    return { fact: "todo", status: REVIEW_EACH };
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

/** Mail loops the host switches on only once their agency workflow is ready to run. */
const AGENCY_GATED_LOOPS: Record<string, AgencyWorkflowId> = { "weekly-bills": "bills-calendar", "inbound-triage": "morning-priorities" };

/**
 * What stands before the next workflow: its first unmet need on the pack's own
 * checklist (REI sign-in, Redbark, the tenant or supplier list), then for mail
 * work the agency setup the host requires. Only a reported fact blocks.
 */
function nextBlocker(pack: AustinPackView, setup: AgencySetupRead, loopId: string, name: string): Omit<Fact, "fact"> | null {
  const needs = pack.loops.find((loop) => loop.loopId === loopId)?.needs ?? [];
  // Gmail is step 4's own; this names what only this workflow still needs.
  const need = pack.checklist.find((item) => item.id !== "gmail" && needs.includes(item.id) && !item.done);
  if (need) return { status: `Before ${name}: ${need.detail}` };
  const agency = setup && setup !== "unavailable" ? setup.workflows.find((row) => row.id === AGENCY_GATED_LOOPS[loopId]) : undefined;
  if (agency && !agency.readyForRun) {
    return { status: `Before ${name} can switch on, finish Agency workflow setup and approve it there.`, actionLabel: "Open Agency workflow setup", target: "schedule-agency" };
  }
  return null;
}

/**
 * Step 5 with a role pack: each of the pack's workflows reviewed and switched
 * on with a next run. The count follows the live loops when they are read,
 * else the pack's own checklist; the action opens the next incomplete
 * workflow, or what it still needs first.
 */
function packWorkflowsFact(pack: AustinPackView, schedule: ScheduleRead | undefined, setup: AgencySetupRead): Fact {
  if (schedule?.read !== "ready") {
    const item = pack.checklist.find((entry) => entry.id === "workflows");
    if (!item) return { fact: "unknown", status: `${NOT_CHECKED} Your workflows could not be read yet.` };
    if (item.done) return { fact: "done", status: item.detail };
    return { fact: "todo", status: item.detail, ...(item.next ? { actionLabel: "Review the next workflow", target: `job-${item.next}` as const } : {}) };
  }
  const loops = schedule.loops;
  const ids = pack.loops.map((loop) => loop.loopId);
  const off = ids.filter((id) => {
    const loop = loops.find((loop) => loop.id === id);
    // Match the host checklist and the generic setup: a switch alone is not a scheduled run.
    return !(loop?.enabled && loop.available && loop.nextRunAt !== null);
  });
  if (!off.length) return { fact: "done", status: `All ${ids.length} workflows are on.` };
  const next = off[0];
  const nextLoop = loops.find((loop) => loop.id === next);
  const name = nextLoop?.name?.trim() || "The next workflow";
  const clockIssue = nextLoop?.enabled
    ? `${name} is switched on but ${!nextLoop.available ? "is not currently available" : "has no next run"}. Review its schedule.`
    : null;
  const countLabel = off.some(id => loops.find(loop => loop.id === id)?.enabled) ? "scheduled" : "on";
  const blocker = nextBlocker(pack, setup, next, name);
  return {
    fact: "todo",
    status: `${ids.length - off.length} of ${ids.length} ${countLabel}. ${clockIssue ?? blocker?.status ?? REVIEW_EACH}`,
    actionLabel: clockIssue ? "Review schedule" : blocker?.actionLabel ?? `Review ${name}`,
    target: clockIssue ? `job-${next}` : blocker?.target ?? `job-${next}`,
  };
}

function workflowsFact(pack: AustinPackRead, setup: AgencySetupRead, schedule: ScheduleRead | undefined): Fact {
  if (pack && pack !== "unavailable" && pack.installed) return packWorkflowsFact(pack, schedule, setup);
  if (!setup || setup === "unavailable") return { fact: "unknown", status: `${NOT_CHECKED} Your workflows could not be read yet.` };
  return approveFact(setup, schedule);
}

const ORDER: { id: SetupStepId; title: string; target: SetupJumpTarget; actionLabel: string }[] = [
  { id: "link", title: "Paste the link code your office sent you", target: "you-website", actionLabel: "Enter link code" },
  { id: "bud", title: "Bud is setting itself up", target: "bud-setup", actionLabel: "See progress" },
  { id: "pack", title: "Import your office’s pack", target: "schedule-packs", actionLabel: "Open packs from your office" },
  { id: "gmail", title: "Connect the office Gmail", target: "you-connected-apps", actionLabel: "Connect Gmail" },
  { id: "workflows", title: "Review and switch on your workflows", target: "schedule-packs", actionLabel: "Open Schedule" },
];

export function setupSequence(input: SetupSequenceInput): SetupStep[] {
  const facts: Record<Exclude<SetupStepId, "bud">, Fact> = {
    link: linkFact(input.websiteLink),
    pack: packFact(input.austinPack, input.agencySetup, input.officeAgencyName ?? ""),
    gmail: gmailFact(input.austinPack, input.agencySetup, input.appsToConnect ?? [], input.sharedGmailBlocked === true),
    workflows: workflowsFact(input.austinPack, input.agencySetup, input.schedule),
  };

  let currentTaken = false;
  return ORDER.map((step, index) => {
    const number = index + 1;
    // Bud never takes the current step: it runs by itself and blocks nothing.
    if (step.id === "bud") {
      const bud = budStep(input.bud, input.websiteLink);
      return { ...step, number, ...bud, title: bud.state === "done" ? "Bud is set up" : step.title };
    }
    const { fact, status, actionLabel, target } = facts[step.id];
    let state: SetupStepState;
    if (fact === "done") state = "done";
    else if (input.skipped?.includes(step.id)) state = "skipped";
    else if (!currentTaken) {
      state = "current";
      currentTaken = true;
    } else state = fact === "unknown" ? "unknown" : "later";
    return { ...step, number, state, status, target: target ?? step.target, actionLabel: actionLabel ?? step.actionLabel };
  });
}

export function currentSetupStep(steps: readonly SetupStep[]): SetupStep | null {
  return steps.find((step) => step.state === "current") ?? null;
}

/** True only when every step, Bud included, is a host-confirmed `done`. */
export function setupSequenceComplete(steps: readonly SetupStep[]): boolean {
  return steps.every((step) => step.state === "done");
}
