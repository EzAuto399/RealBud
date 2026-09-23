import type { Recipe } from "../shared/contracts.ts";
import { BROWSER_ACTION_CLASSES, browserTaskSite, type BrowserActionClass } from "../shared/browser-task.ts";

import { askBookIntent } from "./ask-book.ts";
import { parseConnectionIntent } from "./connection-intent.ts";
import { normalizeOrigin } from "./recipes.ts";

export interface PortalJobIntent {
  site: string | null;
  task: string;
  origins: string[];
}

const ACTION =
  /\b(?:log[\s-]?in|login|sign[\s-]?in|go\s+to|open|check|download|export|pull|submit|lodge|upload|fill\s+(?:in|out)|complet(?:e|ing)|finish(?:ing)?|do|run|take\s+over|sort\s+(?:things\s+)?out|handle|process|reconcile|pay\s+attention\s+to)\b/i;

/** A login verb is the one signal strong enough to carry a weak target
 * ("login to it and finish the routine"). */
const LOGIN_VERB = /\b(?:log[\s-]?in|login|sign[\s-]?in)\b/i;
const PREPARATION_START = /^(?:(?:please|ok|okay|so)\s+)*(?:draft|write|prepare|compare|analy[sz]e|research|summari[sz]e|review|calculate)\b/i;
// Explicit tool transport/discovery belongs to the real worker, even when
// its scope mentions a portal or says not to sign in to an account.
const CONNECTED_TOOL_REQUEST = /\b(?:mcp|model\s+context\s+protocol|composio(?:_[a-z0-9_]+)?|apis?|connected[\s-]+apps?|(?:gmail|outlook)_[a-z0-9_]+)\b/i;

/** Unambiguously a website. */
const STRONG_TARGET =
  /\b(?:portals?|websites?|web\s+sites?|bank(?:ing)?|strata|command\s+centr(?:e|er)|dashboards?)\b/i;

/** Words a PM also uses about the book ("check the account for Oak",
 * "do the weekly letter"); they only count next to a login verb. */
const WEAK_TARGET = /\b(?:sites?|online|accounts?|the\s+routine|the\s+(?:weekly|monthly))\b/i;

const FILE_TLD = /^(pdf|csv|xls|xlsx|png|jpe?g|gif|txt|docx?|zip|json|md|html?)$/i;

const QUESTION_START =
  /^(what|who|when|where|why|how|can|could|would|should|is|are|may|might|does|did|do\s+you)\b/i;

const HOST_TOKEN = /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi;

const PROPER_SITE =
  /\b((?:[A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*)*))\s+(?:command\s+centr(?:e|er)|portal|centre|center|online|bank|strata)\b/;

/** Schedule owns both recurring and on-demand job plans. */
function placeFor(_recipe: Pick<Recipe, "schedule">): string {
  return "Schedule";
}

const EXISTING_JOB =
  (title: string, site: string, place: string) =>
    `**${title}** is already a saved job for ${site}. Open ${place} and press **Run beside me** — you sign in when the page asks, I do the steps, and Submit, Pay and Send stay with you.`;

const DRAFT_INTRO = "I can take this over as a saved job. Here's the plan:";
const BOUNDARY =
  "You sign in yourself, I read and prefill, and Submit, Pay and Send stay with you. Press **Approve the plan** here in Ask, then **Run beside me**.";
const DRAFT_DOWN =
  "I can take this over as a saved job, but Bud's model isn't answering right now. Finish Bud on You, then say this again or open Schedule → Teach Bud a job to write the steps yourself.";

/** Strip pasted tokens and anything after password/pass: — never echo secrets. */
function stripPortalSecrets(text: string): string {
  return text
    .replace(/\bpass(?:word)?\s*[:\s]\s*\S+/gi, "password")
    .replace(/\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}

/** A polite frame around one action ("Can you …?", "Please …", "I need you
 * to …"). Anchored at the start so a frame inside quoted or forwarded prose
 * never counts. */
const POLITE_FRAME =
  /^(?:(?:ok(?:ay)?|so|hey|hi|bud)[\s,]+)*(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+|kindly\s+)?(?:be\s+able\s+to\s+)?|are\s+you\s+able\s+to\s+|i(?:\s+(?:need|want|would\s+like)|['\u2019]d\s+like)\s+you\s+to\s+)/i;
/** What follows the frame must itself be the action ("can you open …"), not
 * a request for information ("can you tell me how to open …"). */
const ACTION_START = new RegExp(`^(?:(?:please|just|kindly)\\s+|go\\s+ahead\\s+and\\s+)*${ACTION.source}`, "i");
const COURTESY_TAIL =
  /(?:[\s,;.!]*\b(?:thanks(?:\s+(?:so\s+much|a\s+lot|heaps))?|thank\s+you(?:\s+(?:so\s+much|very\s+much))?|thx|ta|cheers|please|pls)\b)?[\s,;.!]*$/i;
/** Forwarded mail and reply quotes are material to review, never instructions. */
const FORWARDED = /^\s*(?:>|(?:fwd?|fw)\s*:|-{2,}\s*(?:forwarded|original)\s+message|begin\s+forwarded\s+message|(?:from|sent|to|subject|date)\s*:)/im;
/** Quoted spans ("Levy Summary", “can you open …”). */
const QUOTED_SPAN = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g;

/** A quoted instruction is somebody else's words, never the PM's request. */
function quotesAnInstruction(text: string): boolean {
  return (text.match(QUOTED_SPAN) ?? []).some((span) => ACTION.test(span));
}

function stripCourtesyTail(text: string): string {
  let out = text.trim();
  for (let previous = ""; previous !== out;) {
    previous = out;
    out = out.replace(COURTESY_TAIL, "").trim();
  }
  return out;
}

/** "Can you open this portal and download the report? Thanks" reads as the
 * imperative "Open this portal and download the report". Returns the
 * imperative, or null when the text is not one politely framed action. */
function imperativeFrom(text: string): string | null {
  let body = stripCourtesyTail(text);
  const frame = POLITE_FRAME.exec(body);
  if (!frame) return body || null;
  body = stripCourtesyTail(body.slice(frame[0].length).replace(/\?$/, ""));
  // One request per message: a second question stays a question.
  if (!body || body.includes("?") || !ACTION_START.test(body)) return null;
  return body.charAt(0).toUpperCase() + body.slice(1);
}

function isQuestion(text: string): boolean {
  const trimmed = text.trim();
  return /\?\s*$/.test(trimmed) || QUESTION_START.test(trimmed);
}

function originsIn(text: string): string[] {
  const origins: string[] = [];
  for (const raw of text.match(HOST_TOKEN) ?? []) {
    const host = normalizeOrigin(raw);
    if (!host) continue;
    const tld = host.slice(host.lastIndexOf(".") + 1);
    if (FILE_TLD.test(tld)) continue;
    if (!origins.includes(host)) origins.push(host);
  }
  return origins;
}

function siteFromPhrase(text: string): string | null {
  const match = PROPER_SITE.exec(text);
  const phrase = match?.[1]?.trim();
  return phrase || null;
}

function findExisting(intent: PortalJobIntent, recipes: Recipe[]): Recipe | undefined {
  const site = intent.site?.toLowerCase();
  return recipes.find((recipe) => {
    if (site) {
      const title = recipe.title.toLowerCase();
      if (title === site || title.includes(site)) return true;
    }
    return intent.origins.some((origin) => recipe.allowedOrigins.includes(origin));
  });
}

function formatSteps(steps: string[]): string {
  const lines = steps.slice(0, 8).map((step, index) => `${index + 1}. ${step}`);
  if (steps.length > 8) lines.push("…");
  return lines.join("\n");
}

export function parsePortalJobIntent(text: string): PortalJobIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Rich requests belong to the worker. Quoted results and attachments must
  // not create or select a portal job through a keyword shortcut.
  if (/<pasted-text\b|<attached-file\b/i.test(trimmed)) return null;
  if (FORWARDED.test(trimmed) || quotesAnInstruction(trimmed)) return null;
  if (CONNECTED_TOOL_REQUEST.test(trimmed)) return null;
  if (askBookIntent(trimmed)) return null;
  if (parseConnectionIntent(trimmed)) return null;
  const request = imperativeFrom(trimmed);
  if (!request) return null;
  if (PREPARATION_START.test(request) || /^(?:please\s+)?(?:do not|don't|never)\b/i.test(request)) return null;
  if (isQuestion(request)) return null;
  // A prohibition such as "Do not call tools" is not a request to do portal
  // work, even when the surrounding draft mentions a supplier's bank details.
  // Route from the opening request, never verbs or portal names buried in
  // subsequent receipts, bank extracts or other pasted prose. Keep dots in
  // hostnames intact. Longer instructions still reach the real worker.
  const openingRequest = request.split(/[.!?](?=\s)|[\r\n]/, 1)[0];
  const positiveRequest = openingRequest.replace(/\b(?:do\s+not|don't|never)\b[^.!?;\n]*(?:[.!?;]|$)/gi, "");
  if (!ACTION.test(positiveRequest)) return null;

  const origins = originsIn(positiveRequest);
  const named =
    origins.length > 0 ||
    STRONG_TARGET.test(positiveRequest) ||
    PROPER_SITE.test(positiveRequest) ||
    (LOGIN_VERB.test(positiveRequest) && WEAK_TARGET.test(positiveRequest));
  if (!named) return null;

  const site = origins[0] ?? siteFromPhrase(positiveRequest);
  return { site, task: request, origins };
}

// ── one-off browser tasks ────────────────────────────────────────────────
/** A concrete thing to do on a site now. */
const ONE_OFF =
  /\b(?:download|export|pull|submit|lodge|upload|attach|fill\s+(?:in|out)|check|open|go\s+to|look\s+up|find|view|get|print|read)\b/i;
/** Recurring or take-over work stays a saved job ("finish the levy routine",
 * "check the bank every Monday", "sort things out for me"). */
const ROUTINE =
  /\b(?:routines?|every\s+\w+|each\s+(?:day|week|fortnight|month|morning|quarter)|daily|weekly|fortnightly|monthly|quarterly|take\s+over|sort\s+(?:things\s+)?out|from\s+now\s+on|regularly|schedule[ds]?|as\s+a\s+(?:saved\s+)?job)\b/i;
const DOWNLOAD_STEP = /\b(?:download|export|pull|print|save\s+(?:a\s+)?cop(?:y|ies))\b/i;
const FILL_STEP = /\b(?:fill(?:\s+(?:in|out))?|enter|type|submit|lodge)\b/i;
const SUBMIT_STEP = /\b(?:submit|lodge)\b/i;
const UPLOAD_STEP = /\b(?:upload|attach)\b/i;
const SEARCH_STEP = /\b(?:search|look\s+up|find)\b/i;
/** Site words specific enough to pick one saved job's site ("the strata portal"). */
const SITE_WORD = /\b(strata|bank(?:ing)?|command\s+centr(?:e|er))\b/gi;

export interface BrowserTaskIntent {
  /** The person's request as an imperative, with pasted secrets removed. */
  request: string;
  /** Exact HTTPS hosts: named in the request, or the matched saved job's site. */
  sites: string[];
  siteSource: "request" | "saved-job" | "none";
  savedJob: { id: string; title: string } | null;
  actions: BrowserActionClass[];
}

/** What the request needs in the browser. Reading, opening pages and
 * following links are always part of a site task; everything else only when
 * the request asks for it. Consequential steps are never in this list: each
 * one is asked separately. Searching types into a box and presses Enter. */
export function browserTaskActions(request: string): BrowserActionClass[] {
  const wanted = new Set<BrowserActionClass>(["read", "navigate", "click"]);
  if (DOWNLOAD_STEP.test(request)) wanted.add("download");
  if (FILL_STEP.test(request) || SEARCH_STEP.test(request)) wanted.add("fill");
  if (SEARCH_STEP.test(request)) wanted.add("keys");
  if (SUBMIT_STEP.test(request)) wanted.add("submit");
  if (UPLOAD_STEP.test(request)) wanted.add("upload");
  return BROWSER_ACTION_CLASSES.filter(action => wanted.has(action));
}

function savedSite(intent: PortalJobIntent, recipes: Recipe[]): Recipe | undefined {
  const sites = (recipe: Recipe) => recipe.allowedOrigins.filter(browserTaskSite);
  const existing = findExisting(intent, recipes);
  if (existing && sites(existing).length) return existing;
  if (intent.origins.length) return undefined;
  const words = [...new Set((intent.task.match(SITE_WORD) ?? []).map(word => word.toLowerCase().replace(/\s+/g, " ").replace(/ing$/, "")))];
  if (!words.length) return undefined;
  const matches = recipes.filter(recipe => sites(recipe).length &&
    words.some(word => recipe.title.toLowerCase().includes(word) || sites(recipe).some(site => site.includes(word.replace(/\s+/g, "")))));
  // Two saved jobs could mean two sites: the person names the site instead.
  return matches.length === 1 ? matches[0] : undefined;
}

/** A one-off site request ("Download this month's invoices from the strata
 * portal", "Can you submit this maintenance request on the portal?") that
 * the person can authorise once in Ask. Questions, quoted or forwarded text,
 * and routine or take-over work never become one. */
export function browserTaskIntent(text: string, recipes: () => Recipe[]): BrowserTaskIntent | null {
  const intent = parsePortalJobIntent(text);
  if (!intent) return null;
  if (!ONE_OFF.test(intent.task) || ROUTINE.test(intent.task)) return null;
  const request = stripPortalSecrets(intent.task).trim().slice(0, 2000);
  const named = intent.origins.filter(browserTaskSite).slice(0, 20);
  const saved = named.length ? undefined : savedSite(intent, recipes());
  const sites = named.length ? named : saved ? saved.allowedOrigins.filter(browserTaskSite).slice(0, 20) : [];
  return {
    request,
    sites,
    siteSource: named.length ? "request" : saved ? "saved-job" : "none",
    savedJob: saved ? { id: saved.id, title: stripPortalSecrets(saved.title).slice(0, 200) } : null,
    actions: browserTaskActions(request),
  };
}

export async function portalJobIntentReply(
  text: string,
  deps: {
    recipes: () => Recipe[];
    draft: (text: string) => Promise<Recipe>;
    save: (draft: Recipe) => Recipe;
  },
): Promise<{ reply: string; recipeId?: string } | null> {
  const intent = parsePortalJobIntent(text);
  if (!intent) return null;

  const existing = findExisting(intent, deps.recipes());
  if (existing) {
    const site = intent.site ?? intent.origins[0] ?? existing.title;
    return { reply: stripPortalSecrets(EXISTING_JOB(existing.title, site, placeFor(existing))), recipeId: existing.id };
  }

  try {
    const saved = deps.save(await deps.draft(intent.task));
    const origins = saved.allowedOrigins.length ? saved.allowedOrigins : intent.origins;
    const siteLine = origins.length ? origins.join(", ") : "add the portal address on the job card before Run beside me";
    const reply = [
      DRAFT_INTRO,
      `**${saved.title}**`,
      formatSteps(saved.steps),
      `Site: ${siteLine}`,
      `Done when: ${saved.evidence}`,
      BOUNDARY,
    ].join("\n");
    return { reply: stripPortalSecrets(reply), recipeId: saved.id };
  } catch {
    return { reply: DRAFT_DOWN };
  }
}
