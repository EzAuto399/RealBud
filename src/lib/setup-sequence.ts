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
import { isProvisioningSkipReasonText, type InstallationUsageState } from "../../shared/office-link";
import { officeAppLabel, officeSourceState, type ConnectedAppsStatus } from "../../shared/office-sources";
import type { OwnerRequestKind } from "./owner-request";

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
 * Where this step's single action goes: the link-code field in Workspace (its
 * disclosure opened), the Website account card, Bud's setup progress, Bud's
 * Try setup again (`POST /api/hermes/auto-setup/retry`), REI's own sign-in
 * page in the work browser, the packs from the office on Schedule, Agency
 * workflow setup on Schedule, Connections in Workspace, or one Schedule job
 * (`job-<loop id>`).
 */
export type SetupJumpTarget = "you-website-code" | "you-website" | "bud-setup" | "bud-retry" | "rei-sign-in" | "schedule-packs" | "schedule-agency" | "you-connected-apps" | `job-${string}`;

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
  /** Only the office owner can unblock this step: offer "Copy request for your owner". */
  ownerRequest?: OwnerRequestKind;
  /** The owner request replaces the action, which would only lead back here. */
  ownerOnly?: boolean;
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

/** The re-validated subset of `GET /api/office-link` that setup reads beyond linked / not linked. */
export interface OfficeLinkFacts {
  link: "linked" | "not-linked" | "unavailable";
  /** The website no longer accepts this computer: not the same as never linked. */
  revoked: boolean;
  /** Linked, but the website says the office account is inactive. Nothing is removed. */
  officeInactive: boolean;
  /** The office stopped Bud's service access here. Saved work is unaffected. */
  serviceWithdrawn: boolean;
  /** A browser approval this computer is waiting on: when it expires (ISO). */
  browserExpiresAt?: string;
  /** This month's AI usage. `checking` is a first load, never zero. */
  usage?: InstallationUsageState;
  /** Provisioned, but the model key is unusable. */
  modelKey?: "missing" | "rejected";
  /** Linked with no grant in force: the website's own reason identifier. */
  provisioningSkipped?: string;
}

export const NO_OFFICE_FACTS: OfficeLinkFacts = { link: "unavailable", revoked: false, officeInactive: false, serviceWithdrawn: false };

/** Re-validate the office-link body; an unrecognised state reads as unavailable and claims nothing. */
export function readOfficeLinkFacts(value: unknown): OfficeLinkFacts {
  const link = readWebsiteLinkState(value);
  if (link === "unavailable") return NO_OFFICE_FACTS;
  const body = value as Record<string, unknown>;
  const browser = body.browser as { expiresAt?: unknown } | null | undefined;
  const usage = body.usage as { state?: unknown; usage?: { remainingNanoAud?: unknown } | null } | null | undefined;
  const usageOk = !!usage && typeof usage === "object" && (["not-linked", "checking", "unavailable"].includes(usage.state as string)
    || (usage.state === "ready" && !!usage.usage && typeof usage.usage === "object"
      && (usage.usage.remainingNanoAud === null || typeof usage.usage.remainingNanoAud === "string")));
  const expiresAt = browser && typeof browser === "object" ? browser.expiresAt : undefined;
  return {
    link,
    revoked: body.state === "revoked",
    officeInactive: link === "linked" && body.officeInactive === true,
    serviceWithdrawn: body.serviceWithdrawn === true,
    ...(body.state === "pending" && typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)) ? { browserExpiresAt: expiresAt } : {}),
    ...(usageOk ? { usage: usage as InstallationUsageState } : {}),
    ...(body.modelKey === "missing" || body.modelKey === "rejected" ? { modelKey: body.modelKey } : {}),
    ...(link === "linked" && isProvisioningSkipReasonText(body.provisioningSkipped) ? { provisioningSkipped: body.provisioningSkipped } : {}),
  };
}

/**
 * What the last link attempt on this computer said, from the surface that made
 * it: the browser approval expired or was declined, or a pasted code was
 * refused with the website's own sentence (409 `installation_limit`, which
 * keeps the code, or 409 `link_code_refused`).
 */
export type LinkAttempt =
  | { outcome: "expired" | "declined" }
  | { outcome: "installation_limit" | "link_code_refused"; message: string };

/**
 * Bud on this computer, from the server's own status. `ready` is the server's
 * readiness verdict; `working` means automatic setup is running and needs
 * nobody; `detail` is the product sentence for a hold, when there is one.
 * `step`/`total` are automatic setup's position, `heldAt` the step a stop
 * happened at, and `retryable` that Try setup again can clear the hold.
 * `undefined` until the status read answers.
 */
export type BudRead = {
  ready: boolean;
  working: boolean;
  detail: string | null;
  step?: number;
  total?: number;
  heldAt?: number;
  retryable?: boolean;
  /** An installed Bud update waits for the service to restart. */
  restartRequired?: boolean;
  /** The office's model grant for this computer was withdrawn. */
  withdrawn?: boolean;
} | undefined;

/** REI Cloud's sign-in today (`/api/rei/sign-in`, `parseReiSignIn`). `null` or absent when not read. */
export type ReiRead = { state: "needed" | "signed_in" | "unknown"; used: boolean; signingIn: boolean; waiting?: readonly { loopId: string }[] } | null;

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
  /** The Gmail the office's mode asks for is connected and readable here (`gmailReadyHere`). */
  gmailReady?: GmailReady;
  /** Steps the person skipped for now on this computer. Bud's own step and the office link can't be skipped. */
  skipped?: readonly SetupStepId[];
  /** The office-link facts beyond linked / not linked (`readOfficeLinkFacts`). */
  office?: OfficeLinkFacts;
  /** The last link attempt's outcome on this computer, shown while not linked. */
  linkAttempt?: LinkAttempt | null;
  /** The website's reason for issuing no model grant, as its product sentence (`modelAccessMessage`). */
  modelAccessReason?: string | null;
  /** REI Cloud's sign-in today. */
  rei?: ReiRead;
  /** The office Gmail is connected but needs attention (`officeSourceState` "degraded"). */
  gmailDegraded?: boolean;
  /** A downloaded RealBud update waits for a restart. Status only; it holds nothing. */
  updatePending?: boolean;
  /** Clock for time-limited steps. */
  now?: number;
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

/** Which mailbox this computer can read: the person's own, or the office's. */
export type GmailReady = "own" | "office" | null;

/**
 * The Gmail the office's mode asks for, connected and readable on this
 * computer, from a fresh, error-free read: `personal` the person's own mailbox,
 * `shared` the office mailbox the owner allowed here, `both` either one.
 */
export function gmailReadyHere(access: ConnectedAppsStatus | null | undefined, managed: boolean): GmailReady {
  if (!managed || !access) return null;
  if (officeSourceState(access, "gmail") === "ready") return access.sourceKind === "office_shared" || access.mailboxMode === "shared" ? "office" : "own";
  const office = access.mailboxMode === "both" && access.officeShared;
  return office && officeSourceState({ ...access, services: { gmail: office } }, "gmail") === "ready" ? "office" : null;
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
type Fact = { fact: "done" | "todo" | "unknown"; status: string; actionLabel?: string; target?: SetupJumpTarget; ownerRequest?: OwnerRequestKind; ownerOnly?: boolean };

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

export const CONNECT_FIRST = "Connect this computer to your office first.";
const NOT_LINKED = `${CONNECT_FIRST} Paste the link code your office owner sent you.`;
const DISCONNECTED = "This computer was disconnected from your office. Your conversations and files are kept. Connect it again with a new link code.";

/** The website no longer accepts this computer, or a withdrawal outlived its link record. */
const revokedHere = (input: SetupSequenceInput): boolean =>
  Boolean(input.office?.revoked || (input.websiteLink === "not-linked" && (input.office?.serviceWithdrawn || input.bud?.withdrawn)));

/** Step 1: this computer's link with its office, with what the last attempt said. */
function linkFact(input: SetupSequenceInput): Fact {
  const link = input.websiteLink;
  if (link === "linked") return { fact: "done", status: "This computer is connected to your office." };
  if (link === "not-linked") {
    if (revokedHere(input)) return { fact: "todo", status: DISCONNECTED, ownerRequest: "linkCode" };
    const attempt = input.linkAttempt;
    // The website's own sentence; its limit refusal says the code is kept.
    if (attempt?.outcome === "installation_limit") return { fact: "todo", status: attempt.message, ownerRequest: "freePlace" };
    if (attempt?.outcome === "link_code_refused") return { fact: "todo", status: attempt.message, ownerRequest: "linkCode" };
    const expires = input.office?.browserExpiresAt ? Date.parse(input.office.browserExpiresAt) - (input.now ?? Date.now()) : NaN;
    if (expires > 0) {
      const minutes = Math.max(1, Math.ceil(expires / 60_000));
      return { fact: "todo", status: `Approve this computer in your browser. About ${minutes} minute${minutes === 1 ? "" : "s"} left.`, actionLabel: "Continue linking" };
    }
    if (expires <= 0 || attempt?.outcome === "expired") return { fact: "todo", status: "The approval page expired before this computer was approved. Nothing was linked.", ownerRequest: "linkCode" };
    if (attempt?.outcome === "declined") return { fact: "todo", status: "This computer was declined in your browser. Nothing was linked.", ownerRequest: "linkCode" };
    return { fact: "todo", status: NOT_LINKED, ownerRequest: "linkCode" };
  }
  return {
    fact: "unknown",
    status: link === undefined ? `${NOT_CHECKED} Reading this computer’s office link…` : `${NOT_CHECKED} This computer’s office link could not be read.`,
  };
}

/** Where a stop happened, in the same words as Bud's setup progress (`HELD_AT` in bud-setup.ts). */
const HELD_AT: Record<number, string | undefined> = { 1: "installing Bud", 2: "turning on approvals", 3: "connecting your office’s AI", 4: "testing Bud" };
const RETRY = { actionLabel: "Try setup again", target: "bud-retry" as const };

/** Step 2: done only on the server's own `ready`; working while setup runs. */
function budStep(input: SetupSequenceInput): { state: SetupStepState; status: string; actionLabel?: string; target?: SetupJumpTarget } {
  const bud = input.bud;
  if (!bud) return { state: "unknown", status: `${NOT_CHECKED} Reading Bud’s setup…` };
  if (bud.ready) return { state: "done", status: "Bud is set up on this computer." };
  if (bud.working) {
    const total = bud.total && bud.total > 0 ? bud.total : 4;
    const step = Math.min(total, Math.max(1, bud.step ?? 1));
    return { state: "working", status: `Bud is setting itself up — step ${step} of ${total}, usually about 10 minutes. Nothing to do; you can look around the sample desk meanwhile.` };
  }
  // The website's stated reason for no model grant is the real cause; local setup cannot get past it.
  if (input.websiteLink === "linked" && input.modelAccessReason) return { state: "later", status: input.modelAccessReason };
  const at = bud.heldAt ? HELD_AT[bud.heldAt] : undefined;
  const retry = bud.retryable ? RETRY : {};
  if (at) return { state: "later", status: `Bud’s setup stopped while ${at}. Nothing was lost.`, ...retry };
  if (bud.detail) return { state: "later", status: bud.detail, ...retry };
  return {
    state: "later",
    status: input.websiteLink === "linked" ? "Bud is not set up yet. See progress for what it is waiting on." : "Starts by itself once this computer is connected.",
    ...retry,
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
    return { fact: "todo", status: "Import your office’s pack. Each workflow arrives switched off." };
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
const ASK_OWNER: Fact = { fact: "todo", status: "Only your office owner can allow this computer to read the office Gmail.", ownerRequest: "sharedGmail", ownerOnly: true };
const REI_SIGN_IN = { actionLabel: "Sign in to REI", target: "rei-sign-in" as const };
const REVIEW_EACH = "Open each workflow, read what it does, then switch it on.";

/**
 * Step 4: the office Gmail. With a role pack this is the pack's own Gmail
 * check; without one, the agency setup's Gmail check, after any app the linked
 * service offers that has no account yet. Signing in is the person's own.
 */
function gmailFact(pack: AustinPackRead, setup: AgencySetupRead, appsToConnect: readonly string[], sharedBlocked: boolean, ready: GmailReady): Fact {
  // The connection itself is the fact. Choosing and checking the account a
  // workflow reads is part of approving that workflow (step 5).
  if (ready) return { fact: "done", status: ready === "own" ? "Your Gmail is connected." : "The office Gmail is allowed on this computer." };
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

/** The pack's workflows need an REI sign-in that this computer has never had. */
function reiTodo(pack: AustinPackRead, rei: ReiRead | undefined): boolean {
  if (!pack || pack === "unavailable" || !pack.installed) return false;
  const item = pack.checklist.find((entry) => entry.id === "rei");
  return Boolean(item && !item.done && rei?.state !== "signed_in");
}

/**
 * Step 4: what the pack's workflows read here. The Gmail the office's mode asks
 * for first, then REI Cloud's sign-in once. The bank feed never holds this
 * step: the bank review takes the CSV instead.
 */
function sourcesFact(input: SetupSequenceInput): Fact {
  const gmail = gmailFact(input.austinPack, input.agencySetup, input.appsToConnect ?? [], input.sharedGmailBlocked === true, input.gmailReady ?? null);
  if (gmail.fact !== "done" || !reiTodo(input.austinPack, input.rei)) return gmail;
  return input.rei?.signingIn
    ? { fact: "todo", status: "REI’s sign-in page is open in the work browser. Type your password there.", ...REI_SIGN_IN }
    : { fact: "todo", status: "Sign in to REI once so Bud can read your tenant list. You type your password on REI’s own page.", ...REI_SIGN_IN };
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
 * Why the host would refuse to switch this job on: mail work whose agency
 * workflow is not ready to run (the host's `assertWorkflowReady`). Only a
 * reported fact holds; Schedule holds the job's switch with this sentence.
 */
export function switchOnBlocker(setup: AgencySetupRead, loopId: string, name: string): Omit<Fact, "fact"> | null {
  const agency = setup && setup !== "unavailable" ? setup.workflows.find((row) => row.id === AGENCY_GATED_LOOPS[loopId]) : undefined;
  return agency && !agency.readyForRun
    ? { status: `Before ${name} can switch on, finish Agency workflow setup and approve it there.`, actionLabel: "Open Agency workflow setup", target: "schedule-agency" }
    : null;
}

/** Checklist needs that never hold one workflow: step 4 owns Gmail and REI sign-in, and the bank review takes a CSV without a bank feed. */
const NOT_A_WORKFLOW_BLOCKER: ReadonlySet<string> = new Set(["gmail", "rei", "redbark"]);

/**
 * What stands before this workflow: its first unmet need on the pack's own
 * checklist (the tenant or supplier list), then for mail work the agency
 * setup the host requires. Only a reported fact blocks.
 */
export function nextBlocker(pack: AustinPackView, setup: AgencySetupRead, loopId: string, name: string): Omit<Fact, "fact"> | null {
  const needs = pack.loops.find((loop) => loop.loopId === loopId)?.needs ?? [];
  const need = pack.checklist.find((item) => !NOT_A_WORKFLOW_BLOCKER.has(item.id) && needs.includes(item.id) && !item.done);
  if (need) return { status: `Before ${name}: ${need.detail}` };
  return switchOnBlocker(setup, loopId, name);
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
  { id: "link", title: "Paste the link code your office sent you", target: "you-website-code", actionLabel: "Enter link code" },
  { id: "bud", title: "Bud is setting itself up", target: "bud-setup", actionLabel: "See progress" },
  { id: "pack", title: "Import your office’s pack", target: "schedule-packs", actionLabel: "Open packs from your office" },
  // The id stays `gmail`: saved skips and QA name it.
  { id: "gmail", title: "Connect what your workflows read", target: "you-connected-apps", actionLabel: "Connect Gmail" },
  { id: "workflows", title: "Review and switch on your workflows", target: "schedule-packs", actionLabel: "Open Schedule" },
];

export function setupSequence(input: SetupSequenceInput): SetupStep[] {
  const facts: Record<Exclude<SetupStepId, "bud">, Fact> = {
    link: linkFact(input),
    pack: packFact(input.austinPack, input.agencySetup, input.officeAgencyName ?? ""),
    gmail: sourcesFact(input),
    workflows: workflowsFact(input.austinPack, input.agencySetup, input.schedule),
  };

  let currentTaken = false;
  return ORDER.map((step, index) => {
    const number = index + 1;
    // Bud never takes the current step: it runs by itself, and its action always shows.
    if (step.id === "bud") {
      const bud = budStep(input);
      return { ...step, number, ...bud, title: bud.state === "done" ? "Bud is set up" : step.title };
    }
    const { fact, status, actionLabel, target, ownerRequest, ownerOnly } = facts[step.id];
    let state: SetupStepState;
    if (fact === "done") state = "done";
    // The office link comes before anything else: an older saved skip of it is ignored.
    else if (step.id !== "link" && input.skipped?.includes(step.id)) state = "skipped";
    else if (!currentTaken) {
      state = "current";
      currentTaken = true;
    } else state = fact === "unknown" ? "unknown" : "later";
    return { ...step, number, state, status, target: target ?? step.target, actionLabel: actionLabel ?? step.actionLabel,
      ...(fact !== "done" && ownerRequest ? { ownerRequest, ...(ownerOnly ? { ownerOnly } : {}) } : {}) };
  });
}

export function currentSetupStep(steps: readonly SetupStep[]): SetupStep | null {
  return steps.find((step) => step.state === "current") ?? null;
}

/** True only when every step, Bud included, is a host-confirmed `done`. */
export function setupSequenceComplete(steps: readonly SetupStep[]): boolean {
  return steps.every((step) => step.state === "done");
}

// ── Stage, degraded overlays and gates ─────────────────────────────────────
//
// One reading of setup for every surface: which stage this computer is at,
// what went wrong since (most serious first), and which controls may act now.
// Gates are presentation only; the server stays the authority on every action.

/** The first step not done, in order; `ready` once every step is done. */
export type SetupStage = SetupStepId | "ready";

/** Something wrong after setup, most serious first. Each re-applies the gates of the stage it undoes. */
export type SetupDegradedKind = "revoked" | "officeInactive" | "restartRequired" | "aiLimit" | "modelKey" | "gmail" | "reiExpired" | "updatePending";

export interface SetupDegraded {
  kind: SetupDegradedKind;
  /** The real cause in one product sentence. */
  message: string;
  /** The fix right there, when this computer has one. */
  actionLabel?: string;
  target?: SetupJumpTarget;
  /** Only the office owner can fix it: offer "Copy request for your owner". */
  ownerRequest?: OwnerRequestKind;
}

/** Whether a control may act now. A closed gate names the reason and, where there is one, the fix. */
export interface SetupGate {
  on: boolean;
  reason?: string;
  actionLabel?: string;
  target?: SetupJumpTarget;
  ownerRequest?: OwnerRequestKind;
}

export interface SetupGates {
  /** Asking Bud in Work. */
  ask: SetupGate;
  /** Connecting an app in Connected apps. */
  connectApps: SetupGate;
  /** Switching one Schedule job on. */
  switchOn: (loopId: string) => SetupGate;
  /** Running one Schedule job now. */
  runNow: (loopId: string) => SetupGate;
}

export interface SetupState {
  stage: SetupStage;
  /** The most serious degraded overlay, or null. */
  degraded: SetupDegraded | null;
  steps: SetupStep[];
  /** The one step to act on now. */
  next: SetupStep | null;
  gates: SetupGates;
}

const WITHDRAWN = "Your office stopped Bud’s access for this computer. Everything saved here is kept. Ask your office owner to restore it on realbud.app.";
const INACTIVE = "Your office’s RealBud account is inactive. Nothing was removed; this computer reconnects by itself once your office owner reactivates it on realbud.app.";
const RESTART = "Bud’s update is installed. RealBud’s service needs to restart to use it; your work is kept.";
const AI_LIMIT = "Your office has used this month’s AI allowance. New work can start once your owner raises it.";
const KEY_MISSING = "Bud’s AI key hasn’t arrived on this computer. RealBud asks your office for it again by itself; your work is kept.";
const KEY_REJECTED = "Your office’s AI service refused Bud’s key. Your office owner can check AI access on realbud.app.";
const GMAIL_DEGRADED = "Gmail needs attention in Connected apps. Work that reads Gmail waits until it is fixed.";
const REI_EXPIRED = "REI signed you out. Sign in so Bud can read REI today.";
const UPDATE_PENDING = "A RealBud update is ready. It installs when RealBud restarts; your work is kept.";
/** A remaining allowance of zero or less; an unknown amount is never a limit. */
const SPENT = /^(?:0+|-\d+)$/;

function degradedList(input: SetupSequenceInput): SetupDegraded[] {
  const { office, bud } = input;
  const linked = input.websiteLink === "linked";
  const list: SetupDegraded[] = [];
  if (revokedHere(input)) list.push({ kind: "revoked", message: DISCONNECTED, actionLabel: "Enter link code", target: "you-website-code", ownerRequest: "linkCode" });
  else if (linked && (office?.serviceWithdrawn || bud?.withdrawn)) list.push({ kind: "revoked", message: WITHDRAWN, ownerRequest: "modelAccess" });
  if (linked && office?.officeInactive) list.push({ kind: "officeInactive", message: INACTIVE, actionLabel: "Open Website account", target: "you-website" });
  if (bud?.restartRequired) list.push({ kind: "restartRequired", message: RESTART, actionLabel: "See progress", target: "bud-setup" });
  const usage = office?.usage;
  if (linked && usage?.state === "ready" && SPENT.test(usage.usage.remainingNanoAud ?? "")) list.push({ kind: "aiLimit", message: AI_LIMIT, ownerRequest: "modelAccess" });
  if (linked && office?.modelKey) {
    list.push(office.modelKey === "missing" ? { kind: "modelKey", message: KEY_MISSING } : { kind: "modelKey", message: KEY_REJECTED, ownerRequest: "modelAccess" });
  }
  if (input.gmailDegraded) list.push({ kind: "gmail", message: GMAIL_DEGRADED, actionLabel: "Open Connected apps", target: "you-connected-apps" });
  // Never signed in is step 4's; signed out since then holds only REI work.
  if (input.rei?.used && input.rei.state === "needed" && !reiTodo(input.austinPack, input.rei)) list.push({ kind: "reiExpired", message: REI_EXPIRED, ...REI_SIGN_IN });
  if (input.updatePending) list.push({ kind: "updatePending", message: UPDATE_PENDING });
  return list;
}

const OPEN: SetupGate = { on: true };
const shut = (reason: string, fix: { actionLabel?: string; target?: SetupJumpTarget; ownerRequest?: OwnerRequestKind } = {}): SetupGate => ({
  on: false, reason, ...(fix.actionLabel ? { actionLabel: fix.actionLabel } : {}), ...(fix.target ? { target: fix.target } : {}), ...(fix.ownerRequest ? { ownerRequest: fix.ownerRequest } : {}),
});

/** The one reading of setup: stage, the most serious degraded overlay, steps, next step and gates. */
export function setupState(input: SetupSequenceInput): SetupState {
  const steps = setupSequence(input);
  const issues = degradedList(input);
  const issue = (kind: SetupDegradedKind) => issues.find((item) => item.kind === kind);
  const fromIssue = (item: SetupDegraded) => shut(item.message, item);
  const [link, bud] = [steps[0]!, steps[1]!];
  const pack = input.austinPack && input.austinPack !== "unavailable" && input.austinPack.installed ? input.austinPack : null;

  /**
   * Link, then Bud, then AI access. `confirmed` closes a gate only on a
   * reported fact (an unread link never blocks Ask); otherwise anything short
   * of linked and Bud ready closes it, with the step's own sentence.
   */
  const core = (confirmed: boolean, ai: boolean): SetupGate | null => {
    if (input.websiteLink === "not-linked") return shut(CONNECT_FIRST, { actionLabel: "Enter link code", target: "you-website-code", ownerRequest: "linkCode" });
    if (!confirmed && input.websiteLink !== "linked") return shut(link.status);
    for (const kind of ["revoked", "officeInactive", "restartRequired"] as const) {
      const item = issue(kind);
      if (item) return fromIssue(item);
    }
    if (input.bud ? !input.bud.ready : !confirmed) return shut(bud.status, bud);
    if (ai) {
      for (const kind of ["aiLimit", "modelKey"] as const) {
        const item = issue(kind);
        if (item) return fromIssue(item);
      }
    }
    return null;
  };
  const name = (loopId: string) => (input.schedule?.read === "ready" ? input.schedule.loops.find((loop) => loop.id === loopId)?.name?.trim() : "") || "This workflow";
  const reads = (loopId: string): string[] => [
    ...(pack?.loops.find((loop) => loop.loopId === loopId)?.needs ?? (AGENCY_GATED_LOOPS[loopId] ? ["gmail"] : [])),
    ...(input.rei?.waiting?.some((item) => item.loopId === loopId) ? ["rei"] : []),
  ];
  const held = (blocker: Omit<Fact, "fact"> | null) => (blocker ? shut(blocker.status, blocker) : null);

  return {
    stage: steps.find((step) => step.state !== "done")?.id ?? "ready",
    degraded: issues[0] ?? null,
    steps,
    next: currentSetupStep(steps),
    gates: {
      ask: core(true, true) ?? OPEN,
      connectApps: core(false, false) ?? OPEN,
      switchOn: (loopId) => core(false, true)
        ?? held(pack ? nextBlocker(pack, input.agencySetup, loopId, name(loopId)) : switchOnBlocker(input.agencySetup, loopId, name(loopId)))
        ?? OPEN,
      // A run reads its sources now: a Gmail that needs attention or an REI sign-out holds only the work that reads it.
      runNow: (loopId) => {
        const gate = core(false, true) ?? held(switchOnBlocker(input.agencySetup, loopId, name(loopId)));
        if (gate) return gate;
        const needs = reads(loopId);
        const gmail = issue("gmail");
        if (gmail && needs.includes("gmail")) return fromIssue(gmail);
        const rei = issue("reiExpired");
        return rei && needs.includes("rei") ? fromIssue(rei) : OPEN;
      },
    },
  };
}
