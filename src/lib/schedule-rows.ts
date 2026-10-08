// Pure row state for the Schedule job list. One row per job: plain next-run
// text, at most one attention word and one action. No healthy-state chip and
// no run commentary; the detail drawer owns explanations and decisions.
import type { JobRun, Recipe } from "./desk";
import type { Loop, LoopRun } from "./routines";
import { relativeAgo } from "./au";
import { isAttendedMode } from "./job-run";
import { findRecipeForLoop, recipeNeedsPlanApproval } from "./portal-job";

export type AttentionWord = "Failed" | "Missed" | "Interrupted" | "Incomplete" | "Review" | "Unverified" | "Unconfirmed";
export type RowActionKind =
  | "view-result"
  | "run-now"
  | "resume"
  | "review-result"
  | "review-plan"
  | "start-beside"
  | "stop"
  | "view-progress"
  | "check-previous"
  | "review-bank";

export const ROW_ACTION_LABELS: Record<RowActionKind, string> = {
  "view-result": "View result",
  "run-now": "Run now",
  resume: "Resume",
  "review-result": "Review result",
  "review-plan": "Review plan",
  "start-beside": "Start beside me",
  stop: "Stop",
  "view-progress": "View progress",
  "check-previous": "Check previous run",
  "review-bank": "Review bank file",
};

/** Row actions that change work. They wait while scheduled work is held for
 * recovery; opening a result and Stop never do. */
const MUTATING_ACTIONS: ReadonlySet<RowActionKind> = new Set(["run-now", "resume", "check-previous", "start-beside"]);

export const SCHEDULE_NOT_CONFIRMED = "Schedule not confirmed";
export const RECOVERY_NOTICE = "Scheduled work is paused for recovery. Saved results are still available.";

export interface ScheduleRow {
  key: string;
  name: string;
  loop?: Loop;
  recipe?: Recipe;
  next: string;
  /** When the latest run that started last finished (or started); null if none has. */
  lastRunAt: number | null;
  attention: AttentionWord | null;
  /** The unreviewed receipt behind the attention word, so opening the job can
   * acknowledge exactly that run. */
  attentionRun?: { kind: "loop" | "job"; id: string };
  action: RowActionKind;
  actionLabel: string;
  actionDisabled: boolean;
  /** Bank review is manual until its automated download is qualified: no
   * Run now, no timing, no schedule claims. */
  manualOnly?: boolean;
  /** 0 running or needs attention, 1 upcoming, 2 paused. */
  group: 0 | 1 | 2;
  sortAt: number;
}

export interface ScheduleRowInput {
  loops: readonly Loop[];
  recipes: readonly Recipe[];
  loopRuns: readonly LoopRun[];
  jobRuns: readonly JobRun[];
  /** Loops with a manual request whose reply was lost (manual-loop-request). */
  pendingLoops?: ReadonlySet<string>;
  /** Saved jobs with a manual request whose reply was lost (manual-job-request). */
  pendingJobs?: ReadonlySet<string>;
  recovery?: boolean;
  nowMs: number;
  /** The confirmed book timezone. Without it (and without a zone on the job's
   * own schedule) next-run text reads "Schedule not confirmed". */
  timeZone?: string;
}

const FAILURE_WORDS: Record<string, AttentionWord> = {
  failed: "Failed",
  missed: "Missed",
  interrupted: "Interrupted",
  partial: "Incomplete",
};

/** Secondary text under the next run, so a fresh result reads differently from an old one. */
export const lastRunText = (lastRunAt: number | null, nowMs: number) => (lastRunAt == null ? "Never run" : `Last run ${relativeAgo(lastRunAt, nowMs)}`);

/** Queued, still-running and missed receipts are not a run that happened yet. */
function latestRunAt(runs: readonly { status: string; createdAt: number; startedAt?: number; finishedAt?: number }[]): number | null {
  let last: number | null = null;
  for (const run of runs) {
    const t = ["queued", "running", "missed"].includes(run.status) ? undefined : run.finishedAt ?? run.startedAt ?? run.createdAt;
    if (t != null && (last == null || t > last)) last = t;
  }
  return last;
}

type Issue = { word: AttentionWord; severity: number; at: number; kind: "loop" | "job"; id: string };
const at = (run: { startedAt?: number; createdAt: number }) => run.startedAt ?? run.createdAt;

function loopIssue(run: LoopRun): Issue | null {
  if (run.seenAt) return null;
  const word = FAILURE_WORDS[run.status];
  if (word) return { word, severity: 2, at: at(run), kind: "loop", id: run.id };
  if (run.status === "awaiting-approval") return { word: "Review", severity: 1, at: at(run), kind: "loop", id: run.id };
  return null;
}

function jobIssue(run: JobRun, acknowledged: boolean): Issue | null {
  if (acknowledged) return null;
  if (isAttendedMode(run.mode)) {
    // Website results are never verified from the run's own report.
    if (["completed", "partial", "unknown"].includes(run.status)) return { word: "Unverified", severity: 0, at: at(run), kind: "job", id: run.id };
    const word = FAILURE_WORDS[run.status];
    return word ? { word, severity: 2, at: at(run), kind: "job", id: run.id } : null;
  }
  const word = FAILURE_WORDS[run.status];
  if (word) return { word, severity: 2, at: at(run), kind: "job", id: run.id };
  if (run.status === "awaiting-approval") return { word: "Review", severity: 1, at: at(run), kind: "job", id: run.id };
  return null;
}

/** "Today, 7:30 am", "Tomorrow, 7:30 am", "Friday, 4:00 pm" or "Fri 10 Oct, 4:00 pm"
 * in the confirmed timezone. A missing or unreadable zone is never replaced by
 * this computer's zone. */
export function nextRunText(ms: number, nowMs: number, timeZone: string | undefined): string {
  if (!timeZone) return SCHEDULE_NOT_CONFIRMED;
  try {
    const dayKey = (value: number) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
    const days = Math.round((Date.parse(dayKey(ms)) - Date.parse(dayKey(nowMs))) / 86_400_000);
    const time = new Intl.DateTimeFormat("en-AU", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(ms).replace(/\s/g, " ");
    const day = days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : days > 1 && days < 7
          ? new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "long" }).format(ms)
          : new Intl.DateTimeFormat("en-AU", { timeZone, weekday: "short", day: "numeric", month: "short" }).format(ms).replace(",", "");
    return `${day}, ${time}`;
  } catch {
    return SCHEDULE_NOT_CONFIRMED;
  }
}

function buildRow(input: ScheduleRowInput, loop: Loop | undefined, recipe: Recipe | undefined, manualOnly = false): ScheduleRow {
  const name = recipe?.title || loop?.name || "Untitled job";
  const loopRuns = loop ? input.loopRuns.filter((run) => run.loopId === loop.id) : [];
  const jobRuns = recipe ? input.jobRuns.filter((run) => run.jobId === recipe.id) : [];
  const jobIds = new Set(jobRuns.map((run) => run.id));
  // A taught job's clock receipt wraps its richer job receipt; count the work once.
  const ownLoopRuns = loopRuns.filter((run) => !run.jobRunId || !jobIds.has(run.jobRunId));
  const linkedSeen = new Set(input.loopRuns.filter((run) => run.jobRunId && run.seenAt).map((run) => run.jobRunId!));

  const issues = [
    ...ownLoopRuns.map(loopIssue),
    ...jobRuns.map((run) => jobIssue(run, Boolean(run.seenAt) || linkedSeen.has(run.id))),
  ].filter((issue): issue is Issue => issue !== null);
  // The most serious unreviewed receipt wins, even after a later success or a pause.
  issues.sort((a, b) => b.severity - a.severity || b.at - a.at);
  const issue = issues[0];

  const attendedRunning = jobRuns.some((run) => isAttendedMode(run.mode) && run.status === "running");
  const attendedQueued = jobRuns.some((run) => isAttendedMode(run.mode) && run.status === "queued");
  const otherRunning =
    ownLoopRuns.some((run) => run.status === "queued" || run.status === "running") ||
    jobRuns.some((run) => !isAttendedMode(run.mode) && (run.status === "queued" || run.status === "running"));
  const pending = Boolean((loop && input.pendingLoops?.has(loop.id)) || (recipe && input.pendingJobs?.has(recipe.id)));
  const needsPlan = recipe ? recipeNeedsPlanApproval(recipe) : Boolean(loop?.waitingForPlan);
  const paused = recipe ? recipe.status === "paused" : Boolean(loop && !loop.enabled);
  const hasResult = loopRuns.length > 0 || jobRuns.length > 0;

  const scheduled = loop && loop.enabled && !needsPlan && !paused
    ? loop.nextRunAt != null
      ? nextRunText(loop.nextRunAt, input.nowMs, loop.schedule.timezone || input.timeZone)
      : loop.timezonePaused ? "Paused" : SCHEDULE_NOT_CONFIRMED
    : recipe && !loop
      ? recipe.schedule ? SCHEDULE_NOT_CONFIRMED : "Only when you run it"
      : SCHEDULE_NOT_CONFIRMED;
  const baseNext = input.recovery ? "Paused" : needsPlan ? "Not scheduled" : paused ? "Paused" : scheduled;

  let next = baseNext;
  let attention: AttentionWord | null = null;
  let action: RowActionKind;
  if (manualOnly) {
    next = "On demand";
    attention = issue?.word ?? null;
    action = issue ? "review-result" : "review-bank";
  } else if (attendedRunning) {
    next = "Running now";
    action = "stop";
  } else if (pending) {
    next = "Checking last run";
    attention = "Unconfirmed";
    action = "check-previous";
  } else if (attendedQueued) {
    next = "Waiting for you";
    action = "start-beside";
  } else if (otherRunning) {
    next = "Running now";
    action = "view-progress";
  } else if (needsPlan) {
    attention = "Review";
    action = "review-plan";
  } else if (issue) {
    attention = issue.word;
    action = "review-result";
  } else if (paused) {
    action = "resume";
  } else {
    action = hasResult ? "view-result" : "run-now";
  }

  const urgent = ["stop", "check-previous", "start-beside", "view-progress"].includes(action);
  const group: 0 | 1 | 2 = urgent || attention ? 0 : paused && !manualOnly ? 2 : 1;
  return {
    key: recipe ? `job:${recipe.id}` : `loop:${loop!.id}`,
    name,
    loop,
    recipe,
    next,
    lastRunAt: latestRunAt([...loopRuns, ...jobRuns]),
    attention,
    ...(issue && attention === issue.word ? { attentionRun: { kind: issue.kind, id: issue.id } } : {}),
    action,
    actionLabel: ROW_ACTION_LABELS[action],
    actionDisabled: Boolean(input.recovery) && MUTATING_ACTIONS.has(action),
    ...(manualOnly ? { manualOnly } : {}),
    group,
    sortAt: group === 0 ? (urgent ? 0 : 1) : !manualOnly && loop?.enabled && loop.nextRunAt != null && !paused ? loop.nextRunAt : Number.POSITIVE_INFINITY,
  };
}

/** Running and needs-attention first, then upcoming by next run, then paused. */
export function compareScheduleRows(a: ScheduleRow, b: ScheduleRow): number {
  return a.group - b.group || a.sortAt - b.sortAt || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
}

/** One inventory: today's loops (minus unavailable placeholders) and every
 * saved job, including paused, on-demand and plans awaiting approval. */
export function buildScheduleRows(input: ScheduleRowInput): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  const claimed = new Set<string>();
  for (const loop of input.loops) {
    const recipe = findRecipeForLoop(input.recipes, loop.id);
    if (recipe) claimed.add(recipe.id);
    // Bank review stays reachable as manual work while automation is unavailable.
    else if (loop.id === "bank-references" && !loop.available) { rows.push(buildRow(input, loop, undefined, true)); continue; }
    else if (loop.id.startsWith("recipe-") || !loop.available) continue;
    rows.push(buildRow(input, loop, recipe));
  }
  for (const recipe of input.recipes) if (!claimed.has(recipe.id)) rows.push(buildRow(input, undefined, recipe));
  return rows.sort(compareScheduleRows);
}

/** Rows the Schedule list shows: a hidden loop (an Auston loop before its role pack) stays out of the list only. */
export const listedScheduleRows = (rows: readonly ScheduleRow[], hiddenLoops: ReadonlySet<string>) => rows.filter((row) => !row.loop || !hiddenLoops.has(row.loop.id));
/** `#job-<id>`: a saved job or a loop, looked up in ALL rows so a deep link (the sidebar, the status bar) opens a hidden loop too. */
export const scheduleRowForJob = (rows: readonly ScheduleRow[], id: string) => rows.find((row) => row.key === `job:${id}`) ?? rows.find((row) => row.loop?.id === id);

/** Keep the order a person is looking at while they interact: existing rows
 * stay put, removed rows drop out and new rows join the end. */
export function stableOrder(previous: readonly string[], next: readonly string[]): string[] {
  const present = new Set(next);
  const kept = previous.filter((key) => present.has(key));
  const seen = new Set(kept);
  return [...kept, ...next.filter((key) => !seen.has(key))];
}
