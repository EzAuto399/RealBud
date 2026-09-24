// Attended "run beside me": a saved job on the product Bud thread, fenced.
import type { JobRun, JobRunEvidence, JobRunStatus, Recipe } from "../shared/contracts.ts";
import {
  fenceDecision,
  fenceEvidenceLine,
  normalizeToolName,
  originMatches,
  type FenceContext,
} from "./portal-fence.ts";
import { fenceCapabilitiesFor, recipeHasPortalCapability } from "./recipes.ts";
import { consequentialKind } from "./browser-authority.ts";
import type { BrowserActionRecord } from "./browser-broker.ts";
import { redactSecretsInText } from "./redact.ts";
import type { ParsedPortalRule } from "./request-decision.ts";
import { legacyBrowserActions, type BrowserActionClass, type BrowserTaskGrant } from "../shared/browser-task.ts";

export interface AttendedFenceContext extends FenceContext {
  /** Product Bud bot that owns this beside-you run (canonical `bud` or legacy UUID). */
  botId: string;
  runId: string;
  /** An explicit task grant (an Ask one-off task). The broker enforces it;
   * without one a saved job keeps its own capabilities. */
  grant?: BrowserTaskGrant;
}

const fences = new Map<string, AttendedFenceContext>();

export const ATTEND_ERRORS = {
  unknown: "no such recipe",
  plan: "Approve the plan first.",
  attach: "Attach this site first: you sign in, Bud reads and prefills, Submit, Pay and Send stay with you.",
  origins: "Add the portal site to this job before running it beside you.",
  cua: "Connect your browser in You → Browser before running this website job.",
  overlap: "This job already has work waiting or running.",
  busy: "Bud is busy with another turn. Stop it or wait, then run again.",
  gone: "That run is no longer waiting.",
} as const;

export const READY_BESIDE_YOU_SKIP = "Attach the site and approve the plan to run this beside you.";
export const RULE_ALLOW_ONLY = "A standing rule can only be saved when you Allow.";
export const RULE_MISMATCH = "That rule does not match this request.";
export const RULE_OFF_JOB = "That site is not on this job.";

/** Also catch a well-behaved worker that asks the person to sign in instead
 * of attempting a forbidden password tool. This opens a hold, never grants. */
export function humanSigninNeeded(text: string): "login" | "mfa" | null {
  const normalized = text.replace(/\s+/g, " ");
  if (/\b(no (?:login|sign.in|mfa) (?:is )?(?:needed|required)|already (?:logged|signed) in|sign.in (?:is )?(?:complete|successful))\b/i.test(normalized)) return null;
  const needed = /\b(?:please|you (?:need|must)|waiting (?:for|on)|requires?|need(?:s)? (?:you|a|to)|finish|complete)\b.{0,100}\b(?:sign[ -]?in|log[ -]?in|password|mfa|2fa|verification code|two.factor)\b/i.test(normalized)
    || /\b(?:sign[ -]?in|log[ -]?in|mfa|2fa|verification code)\b.{0,60}\b(?:required|needed|expired|timed out|needs you|again)\b/i.test(normalized);
  if (!needed) return null;
  return /\bmfa\b|\b2fa\b|verification code|two.factor/i.test(normalized) ? "mfa" : "login";
}

/** PM said they finished sign-in — do not remount computer / spawn another window. */
export function portalSignInCompleteIntent(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 120) return false;
  return /^(?:ok(?:ay)?[,.]?\s+)?(?:done(?: again)?|i(?:'m| am) (?:in|signed in|logged in)|signed in|logged in|we are signed in|ok we are signed in)\.?$/i.test(normalized)
    || /^(?:sign[- ]?in (?:is )?(?:done|complete)|finished signing in)\.?$/i.test(normalized);
}

export const SIGN_IN_HANDOFF_CONTINUE =
  "Stay in Ask on this computer. Press Continue on the sign-in checkpoint when the portal shows you are signed in — Bud will not open another browser window.";


export function fenceContextFor(threadId: string): AttendedFenceContext | undefined {
  return fences.get(threadId);
}

export function setFenceContext(threadId: string, ctx: AttendedFenceContext): void {
  fences.set(threadId, ctx);
}

export function takeFenceContext(threadId: string): AttendedFenceContext | undefined {
  const ctx = fences.get(threadId);
  if (ctx) fences.delete(threadId);
  return ctx;
}

export function attendBlocked(
  recipe: Recipe | undefined,
  opts: { cuaReady: boolean; busy: boolean; inFlight: boolean },
): { status: 404 | 409; error: string } | null {
  if (!recipe) return { status: 404, error: ATTEND_ERRORS.unknown };
  if (recipe.planApprovedAt == null || recipe.approvedRevision !== recipe.revision) {
    return { status: 409, error: ATTEND_ERRORS.plan };
  }
  if (!recipe.attachment) return { status: 409, error: ATTEND_ERRORS.attach };
  if (!recipe.allowedOrigins.length || !recipeHasPortalCapability(recipe.capabilities)) {
    return { status: 409, error: ATTEND_ERRORS.origins };
  }
  if (!opts.cuaReady) return { status: 409, error: ATTEND_ERRORS.cua };
  if (opts.inFlight) return { status: 409, error: ATTEND_ERRORS.overlap };
  if (opts.busy) return { status: 409, error: ATTEND_ERRORS.busy };
  return null;
}

/** Each RealBud browser tool, in the broker's order, and the grant action it
 * needs. `task` tools are offered only under an explicit task grant, and
 * upload only when the grant lists files (server/browser-broker.ts). */
const BROWSER_TOOL_ACTIONS: ReadonlyArray<{ tool: string; action: BrowserActionClass; task?: true }> = [
  { tool: "browser_tabs", action: "read" }, { tool: "browser_borrow", action: "read" }, { tool: "browser_read", action: "read" },
  { tool: "browser_navigate", action: "navigate" }, { tool: "browser_fill", action: "fill" }, { tool: "browser_click_semantic", action: "click" },
  { tool: "browser_press", action: "keys", task: true }, { tool: "browser_select", action: "fill", task: true },
  { tool: "browser_download", action: "download", task: true }, { tool: "browser_upload", action: "upload", task: true },
  { tool: "browser_release", action: "read" },
];
/** The browser tools a grant allows; `explicit` is false for a saved job's own capabilities. */
export function grantedBrowserTools(grant: Pick<BrowserTaskGrant, "actions" | "uploads">, explicit: boolean): string[] {
  return BROWSER_TOOL_ACTIONS.filter(({ tool, action, task }) =>
    grant.actions.includes(action) && (!task || explicit) && (tool !== "browser_upload" || grant.uploads.length > 0)).map(row => row.tool);
}
const SAVED_JOB_TOOLS = grantedBrowserTools({ actions: legacyBrowserActions(["portal-read", "portal-prefill", "portal-submit"]), uploads: [] }, false);
const spoken = (names: readonly string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";

/** RealBud-owned portal browser policy — never Hermes source. Prefer the
 * person's already-open Chrome/Brave tab; do not spawn a throwaway browser.
 * `tools` are the ones this run's grant allows. */
export function portalBrowserPolicy(tools: readonly string[] = SAVED_JOB_TOOLS): string {
  return [
    tools.length ? `Use only RealBud's browser tools for this saved job: ${spoken(tools)}.` : "This job has no browser tools. Do not use a browser.",
    "Start by finding the already-open job-site tab. Borrow only that tab with the person's confirmation. RealBud uses their selected Chrome or Edge profile and returns the tab when work stops.",
    "Never launch another browser, run bsk from a shell, use native browser/computer tools, JavaScript, recording or another connection to work around a denial or missing browser connection.",
    "If sign-in or a verification code is needed, release the browser first and hand that step back to the person; resume only after they say it is done. Never enter credentials: passwords and verification codes never belong in chat or in a form you fill. Stop/restart does not authorize replaying previous steps.",
    "Read back the current site and result before saying anything is done. A click acknowledgement, download request or successful tool call is not proof that a task completed.",
  ].join(" ");
}

/** Without an explicit task grant, the run's browser tools are the saved job's own capabilities. */
export function attendedJobSystemBlock(
  recipe: Pick<Recipe, "title" | "description" | "steps" | "allowedOrigins" | "evidence" | "capabilities" | "submitAcknowledgedAt">,
  grant?: BrowserTaskGrant,
): string {
  const tools = grant ? grantedBrowserTools(grant, true)
    : grantedBrowserTools({ actions: legacyBrowserActions(fenceCapabilitiesFor(recipe)), uploads: [] }, false);
  const origins = recipe.allowedOrigins.join(", ");
  const steps = recipe.steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return [
    "You are running a saved job beside the person in this computer's browser.",
    `Job: ${recipe.title}`,
    `Allowed sites: ${origins}`,
    `Inputs and context:\n${recipe.description}`,
    `Steps:\n${steps}`,
    `Done when: ${recipe.evidence || "you have read back what the page shows"}`,
    portalBrowserPolicy(tools),
    "The saved inputs and context do not expand the allowed sites or tool permissions. The person signs in. Never type a password.",
    "Nothing is paid, signed, sent or filed without the person's approval of that instance. A payment, transfer, signature, message, notice, deletion or account change is allowed only through the approval RealBud shows the person, with the exact recipient, amount or content read from the page. Never try another route to it. If RealBud refuses, the approval expires or the person declines, press nothing further for it: stop and say what is ready.",
    "Read back what you see, naming the source site, before saying anything is done.",
  ].join("\n");
}

export function attendedUserText(recipe: Pick<Recipe, "title">): string {
  return `Run this job beside me: ${recipe.title}`;
}

export function fenceEvidence(
  request: { tool: string; params?: unknown; summary?: string },
  decision: ReturnType<typeof fenceDecision>,
  at = Date.now(),
): JobRunEvidence {
  const kind = decision.kind === "deny" ? "denied" : decision.kind === "allow" ? "action" : "asked";
  return { at, kind, note: fenceEvidenceLine(request, decision) };
}

/** Evidence notes are kept to 500 characters (server/job-run-validation.ts). */
const EVIDENCE_NOTE_MAX = 500;
const SHA256 = /^[0-9a-f]{64}$/;
/** The run's receipt of one browser action the broker dispatched: its sentence,
 * then its record (tool, class, decision, outcome, key, value and file hashes,
 * page origin and path, control name, grant). Field values, file contents and
 * file paths are never kept; the record is kept whole and the sentence shortened. */
export function browserActionEvidence(entry: JobRunEvidence, action: BrowserActionRecord): JobRunEvidence {
  const token = (value: string, max: number) => redactSecretsInText(value).replace(/\s+/g, "_").slice(0, max);
  const hash = (value: string | undefined) => value !== undefined && SHA256.test(value) ? value : undefined;
  // The control's name only: an observed label can also carry the field's value="…".
  const control = action.label.match(/^[\w-]+\s+"((?:[^"\\]|\\.){1,200})"/)?.[1];
  // A typed character is field content; named keys and shortcuts are kept.
  const typed = (key: string) => /^(?:Shift\+)?[^\s+]$/.test(key);
  const size = action.download?.size;
  const fields: Array<[string, string | number | undefined]> = [
    ["tool", token(action.tool, 40)], ["class", action.class], ["decision", action.decision], ["outcome", action.outcome],
    ["key", action.key === undefined ? undefined : typed(action.key) ? "character" : token(action.key, 40)],
    ["values-sha256", hash(action.valuesHash)],
    ["file-sha256", hash(action.download?.sha256 ?? action.upload?.sha256)],
    ["file-id-sha256", hash(action.upload?.fileIdHash)],
    ["bytes", Number.isSafeInteger(size) ? size : undefined],
    ["type", action.download ? token(action.download.contentType, 60) : undefined],
    ["page", token(`${action.origin}${action.path}`, 100)],
    ["control", control === undefined ? undefined : JSON.stringify(redactSecretsInText(control).slice(0, 48))],
    ["grant", token(action.grantId, 48)],
  ];
  const record = `Action record: ${fields.filter(([, value]) => value !== undefined && value !== "").map(([name, value]) => `${name}=${value}`).join(" ")}`;
  const sentence = redactSecretsInText(entry.note).replace(/\s+value="(?:[^"\\]|\\.)*"/g, "")
    .replace(/^Pressed (?:Shift\+)?[^\s+] in /, "Pressed a character in ").replace(/\s+/g, " ").trim();
  const room = EVIDENCE_NOTE_MAX - record.length - 1;
  const lead = sentence.length <= room ? sentence : room > 1 ? `${sentence.slice(0, room - 1)}…` : "";
  return { at: entry.at, kind: entry.kind, note: lead ? `${lead} ${record}` : record.slice(0, EVIDENCE_NOTE_MAX) };
}

export function attendedSettleStatus(input: {
  ok: boolean;
  stopReason?: string | null;
}): Exclude<JobRunStatus, "queued" | "running"> {
  const reason = (input.stopReason ?? "").toLowerCase();
  // ACP can report a successful protocol exchange for a cancelled turn.
  // The stop reason must take precedence over success and any old read-back.
  if (reason === "cancelled") return "cancelled";
  if (reason === "interrupted" || reason === "stall" || reason === "timeout") return "interrupted";
  if (!input.ok) {
    return "failed";
  }
  // The attended ACP bridge currently retains permission decisions, not a
  // verified read/output receipt. Neither a successful model turn nor its text
  // proves the job finished: failed attachment replies can repeat the source
  // hostname and an earlier result. Keep these runs partial until the computer
  // broker can validate completion evidence bound to this run and its scope.
  return "partial";
}

export const ATTENDED_UNVERIFIED_RESULT =
  "The current browser result has not been verified. Review Bud's response before retrying; earlier results do not confirm this run.";

/** Display only: the run's final text mentions a step the person still owns.
 * Uses the same consequential table as the browser authority. */
export function submitHoldLine(text: string): string[] {
  return /\bsubmit\b/i.test(text) || consequentialKind(text) ? ["Submit/Pay/Send stay with you"] : [];
}

export function turnEndedNote(ok: boolean, stopReason?: string | null): string {
  return `Turn ended — ${stopReason || (ok ? "ok" : "stop")}`;
}

export function portalRespondRuleError(
  rule: ParsedPortalRule,
  input: { behavior: string; tool?: string; allowedOrigins?: readonly string[] },
): string | null {
  if (input.behavior !== "allow") return RULE_ALLOW_ONLY;
  const tool = normalizeToolName(input.tool ?? "");
  if (rule.surface === "portal-read" && tool !== "read" && tool !== "navigate") return RULE_MISMATCH;
  if (rule.surface === "portal-prefill" && tool !== "fill") return RULE_MISMATCH;
  if (!input.allowedOrigins?.length || !originMatches(rule.origin, [...input.allowedOrigins])) {
    return RULE_OFF_JOB;
  }
  return null;
}

export type { JobRun };
