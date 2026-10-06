// Read-only summary of the office's Schedule jobs for a Work turn, so Bud can
// answer "what does the weekly bills job do?" from the same list the Schedule
// screen shows. Names, state, cadence and the catalog's own one-line purpose
// only: no run results, source data or credentials. Bounded in size.
import type { Loop } from "../shared/contracts.ts";
import { redactSecretsInText } from "./redact.ts";

const MAX_JOBS = 20;
const MAX_PURPOSE = 240;
const MAX_NAME = 80;
const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const clip = (text: string, max: number) => {
  const flat = redactSecretsInText(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

/** First sentence of the catalog description, clipped. */
function purpose(description: string): string {
  const first = description.replace(/\s+/g, " ").trim().match(/^.+?[.!?](?=\s|$)/)?.[0] ?? description;
  return clip(first, MAX_PURPOSE);
}

function clock(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${(h! % 12) || 12}:${String(m).padStart(2, "0")} ${h! < 12 ? "am" : "pm"}`;
}

function cadence(schedule: Loop["schedule"]): string {
  const at = clock(schedule.time);
  if (schedule.monthly === "first-weekday") return `first weekday of each month at ${at}`;
  const days = [...schedule.weekdays].sort((a, b) => a - b);
  const which = days.length === 7 ? "every day" : days.join(",") === "1,2,3,4,5" ? "weekdays"
    : days.length === 1 ? DAYS[days[0]!]! : days.map(day => SHORT[day]).join(", ");
  if (schedule.intervalDays && schedule.intervalDays > 1) {
    return days.length === 7 ? `every ${schedule.intervalDays} days at ${at}` : `${which}, every ${schedule.intervalDays} days, at ${at}`;
  }
  return `${which} at ${at}`;
}

function nextRun(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString();
  }
}

function state(loop: Loop): string {
  if (!loop.available) return "not on the clock (run by hand from Schedule)";
  if (!loop.enabled) return "off (paused)";
  if (loop.waitingForPlan) return "on, but waiting for its plan to be approved on Schedule";
  if (loop.timezonePaused) return "on, but held until the office time zone is confirmed on Schedule";
  return "on";
}

/** The same jobs the Schedule screen lists (it hides unavailable catalog
 * placeholders, except bank review, which stays reachable by hand). */
export function scheduleJobsTurnContext(loops: readonly Loop[], opts: { timeZone: string; recovery?: boolean }): string {
  const shown = loops.filter(loop => loop.available || loop.id === "bank-references");
  const rule = "Switching a job on or off, changing its time, running it and approving its plan happen only on Schedule, done by the person. Work cannot do any of that: never say a job was switched on, run, changed or approved unless the person says they did it on Schedule. To make new work repeatable, draft it here and point them to **Make this repeatable**.";
  if (shown.length === 0) {
    return `Schedule jobs: this office has no jobs on Schedule yet. Do not describe any scheduled job or workflow as set up. ${rule}`;
  }
  const lines = shown.slice(0, MAX_JOBS).map(loop => {
    const zone = loop.schedule.timezone ?? opts.timeZone;
    const when = !loop.available ? "no clock" : `${cadence(loop.schedule)}${zone !== opts.timeZone ? ` ${zone} time` : ""}`;
    const next = loop.available && loop.enabled && loop.nextRunAt != null && !opts.recovery ? `; next run ${nextRun(loop.nextRunAt, zone)}` : "";
    return `- ${clip(loop.name, MAX_NAME)}: ${state(loop)}; ${when}${next}. ${purpose(loop.description)}`;
  });
  const more = shown.length > MAX_JOBS ? [`- …and ${shown.length - MAX_JOBS} more on Schedule.`] : [];
  return [
    `Schedule jobs for this office (${shown.length}, read-only, as the Schedule screen shows them now; times in ${opts.timeZone} unless a job names its own zone). These are the office's workflows: answer questions about them from this list, and do not say a listed job does not exist.`,
    ...(opts.recovery ? ["Schedule is paused for recovery, so no job runs until the person restores it."] : []),
    ...lines,
    ...more,
    rule,
  ].join("\n");
}
