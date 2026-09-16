import type { Recipe } from "../shared/contracts.ts";

import { askBookIntent } from "./ask-book.ts";
import { parseConnectionIntent } from "./connection-intent.ts";
import { normalizeOrigin } from "./recipes.ts";

export interface PortalJobIntent {
  site: string | null;
  task: string;
  origins: string[];
}

const ACTION =
  /\b(?:log[\s-]?in|login|sign[\s-]?in|go\s+to|open|check|download|pull|complet(?:e|ing)|finish(?:ing)?|do|run|take\s+over|sort\s+(?:things\s+)?out|handle|process|reconcile|pay\s+attention\s+to)\b/i;

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
  if (CONNECTED_TOOL_REQUEST.test(trimmed)) return null;
  if (PREPARATION_START.test(trimmed) || /^(?:please\s+)?(?:do not|don't|never)\b/i.test(trimmed)) return null;
  if (askBookIntent(trimmed)) return null;
  if (parseConnectionIntent(trimmed)) return null;
  if (isQuestion(trimmed)) return null;
  // A prohibition such as "Do not call tools" is not a request to do portal
  // work, even when the surrounding draft mentions a supplier's bank details.
  // Route from the opening request, never verbs or portal names buried in
  // subsequent receipts, bank extracts or other pasted prose. Keep dots in
  // hostnames intact. Longer instructions still reach the real worker.
  const openingRequest = trimmed.split(/[.!?](?=\s)|[\r\n]/, 1)[0];
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
  return { site, task: trimmed, origins };
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
    const saved = deps.save(await deps.draft(text));
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
