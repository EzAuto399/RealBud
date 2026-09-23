// Browser task authority: the one place that classifies and authorises a
// browser step. The broker calls authorizeBrowserAction for every action;
// server/index.ts only displays the broker's decision. Consequential actions
// (pay, sign, send, notice, delete, account change) are never allowed by a
// grant or a rule: each instance is asked once, bound to facts read from the
// page, and a fact the page does not confirm cannot be approved.
import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";
import { redactSecretsInText } from "./redact.ts";
import { portalRuleKey, portalRuleLabel, type PortalRuleSurface } from "./rules.ts";
import {
  BROWSER_CONSEQUENTIAL_POLICY,
  BROWSER_TASK_GRANT_PURPOSE,
  BROWSER_TASK_GRANT_VERSION,
  browserTaskSite,
  legacyBrowserActions,
  parseBrowserTaskGrant,
  type BrowserActionClass,
  type BrowserConsequentialKind,
  type BrowserTaskGrant,
} from "../shared/browser-task.ts";
import type { BrowserCheckpoint } from "../shared/browser.ts";

// ── one table for every route ────────────────────────────────────────────
/** Words that make a control, link or field consequential, checked in order.
 * This is the union of the earlier broker, portal-fence and attended-run lists. */
export const CONSEQUENTIAL_ACTIONS: ReadonlyArray<{ kind: BrowserConsequentialKind; pattern: RegExp }> = [
  { kind: "pay", pattern: /\b(pay|payment|transfer|remit|bpay|direct debit|purchase|buy|trade|execute|authori[sz]e|approve)\b|(?<!\bin )\border\b/i },
  { kind: "sign", pattern: /\b(?:e-?sign|signature|sign(?![ -]?(?:in|on|up|out)\b))\b/i },
  { kind: "notice", pattern: /\b(notice|terminate|evict)\b/i },
  { kind: "send", pattern: /\bsend\b/i },
  { kind: "delete", pattern: /\b(delete|remove)\b/i },
  { kind: "account-change", pattern: /\b(close account|beneficiary|payee|cancel|unsubscribe|log.?out|sign.?out|sign.?up)\b/i },
];
export function consequentialKind(text: string): BrowserConsequentialKind | null {
  return CONSEQUENTIAL_ACTIONS.find(row => row.pattern.test(text))?.kind ?? null;
}
/** Credential and payment-instrument fields, and sign-in controls, stay with the person. */
export const CREDENTIAL_FIELD = /password|passcode|\botp\b|one.time|verification code|\bmfa\b|\b2fa\b|security code|\bpin\b|card number|\bcvv\b|\bbsb\b|account number/i;
export const SIGN_IN_CONTROL = /\b(sign.?in|log.?in|sign.?on)\b/i;
export const FINANCIAL_PAGE = /\b(bank|banking|transaction|statement|balance|account number|bpay|bsb)\b/i;
export const SUBMIT_CONTROL = /\b(submit|save|continue|next|confirm|lodge|create|update)\b/i;
const AFFIRMATIVE = /\b(yes|ok|okay|proceed|agree|accept|finish|done|complete)\b/i;
const READ_AFFORDANCE = /\b(view|show|statement|transaction|history|download|export|search|filter|previous|next page)\b/i;
/** Words that say a control delivers a file rather than acting on something. */
const DOWNLOAD_AFFORDANCE = /\b(download|export|pdf|csv|xlsx?|docx?|zip|print|receipt|statement|invoice|report|attachment|save as)\b/i;
const TEXT_ROLE = /^(textbox|searchbox|textarea|editable|textfield)$/;
const CHOICE_ROLE = /^(combobox|listbox|option|radio|radiogroup|slider|spinbutton|menuitemradio)$/;
/** Page evidence that an affirmative control completes a consequential action. */
const PAGE_KINDS: ReadonlyArray<{ kind: BrowserConsequentialKind; test: (text: string) => boolean }> = [
  { kind: "pay", test: text => moneyIn(text).length > 0 && /\b(payee|pay to|biller|beneficiary|recipient|transfer to|payment method)\b/i.test(text) },
  { kind: "sign", test: text => /\b(sign here|signature|e-?sign|docusign|sign (?:the|this) (?:document|agreement|lease|contract|form))\b/i.test(text) },
  { kind: "notice", test: text => /\b(notice to (?:vacate|leave|remedy)|breach notice|termination notice|notice of (?:termination|breach|eviction|rent increase)|terminate (?:the|this) (?:lease|tenancy|agreement))\b/i.test(text) },
  { kind: "send", test: text => /\btextbox\s+"(?:to|recipients?)"/i.test(text) && /\btextbox\s+"(?:subject|message|body)"/i.test(text) },
  { kind: "delete", test: text => /\b(are you sure you want to (?:delete|remove)|permanently (?:delete|remove))\b/i.test(text) },
  { kind: "account-change", test: text => /\b(close (?:your|this) account|change (?:your )?password|update (?:your )?(?:bank|payment) details|add (?:a )?(?:new )?payee)\b/i.test(text) },
];
export const pageConsequentialKind = (text: string): BrowserConsequentialKind | null => PAGE_KINDS.find(row => row.test(text))?.kind ?? null;

export const SUBMIT_STAYS_WITH_YOU = "Submit, Pay and Send stay with you.";
export const SUBMIT_JOB_DENY = "This job cannot press Submit. Add 'Bud may press Submit' on the job if it should.";
export function submitPressSummary(label: string, origin: string): string {
  return `Bud wants to press '${label}' on ${origin}. Check the form in the browser first.`;
}
const NAVIGATE_OUT = "Open this page yourself. Bud can only navigate within the job's exact HTTPS site, without account-changing links.";
const STALE_CONTROL = "Read the page again before choosing a control. The previous reference is no longer current.";
const CREDENTIAL = "This account, payment or security step stays with the person. Stop browser work before they take over.";
const FINANCIAL_FILL = "This page is for reading. Enter bank and financial details yourself.";
const READ_ONLY = "This job is read-only. Add prefill on Schedule if Bud should fill forms.";
const KEY_SPEC = "Use one key, such as Enter, Tab, Escape or an arrow key, with optional Ctrl, Alt, Shift or Meta.";
const CHOICES = "Choose one to twenty option values from the observed list.";
const UPLOAD_NOT_GRANTED = "Only files given to this task can be uploaded. Ask the person to add the file to the task.";
const ASK_ONCE = "Bud asks before this step, once, with the details shown on the page.";

// ── page and URL helpers (shared with the broker) ────────────────────────
export const browserLoginFields = (text: string): boolean => text.split("\n").some(line => /\b(input|textbox|password|editable)\b/i.test(line) && /password|passcode|\botp\b|one.time|verification code|\bmfa\b|\b2fa\b|security code|\bpin\b/i.test(line));
export function jobBrowserUrl(value: unknown, origins: readonly string[]): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".") ||
      isIP(url.hostname) !== 0 || /\.(local|localhost|internal|lan)$/.test(url.hostname) || url.port && url.port !== "443") return null;
    const allowed = origins.some(origin => {
      try { return new URL(origin.includes("://") ? origin : `https://${origin}`).origin === url.origin; } catch { return false; }
    });
    return allowed ? url : null;
  } catch { return null; }
}
export function observationRefs(text: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(?:[-│├└─ ]*)?(@e\d+)\s+(.+)$/);
    if (match && !refs.has(match[1])) refs.set(match[1], match[2].slice(0, 1000));
  }
  return refs;
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, "");
function siteFor(grant: BrowserTaskGrant, url: URL): string {
  const host = hostOf(url);
  return grant.sites.map(site => site.replace(/^https:\/\//, "").replace(/\/$/, "").toLowerCase().replace(/^www\./, ""))
    .find(site => host === site || host.endsWith(`.${site}`)) ?? host;
}

// ── grants ───────────────────────────────────────────────────────────────
/** A saved job with no explicit grant: exactly its earlier capabilities. */
export function legacyBrowserGrant(input: { runId: string; allowedOrigins: readonly string[]; capabilities: readonly string[]; checkpoint?: BrowserCheckpoint }): BrowserTaskGrant {
  const text = `Saved job browser capabilities: ${[...input.capabilities].filter(c => c.startsWith("portal-")).join(", ") || "none"}`;
  return parseBrowserTaskGrant({
    version: BROWSER_TASK_GRANT_VERSION,
    purpose: BROWSER_TASK_GRANT_PURPOSE,
    id: `legacy-${sha256(input.runId).slice(0, 32)}`,
    runId: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(input.runId) ? input.runId : `run-${sha256(input.runId).slice(0, 32)}`,
    route: input.checkpoint ? "recovery" : "job",
    request: { text, sha256: sha256(text) },
    sites: [...new Set(input.allowedOrigins.filter(browserTaskSite))].slice(0, 20),
    browser: { id: input.checkpoint?.browserId ?? null, accountMarker: input.checkpoint?.accountMarker ?? null },
    actions: legacyBrowserActions(input.capabilities),
    consequential: BROWSER_CONSEQUENTIAL_POLICY,
    uploads: [],
    expiresAt: null,
    budget: null,
  });
}

// ── keys ─────────────────────────────────────────────────────────────────
const KEY_NAMES: Record<string, string> = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", space: "Space", backspace: "Backspace", delete: "Delete",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
};
const MODIFIERS: Record<string, string> = { ctrl: "Ctrl", control: "Ctrl", alt: "Alt", option: "Alt", shift: "Shift", meta: "Meta", cmd: "Meta", command: "Meta" };
const NAVIGATION_KEYS = new Set(["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
const named = (table: Record<string, string>, name: string): string | undefined => Object.hasOwn(table, name.toLowerCase()) ? table[name.toLowerCase()] : undefined;
export interface BrowserKey { spec: string; key: string; modifiers: string[] }
/** One key with optional modifiers, in the helper's spelling. Anything else is refused. */
export function browserKey(value: unknown): BrowserKey | null {
  if (typeof value !== "string" || value.length > 40 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const parts = value.split("+").map(part => part.trim());
  const base = parts.pop() ?? "";
  const modifiers = parts.map(part => named(MODIFIERS, part));
  if (modifiers.some(modifier => !modifier) || new Set(modifiers).size !== modifiers.length) return null;
  const key = named(KEY_NAMES, base) ?? (/^[A-Za-z0-9.,;'`=/\\[\]]$/.test(base) ? base : null);
  if (!key) return null;
  const ordered = ["Ctrl", "Alt", "Shift", "Meta"].filter(modifier => modifiers.includes(modifier));
  return { spec: [...ordered, key].join("+"), key, modifiers: ordered };
}
/** Option values for a dropdown: data from the model, checked for shape only. */
export function browserChoices(value: unknown): string[] | null {
  return Array.isArray(value) && value.length >= 1 && value.length <= 20 &&
    value.every(item => typeof item === "string" && item.length <= 200 && !/[\u0000-\u001f\u007f]/.test(item)) ? [...value as string[]] : null;
}

// ── classification ───────────────────────────────────────────────────────
export type BrowserStep = "list" | "borrow" | "read" | "navigate" | "fill" | "click" | "press" | "select" | "download" | "upload" | "release";
export type BrowserClassification =
  | { class: "routine"; step: BrowserStep; action: BrowserActionClass; label?: string }
  | { class: "consequential"; step: BrowserStep; kind: BrowserConsequentialKind; label?: string; reason: string }
  | { class: "credential"; step: BrowserStep; reason: string }
  | { class: "out-of-scope"; step: BrowserStep | null; reason: string }
  | { class: "unknown"; step: BrowserStep; label: string; reason: string };
export interface BrowserObservation { url: string; text?: string }
type Args = Record<string, unknown>;

const STEPS: Record<string, BrowserStep> = {
  tabs: "list", borrow: "borrow", read: "read", navigate: "navigate", fill: "fill", click_semantic: "click",
  press: "press", select: "select", download: "download", upload: "upload", release: "release",
};
/** The grant's action class each newer tool needs before its effect is weighed. */
const TOOL_ACTIONS: Partial<Record<BrowserStep, BrowserActionClass>> = { press: "keys", select: "fill", download: "download", upload: "upload" };
/** Steps whose consequential instance can be approved once, bound to the page's facts. */
const APPROVABLE: ReadonlySet<BrowserStep> = new Set(["click", "press", "select"]);
export function browserStep(tool: string): BrowserStep | null {
  const name = tool.trim().toLowerCase().replace(/^mcp__[^_]+__/, "").replace(/^browser_/, "");
  return Object.hasOwn(STEPS, name) ? STEPS[name] : null;
}

export function classifyBrowserAction(grant: BrowserTaskGrant, observation: BrowserObservation | null, tool: string, args: Args): BrowserClassification {
  const step = browserStep(tool);
  if (!step) return { class: "out-of-scope", step: null, reason: "This browser tool or its arguments are not available." };
  if (step === "list" || step === "release") return { class: "routine", step, action: "read" };
  const current = observation ? jobBrowserUrl(observation.url, grant.sites) : null;
  if (!current) return { class: "out-of-scope", step, reason: "That tab is outside this job or is no longer borrowed. Stop and choose the intended page again." };
  if (step === "borrow" || step === "read") return { class: "routine", step, action: "read" };
  if (step === "navigate") {
    const target = jobBrowserUrl(args.url, grant.sites);
    if (!target || target.origin !== current.origin || target.hash) return { class: "out-of-scope", step, reason: NAVIGATE_OUT };
    let path: string;
    try { path = decodeURIComponent(target.pathname + target.search); } catch { return { class: "out-of-scope", step, reason: NAVIGATE_OUT }; }
    const kind = consequentialKind(path);
    // A link cannot show the facts of the action, so it is never the approval point.
    return kind ? { class: "consequential", step, kind, reason: NAVIGATE_OUT } : { class: "routine", step, action: "navigate" };
  }
  const text = observation?.text ?? "";
  const ref = typeof args.ref === "string" ? args.ref : "";
  const label = /^@e\d+$/.test(ref) ? observationRefs(text).get(ref) : undefined;
  if (!label) return { class: "out-of-scope", step, reason: STALE_CONTROL };
  if (grant.browser.accountMarker && !text.includes(grant.browser.accountMarker)) {
    return { class: "out-of-scope", step, reason: "The verified account label is no longer visible. Check the account and page before continuing." };
  }
  if (CREDENTIAL_FIELD.test(label) || SIGN_IN_CONTROL.test(label)) return { class: "credential", step, reason: CREDENTIAL };
  const financial = FINANCIAL_PAGE.test(`${text} ${observation?.url ?? ""}`);
  const kind = consequentialKind(label);
  if (step === "fill") {
    if (typeof args.value !== "string" || args.value.length > 2000 || /[\x00-\x1f]/.test(args.value)) return { class: "out-of-scope", step, reason: "Use one ordinary field value without key presses." };
    if (kind) return { class: "consequential", step, kind, label, reason: CREDENTIAL };
    if (financial) return { class: "consequential", step, kind: "pay", label, reason: FINANCIAL_FILL };
    return { class: "routine", step, action: "fill", label };
  }
  const control: Control = { step, label, text, financial, kind };
  if (step === "press") {
    const key = browserKey(args.key);
    return key ? pressKey(control, key) : { class: "out-of-scope", step, reason: KEY_SPEC };
  }
  if (step === "select") {
    const values = browserChoices(args.values);
    return values ? choose(control, values) : { class: "out-of-scope", step, reason: CHOICES };
  }
  if (step === "download") return download(control);
  if (step === "upload") {
    const granted = typeof args.file === "string" && grant.uploads.some(file => file.name === args.file);
    if (!granted) return { class: "out-of-scope", step, reason: UPLOAD_NOT_GRANTED };
    // The upload itself submits nothing, but the person should see the form it joins.
    if (kind || financial || pageConsequentialKind(text)) return { class: "unknown", step, label, reason: "This page can pay, sign, send or change an account. Uploading does not submit it; check the form before approving." };
    return { class: "routine", step, action: "upload", label };
  }
  return pressControl(control);
}

type Control = { step: BrowserStep; label: string; text: string; financial: boolean; kind: BrowserConsequentialKind | null };
const roleOf = (label: string) => label.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
/** A control being pressed: a click, or Enter or Space on a button or link. */
function pressControl({ step, label, text, financial, kind }: Control): BrowserClassification {
  if (kind) return { class: "consequential", step, kind, label, reason: ASK_ONCE };
  const affirmative = SUBMIT_CONTROL.test(label) || AFFIRMATIVE.test(label);
  if (financial) {
    // On a bank page, a confirming step may move money; reading stays routine.
    if (affirmative) return { class: "consequential", step, kind: "pay", label, reason: ASK_ONCE };
    if (READ_AFFORDANCE.test(label)) return { class: "routine", step, action: "click", label };
    return { class: "unknown", step, label, reason: "Bud could not tell what this control does on a financial page." };
  }
  const pageKind = affirmative ? pageConsequentialKind(text) : null;
  if (pageKind) return { class: "consequential", step, kind: pageKind, label, reason: ASK_ONCE };
  if (SUBMIT_CONTROL.test(label)) return { class: "routine", step, action: "submit", label };
  return { class: "routine", step, action: "click", label };
}
/** A form submitted without its button (Enter in a field, a save shortcut): exactly like its submit. */
function submitForm({ step, label, text, financial, kind }: Control): BrowserClassification {
  const pageKind = kind ?? (financial ? "pay" : pageConsequentialKind(text));
  if (pageKind) return { class: "consequential", step, kind: pageKind, label, reason: ASK_ONCE };
  return { class: "routine", step, action: "submit", label };
}
/** A dropdown or choice change. A change can submit its form, so a form with
 * consequential signals is treated like its submit; a bank page asks. */
function choose({ step, label, text, financial, kind }: Control, values: string[]): BrowserClassification {
  const effect = kind ?? consequentialKind(values.join(" ")) ?? pageConsequentialKind(text);
  if (effect) return { class: "consequential", step, kind: effect, label, reason: ASK_ONCE };
  if (financial) return { class: "unknown", step, label, reason: "Bud could not tell whether this choice submits a form on a financial page." };
  return { class: "routine", step, action: "fill", label };
}
function pressKey(control: Control, key: BrowserKey): BrowserClassification {
  const { step, label } = control;
  const role = roleOf(label); const text = TEXT_ROLE.test(role); const choice = CHOICE_ROLE.test(role);
  const command = key.modifiers.includes("Ctrl") || key.modifiers.includes("Meta");
  const shortcut = command || key.modifiers.includes("Alt");
  if (command && /^[vx]$/i.test(key.key)) return { class: "out-of-scope", step, reason: "Pasting and cutting stay with the person. Use browser_fill with a reviewed value." };
  if (key.key === "Enter" || (command && /^s$/i.test(key.key))) {
    if (key.key === "Enter" && !text && !choice) return pressControl(control);
    // Searching reads; any other Enter in a field submits the form it belongs to.
    const search = key.key === "Enter" && !command && (role === "searchbox" || /\bsearch\b/i.test(label));
    if (search && !control.kind && !control.financial && !pageConsequentialKind(control.text)) return { class: "routine", step, action: "keys", label };
    return submitForm(control);
  }
  if (key.key === "Space" && !text && !shortcut) return choice ? choose(control, []) : pressControl(control);
  if (shortcut) return { class: "unknown", step, label, reason: "Bud could not tell what this shortcut does on the page." };
  if (NAVIGATION_KEYS.has(key.key)) {
    if (choice && key.key !== "Tab" && key.key !== "Escape") return choose(control, []);
    return { class: "routine", step, action: "keys", label };
  }
  // A character, Space, Backspace or Delete.
  if (text) {
    if (control.kind || control.financial) return { class: "out-of-scope", step, reason: control.kind ? CREDENTIAL : FINANCIAL_FILL };
    return { class: "routine", step, action: "fill", label };
  }
  if (choice) return choose(control, []);
  if (key.key === "Delete" || key.key === "Backspace") return { class: "consequential", step, kind: "delete", label, reason: ASK_ONCE };
  return { class: "unknown", step, label, reason: "Bud could not tell what this key does outside a text field." };
}
/** Downloading is reading, unless the control would also act. */
function download({ step, label, text, financial, kind }: Control): BrowserClassification {
  const affirmative = SUBMIT_CONTROL.test(label) || AFFIRMATIVE.test(label);
  const effect = kind ?? (affirmative ? (financial ? "pay" : pageConsequentialKind(text)) : null);
  if (!effect) return { class: "routine", step, action: "download", label };
  if (DOWNLOAD_AFFORDANCE.test(label)) return { class: "unknown", step, label, reason: "Bud could not tell whether this control only downloads a file." };
  return { class: "consequential", step, kind: effect, label, reason: "This control may do more than download a file. Use the reviewed click step, which asks the person once." };
}

// ── verified facts ───────────────────────────────────────────────────────
export type BrowserFactName = "recipient" | "amount" | "currency" | "reference" | "document" | "documentHash" | "to" | "subject" | "bodyHash" | "bodyExcerpt" | "target";
export interface BrowserApprovalFact { name: BrowserFactName; value: string | null; confirmed: boolean }
export interface BrowserApprovalDraft {
  kind: BrowserConsequentialKind;
  origin: string;
  /** Origin and path only; a query can carry tokens. */
  url: string;
  control: { ref: string; label: string };
  facts: BrowserApprovalFact[];
  unconfirmed: BrowserFactName[];
  observationHash: string;
  /** Binds the approval to the kind, site, control and confirmed facts. */
  fingerprint: string;
  /** Kind, site and confirmed facts only: an unknown outcome blocks the same
   * effect through any control, key or dropdown, not just the one pressed. */
  effect: string;
  expiresAt: number;
  summary: string;
}
export const BROWSER_APPROVAL_TTL_MS = 120_000;

const CODES = "AUD|USD|NZD|GBP|EUR|CAD|SGD|HKD|JPY";
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const MONEY = new RegExp(String.raw`(?:\b(${CODES})\s?)?([$£€])\s?(${NUMBER})(?![\d,])(?:\s?(${CODES})\b)?|\b(${CODES})\s?(${NUMBER})(?![\d,])`, "gi");
function moneyIn(text: string): Array<{ amount: string; currency: string }> {
  return [...text.matchAll(MONEY)].map(match => ({
    amount: (match[3] ?? match[6]).replace(/,/g, ""),
    currency: (match[1] ?? match[4] ?? match[5])?.toUpperCase() ?? match[2],
  }));
}
type Pair = { label: string; value: string };
function observedPairs(text: string): Pair[] {
  const pairs: Pair[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*[-│├└─ ]*/, "").trim();
    const field = line.match(/^(?:@e\d+\s+)?[\w-]+\s+"([^"]{1,200})"\s+value="([^"]{0,2000})"/);
    if (field) { pairs.push({ label: field[1].trim(), value: field[2].trim() }); continue; }
    const content = line.replace(/^@e\d+\s+[\w-]+\s+/, "").replace(/^"(.*)"$/, "$1");
    const pair = content.match(/^([A-Za-z][A-Za-z0-9 /()#&.'-]{0,60}?)\s*:\s+(\S.{0,299})$/);
    if (pair) pairs.push({ label: pair[1].trim(), value: pair[2].trim().replace(/^"(.*)"$/, "$1") });
  }
  return pairs;
}
function headings(text: string): string[] {
  return [...new Set(text.split("\n").map(line => line.match(/^\s*(?:[-│├└─ ]*)?(?:@e\d+\s+)?heading\b[^"]*"([^"]{1,200})"/)?.[1]?.trim()).filter((v): v is string => Boolean(v)))];
}
/** Exactly one distinct value confirms a fact; none or several do not. */
function pick(pairs: Pair[], label: RegExp): { value: string | null; present: boolean } {
  const values = [...new Set(pairs.filter(pair => label.test(pair.label) && pair.value).map(pair => pair.value))];
  return { value: values.length === 1 ? values[0] : null, present: values.length > 0 };
}
function fact(name: BrowserFactName, value: string | null): BrowserApprovalFact {
  // A redacted preview must never authorise the original unseen value.
  const shown = value === null ? null : redactSecretsInText(value).slice(0, 300);
  return { name, value: shown, confirmed: value !== null && shown === value && value.trim().length > 0 };
}
function paymentFacts(text: string, pairs: Pair[]): BrowserApprovalFact[] {
  const labelled = (label: RegExp) => {
    const found = pairs.filter(pair => label.test(pair.label)).flatMap(pair => moneyIn(pair.value));
    return [...new Map(found.map(money => [`${money.currency} ${money.amount}`, money])).values()];
  };
  let amounts = labelled(/^(payment amount|transfer amount|amount to pay|you pay|you will pay|amount)$/i);
  if (!amounts.length) amounts = labelled(/^(total|total amount|total to pay|amount due)$/i);
  if (!amounts.length) amounts = [...new Map(moneyIn(text).map(money => [`${money.currency} ${money.amount}`, money])).values()];
  const money = amounts.length === 1 ? amounts[0] : null;
  const recipient = pick(pairs, /^(payee|payee name|pay to|paying|recipient|recipient name|beneficiary|biller|biller name|account name|to|to account|transfer to)$/i);
  const reference = pick(pairs, /^(reference|payment reference|ref|description|crn|customer reference(?: number)?|invoice(?: number)?)$/i);
  return [fact("recipient", recipient.value), fact("amount", money?.amount ?? null), fact("currency", money?.currency ?? null),
    ...(reference.present ? [fact("reference", reference.value)] : [])];
}
function documentFacts(text: string, pairs: Pair[]): BrowserApprovalFact[] {
  const titled = pick(pairs, /^(document|document title|document name|agreement|contract|lease|notice|title|form)$/i);
  const heads = headings(text);
  const title = titled.value ?? (!titled.present && heads.length === 1 ? heads[0] : null);
  return [fact("document", title), fact("documentHash", sha256(text.replace(/@e\d+/g, "@e")))];
}
function messageFacts(pairs: Pair[]): BrowserApprovalFact[] {
  const to = pick(pairs, /^(to|recipients?|send to|email to)$/i);
  const subject = pick(pairs, /^subject$/i);
  const body = pick(pairs, /^(message|body|email body|reply|text)$/i);
  // The hash binds the whole message; the excerpt only shows the person what is sent:
  // redacted before it is shortened, so a secret across the cut is never half shown.
  const excerpt: BrowserApprovalFact[] = body.value === null ? [] : [{ name: "bodyExcerpt", value: redactSecretsInText(body.value).slice(0, 200), confirmed: true }];
  return [fact("to", to.value), ...(subject.present ? [fact("subject", subject.value)] : []), fact("bodyHash", body.value === null ? null : sha256(body.value)), ...excerpt];
}
function targetFacts(text: string, label: string, kind: BrowserConsequentialKind): BrowserApprovalFact[] {
  const asked = [...new Set([...text.matchAll(/are you sure you want to ([^?\n"]{3,200})\?/gi)].map(match => match[1].trim()))];
  const pattern = CONSEQUENTIAL_ACTIONS.find(row => row.kind === kind)!.pattern;
  const rest = label.replace(/^\s*(button|link|menuitem)\s+/i, "").replace(/"/g, "").replace(new RegExp(pattern.source, "gi"), "").replace(/\b(now|it|this|all|the)\b/gi, "").trim();
  const target = asked.length === 1 ? asked[0] : asked.length === 0 && /[A-Za-z0-9]{2,}/.test(rest) ? rest : null;
  return [fact("target", target)];
}
const NOUNS: Record<BrowserConsequentialKind, string> = { pay: "payment", sign: "signature", send: "message", notice: "notice", delete: "deletion", "account-change": "account change" };
const FACT_WORDS: Record<BrowserFactName, string> = { recipient: "payee", amount: "amount", currency: "currency", reference: "reference", document: "document title", documentHash: "document", to: "recipient", subject: "subject", bodyHash: "message text", bodyExcerpt: "message text", target: "item it changes" };
function controlName(label: string): string {
  return label.match(/"([^"]{1,120})"/)?.[1] ?? label.slice(0, 120);
}

/** `via` names a key or dropdown choice; without it the control is pressed. */
export function browserApprovalDraft(kind: BrowserConsequentialKind, observation: BrowserObservation, ref: string, label: string, now = Date.now(), via?: string): BrowserApprovalDraft {
  const text = observation.text ?? "";
  const pairs = observedPairs(text);
  const facts = kind === "pay" ? paymentFacts(text, pairs)
    : kind === "sign" || kind === "notice" ? documentFacts(text, pairs)
      : kind === "send" ? messageFacts(pairs)
        : targetFacts(text, label, kind);
  const url = new URL(observation.url);
  const host = hostOf(url);
  const control = controlName(label);
  const value = (name: BrowserFactName) => facts.find(item => item.name === name)?.value ?? "?";
  const has = (name: BrowserFactName) => facts.some(item => item.name === name);
  const what = kind === "pay" ? `Pay ${value("currency")} ${value("amount")} to ${value("recipient")}${has("reference") ? ` (reference ${value("reference")})` : ""}`
    : kind === "sign" ? `Sign '${value("document")}'`
      : kind === "notice" ? `Issue the notice '${value("document")}'`
        : kind === "send" ? `Send the message${has("subject") ? ` '${value("subject")}'` : ""} to ${value("to")}`
          : kind === "delete" ? `Delete ${value("target")}` : `Change the account: ${value("target")}`;
  const confirmed = facts.filter(item => item.confirmed).map(item => [item.name, item.value]).sort();
  return {
    kind,
    origin: url.origin,
    url: `${url.origin}${url.pathname}`,
    control: { ref, label: control },
    facts,
    unconfirmed: facts.filter(item => !item.confirmed).map(item => item.name),
    observationHash: sha256(text),
    fingerprint: sha256(JSON.stringify(via ? [kind, url.origin, control, confirmed, via] : [kind, url.origin, control, confirmed])),
    effect: sha256(JSON.stringify([kind, url.origin, confirmed])),
    expiresAt: now + BROWSER_APPROVAL_TTL_MS,
    summary: `${what} by ${via ?? `pressing '${control}'`} on ${host}. This approval is for this one ${NOUNS[kind]} and expires in 2 minutes.`,
  };
}
const shownChoices = (values: unknown) => (browserChoices(values) ?? []).map(value => `'${redactSecretsInText(value).slice(0, 60)}'`).join(", ");
function approvalVia(step: BrowserStep, args: Args, label: string): string | undefined {
  if (step === "press") return `pressing ${browserKey(args.key)?.spec ?? "a key"} in '${controlName(label)}'`;
  if (step === "select") return `choosing ${shownChoices(args.values) || "an option"} in '${controlName(label)}', which may submit the form`;
  return undefined;
}

// ── authorisation ────────────────────────────────────────────────────────
export interface BrowserFenceProjection {
  surface: "portal-read" | "portal-prefill" | "portal-submit";
  origin: string;
  ruleOffer: { surface: PortalRuleSurface; origin: string; label: string } | null;
}
export type BrowserAuthorization =
  | { decision: "allow"; classification: BrowserClassification; fence: BrowserFenceProjection | null; note: string }
  | { decision: "ask"; classification: BrowserClassification; fence: BrowserFenceProjection; once: boolean; summary: string; draft: BrowserApprovalDraft | null }
  | { decision: "deny"; classification: BrowserClassification; reason: string; draft: BrowserApprovalDraft | null };
export interface BrowserAuthorityOptions {
  rules?: ReadonlyArray<{ key: string; decision: "allow" | "deny" }>;
  now?: number;
  /** Browser actions this grant has already dispatched. */
  used?: number;
}

function ruleAllows(rules: BrowserAuthorityOptions["rules"], surface: PortalRuleSurface, site: string, url: URL): boolean {
  const keys = new Set([portalRuleKey(surface, site), portalRuleKey(surface, hostOf(url))]);
  return (rules ?? []).some(rule => rule.decision === "allow" && keys.has(rule.key));
}
const missingAction = (action: BrowserActionClass) =>
  action === "fill" ? READ_ONLY : action === "submit" ? SUBMIT_JOB_DENY : "This task does not include that browser step. Ask again with the step you need.";

export function authorizeBrowserAction(grant: BrowserTaskGrant, observation: BrowserObservation | null, tool: string, args: Args, options: BrowserAuthorityOptions = {}): BrowserAuthorization {
  const now = options.now ?? Date.now();
  const classification = classifyBrowserAction(grant, observation, tool, args);
  const deny = (reason: string, draft: BrowserApprovalDraft | null = null): BrowserAuthorization => ({ decision: "deny", classification, reason, draft });
  if (classification.class === "credential" || classification.class === "out-of-scope") return deny(classification.reason);
  if (classification.step === "list" || classification.step === "release") return { decision: "allow", classification, fence: null, note: "" };
  if (grant.expiresAt !== null && now >= grant.expiresAt) return deny("This browser task's permission has ended. Ask again to continue.");
  if (grant.budget !== null && (options.used ?? 0) >= grant.budget) return deny("This browser task reached its step limit. Stop and review progress.");
  const url = new URL(observation!.url);
  const site = siteFor(grant, url);
  const host = hostOf(url);
  const label = "label" in classification && classification.label ? controlName(classification.label) : "";
  // A newer tool needs its own class first: Enter is never a way round a missing keys grant.
  const toolAction = classification.step ? TOOL_ACTIONS[classification.step] : undefined;
  if (toolAction && !grant.actions.includes(toolAction)) return deny(missingAction(toolAction));
  if (classification.class === "consequential") {
    // Only an observed control (pressed, keyed or chosen) can be bound to the page's facts.
    if (!APPROVABLE.has(classification.step)) return deny(classification.reason);
    if (!toolAction && !grant.actions.includes("click")) return deny(missingAction("click"));
    const draft = browserApprovalDraft(classification.kind, observation!, String(args.ref), classification.label!, now, approvalVia(classification.step, args, classification.label!));
    if (draft.unconfirmed.length) {
      const missing = [...new Set(draft.unconfirmed.map(name => FACT_WORDS[name]))].join(", ");
      return deny(`Bud could not confirm the ${missing} on this page, so this ${NOUNS[classification.kind]} cannot be approved. It stays with the person.`, draft);
    }
    return { decision: "ask", classification, once: true, summary: draft.summary, draft, fence: { surface: "portal-submit", origin: site, ruleOffer: null } };
  }
  const key = classification.step === "press" ? browserKey(args.key)!.spec : "";
  if (classification.class === "unknown") {
    if (!toolAction && !grant.actions.includes("click")) return deny(missingAction("click"));
    const what = classification.step === "press" ? `Press ${key} in ${label} on ${host}.`
      : classification.step === "select" ? `Choose ${shownChoices(args.values)} in ${label} on ${host}.`
        : classification.step === "download" ? `Download the file from ${label} on ${host}.`
          : classification.step === "upload" ? `Upload the task's file '${String(args.file)}' into ${label} on ${host}.` : `Use ${label} on ${host}.`;
    return { decision: "ask", classification, once: true, draft: null, fence: { surface: classification.step === "upload" ? "portal-prefill" : "portal-read", origin: site, ruleOffer: null },
      summary: `${what} ${classification.reason} This approval applies once.` };
  }
  const { action, step } = classification;
  if (!grant.actions.includes(action)) return deny(missingAction(action));
  const surface: PortalRuleSurface | "portal-submit" = action === "fill" || action === "upload" ? "portal-prefill" : action === "submit" ? "portal-submit" : "portal-read";
  // Downloading is reading; keys, dropdowns and uploads always ask.
  const rulable = step === "borrow" || step === "read" || step === "navigate" || step === "fill" || step === "download";
  if (rulable && surface !== "portal-submit" && ruleAllows(options.rules, surface, site, url)) {
    return { decision: "allow", classification, fence: { surface, origin: site, ruleOffer: null }, note: `allowed by rule · ${portalRuleLabel(surface, site)}` };
  }
  const target = step === "navigate" ? jobBrowserUrl(args.url, grant.sites) : null;
  const summary = step === "borrow" ? `Use the existing tab on ${url.hostname} for this saved job. The browser will also ask for confirmation.`
    : step === "read" ? `Read the current page on ${url.hostname} for this job.`
      : step === "navigate" ? `Open ${target!.hostname}${target!.pathname} in this job's borrowed tab.`
        : step === "fill" ? `Prepare the field ${classification.label} on ${url.hostname}.`
          : step === "press" ? (action === "submit" ? `Bud wants to press ${key} in '${label}' on ${site}. Check the form in the browser first.` : `Press ${key} in ${classification.label} on ${url.hostname}.`)
            : step === "select" ? `Choose ${shownChoices(args.values)} in ${classification.label} on ${url.hostname}.`
              : step === "download" ? `Download the file from ${classification.label} on ${url.hostname} into this task's private folder.`
                : step === "upload" ? `Upload the task's file '${String(args.file)}' into ${classification.label} on ${url.hostname}.`
                  : action === "submit" ? submitPressSummary(label, site) : `Use ${classification.label} on ${url.hostname}.`;
  return {
    decision: "ask", classification, once: false, draft: null, summary,
    fence: { surface, origin: site, ruleOffer: rulable && surface !== "portal-submit" ? { surface, origin: site, label: portalRuleLabel(surface, site) } : null },
  };
}

// ── persisted approval records ───────────────────────────────────────────
/** `stopped`: browser work was stopped while the card was still open and unexpired, which is not a refusal. */
export type BrowserApprovalDecision = "pending" | "approved" | "denied" | "expired" | "changed" | "unconfirmed" | "stopped";
export type BrowserApprovalOutcome = "not-dispatched" | "dispatching" | "succeeded" | "unknown";
export interface BrowserApprovalRecord extends BrowserApprovalDraft {
  version: 1;
  purpose: "browser-approval";
  id: string;
  grantId: string;
  runId: string;
  threadId: string;
  createdAt: number;
  decidedAt: number | null;
  decision: BrowserApprovalDecision;
  outcome: BrowserApprovalOutcome;
}
const DECISIONS: readonly BrowserApprovalDecision[] = ["pending", "approved", "denied", "expired", "changed", "unconfirmed", "stopped"];
const OUTCOMES: readonly BrowserApprovalOutcome[] = ["not-dispatched", "dispatching", "succeeded", "unknown"];
const MAX_RECORDS = 500;
const MAX_BYTES = 4_000_000;
/** An approved action whose result is unknown blocks the same action for a day. */
export const UNRESOLVED_HOLD_MS = 24 * 60 * 60_000;
const RECOVERY = "Browser approval history needs recovery. Approval-gated browser steps are paused. Check disk space and file access, then restart RealBud.";
const recovery = () => Object.assign(new Error(RECOVERY), { status: 503 });
function validRecord(value: unknown): value is BrowserApprovalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1 && row.purpose === "browser-approval" && typeof row.id === "string" && /^[0-9a-f-]{36}$/.test(row.id) &&
    typeof row.fingerprint === "string" && /^[0-9a-f]{64}$/.test(row.fingerprint) && typeof row.origin === "string" &&
    // Records saved before the effect hash existed still match by fingerprint.
    (row.effect === undefined || typeof row.effect === "string" && /^[0-9a-f]{64}$/.test(row.effect)) &&
    typeof row.createdAt === "number" && typeof row.expiresAt === "number" && Array.isArray(row.facts) &&
    DECISIONS.includes(row.decision as BrowserApprovalDecision) && OUTCOMES.includes(row.outcome as BrowserApprovalOutcome);
}
function parseStore(value: unknown): BrowserApprovalRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw recovery();
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || row.purpose !== "browser-approvals" || !Array.isArray(row.approvals) || row.approvals.length > MAX_RECORDS || !row.approvals.every(validRecord)) throw recovery();
  return row.approvals.map(item => structuredClone(item));
}

export class BrowserApprovalStore {
  private rows: BrowserApprovalRecord[] | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  constructor(options: { file?: string } = {}) { this.file = options.file ?? join(DATA_DIR, "browser-approvals.json"); }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work); this.chain = next.catch(() => {}); return next;
  }
  private async load(): Promise<BrowserApprovalRecord[]> {
    if (this.rows) return this.rows;
    let saved: unknown;
    try { saved = await readPrivateJson(this.file, MAX_BYTES); } catch { throw recovery(); }
    this.rows = saved === undefined ? [] : parseStore(saved);
    return this.rows;
  }
  private async save(rows: BrowserApprovalRecord[]): Promise<void> {
    try { await writePrivateJson(this.file, { version: 1, purpose: "browser-approvals", approvals: rows }, { maxBytes: MAX_BYTES, validate: parseStore }); }
    catch (error) { this.rows = null; throw error; }
    this.rows = rows;
  }
  /** Persisted before any approval card is shown. */
  create(draft: BrowserApprovalDraft, owner: { grantId: string; runId: string; threadId: string }, decision: "pending" | "unconfirmed", now = Date.now()): Promise<BrowserApprovalRecord> {
    return this.exclusive(async () => {
      const rows = [...await this.load()];
      const record: BrowserApprovalRecord = {
        ...structuredClone(draft), version: 1, purpose: "browser-approval", id: randomUUID(), ...owner,
        createdAt: now, decidedAt: decision === "pending" ? null : now, decision, outcome: "not-dispatched",
      };
      rows.push(record);
      while (rows.length > MAX_RECORDS) {
        const settled = rows.findIndex(row => row.outcome !== "dispatching" && row.outcome !== "unknown");
        rows.splice(settled < 0 ? 0 : settled, 1);
      }
      await this.save(rows);
      return structuredClone(record);
    });
  }
  update(id: string, patch: Partial<Pick<BrowserApprovalRecord, "decision" | "outcome" | "decidedAt">>): Promise<BrowserApprovalRecord> {
    return this.exclusive(async () => {
      const rows = (await this.load()).map(row => row.id === id ? { ...row, ...patch } : row);
      const record = rows.find(row => row.id === id);
      if (!record) throw recovery();
      await this.save(rows);
      return structuredClone(record);
    });
  }
  /** An earlier approval of the same action, or of the same effect through
   * another control or key, whose result was never confirmed. */
  unresolved(fingerprint: string, now = Date.now(), effect?: string): Promise<BrowserApprovalRecord | undefined> {
    return this.exclusive(async () => {
      const row = (await this.load()).find(item => (item.fingerprint === fingerprint || (effect !== undefined && item.effect === effect)) &&
        (item.outcome === "dispatching" || item.outcome === "unknown") && now - item.createdAt < UNRESOLVED_HOLD_MS);
      return row ? structuredClone(row) : undefined;
    });
  }
  list(): Promise<BrowserApprovalRecord[]> {
    return this.exclusive(async () => structuredClone(await this.load()));
  }
}
let defaultStore: BrowserApprovalStore | null = null;
export const browserApprovals = (): BrowserApprovalStore => (defaultStore ??= new BrowserApprovalStore());
