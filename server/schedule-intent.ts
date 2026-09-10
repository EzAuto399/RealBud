/** Short-circuit Ask replies for "every Wednesday / weekly … check" asks.
 * Ask cannot flip RealBud's clock; point the PM at Schedule in one step. */
import { askBookIntent } from "./ask-book.ts";
import { parseConnectionIntent } from "./connection-intent.ts";
import { parsePortalJobIntent } from "./portal-job-intent.ts";

const WEEKDAY =
  /\b(?:every|each)\s+(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b|\bweekly\b|\bevery\s+week\b/i;

const CHECK_WORK =
  /\b(?:payment|rent|money|arrears|levy|ledger)\s+checks?\b|\bchecks?\s+(?:payment|rent|money|arrears|levy|ledger)\b|\b(?:morning\s+)?money\s+check\b/i;

const SCHEDULE_VERB =
  /\b(?:add|set(?:\s+up)?|create|make|put|schedule|remind(?:er)?|repeat(?:able)?|recurring)\b/i;

const WHOLE_BOOK =
  /\b(?:whole\s+book|all\s+(?:the\s+)?(?:properties|book)|every\s+propert(?:y|ies)|portfolio|morning\s+money)\b/i;

export interface ScheduleIntent {
  kind: "weekday-check" | "morning-money";
  weekdayHint: string | null;
}

export function parseScheduleIntent(text: string): ScheduleIntent | null {
  const trimmed = text.trim();
  if (!trimmed || askBookIntent(trimmed) || parseConnectionIntent(trimmed)) return null;
  if (parsePortalJobIntent(trimmed)) return null;
  if (!WEEKDAY.test(trimmed)) return null;
  if (!SCHEDULE_VERB.test(trimmed) && !/\bcan you\b|\bhelp me\b|\bi want\b|\bi need\b/i.test(trimmed)) {
    return null;
  }
  const weekday =
    /\b(?:every|each)\s+(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/i
      .exec(trimmed)?.[1]
      ?? (/\bweekly\b|\bevery\s+week\b/i.test(trimmed) ? "week" : null);
  if (WHOLE_BOOK.test(trimmed) || /\bmorning\s+money\b/i.test(trimmed)) {
    return { kind: "morning-money", weekdayHint: weekday };
  }
  if (!CHECK_WORK.test(trimmed)) return null;
  return { kind: "weekday-check", weekdayHint: weekday };
}

function cadenceLine(weekdayHint: string | null): string {
  if (!weekdayHint) return "the weekday you named";
  if (weekdayHint === "week") return "weekly";
  const lower = weekdayHint.toLowerCase();
  if (lower.startsWith("wed")) return "Wednesdays";
  if (lower.startsWith("mon")) return "Mondays";
  if (lower.startsWith("tue")) return "Tuesdays";
  if (lower.startsWith("thu")) return "Thursdays";
  if (lower.startsWith("fri")) return "Fridays";
  if (lower.startsWith("sat")) return "Saturdays";
  if (lower.startsWith("sun")) return "Sundays";
  return weekdayHint;
}

/** The existing schedule editor opens inside Ask and owns the save/approval. */
export function scheduleIntentReply(text: string): string | null {
  const intent = parseScheduleIntent(text);
  if (!intent) return null;
  const when = cadenceLine(intent.weekdayHint);
  return `Let’s review the ${intent.kind === "morning-money" ? "Morning money" : "payment"} check for ${when}. Open **Schedule work** here to choose the time and approve the plan. Nothing is scheduled yet.`;
}
