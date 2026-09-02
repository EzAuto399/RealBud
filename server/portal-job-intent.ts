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

/** Where the PM will find the job card: scheduled jobs sit on Schedule,
 * unscheduled ones under You → Bud's jobs. The reply must point at the
 * right door or the chip lands on an empty page. */
function placeFor(recipe: Pick<Recipe, "schedule">): string {
  return recipe.schedule ? "Schedule" : "You → Bud's jobs";
}

const EXISTING_JOB =
  (title: string, site: string, place: string) =>
    `**${title}** is already a saved job for ${site}. Open ${place} and press **Run beside me** — you sign in when the page asks, I do the steps, and Submit or Pay stays with you.`;

const DRAFT_INTRO = "I can take this over as a saved job. Here's the plan:";
const BOUNDARY = (place: string) =>
  `You sign in yourself, I read and prefill, and Submit, Pay and Send stay with you. Approve the plan on ${place}, then press **Run beside me**.`;
const DRAFT_DOWN =
  "I can take this over as a saved job, but Bud's model isn't answering right now. Finish Bud on You, then say this again or describe it on Schedule → Give Bud any recurring job.";

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
  if (askBookIntent(trimmed)) return null;
  if (parseConnectionIntent(trimmed)) return null;
  if (isQuestion(trimmed)) return null;
  if (!ACTION.test(trimmed)) return null;

  const origins = originsIn(trimmed);
  const named =
    origins.length > 0 ||
    STRONG_TARGET.test(trimmed) ||
    PROPER_SITE.test(trimmed) ||
    (LOGIN_VERB.test(trimmed) && WEAK_TARGET.test(trimmed));
  if (!named) return null;

  const site = origins[0] ?? siteFromPhrase(trimmed);
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
    const place = placeFor(saved);
    const siteLine = origins.length ? origins.join(", ") : `add the portal address on ${place}`;
    const reply = [
      DRAFT_INTRO,
      formatSteps(saved.steps),
      `Site: ${siteLine}`,
      `Done when: ${saved.evidence}`,
      BOUNDARY(place),
    ].join("\n");
    return { reply: stripPortalSecrets(reply), recipeId: saved.id };
  } catch {
    return { reply: DRAFT_DOWN };
  }
}
