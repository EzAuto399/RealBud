import { recipeNeedsPlanApproval } from "./portal-job";
import { SCHEDULE_NOT_CONFIRMED, type ScheduleRow } from "./schedule-rows";

export type ScheduleSection = "running" | "attention" | "ready" | "paused";
export type ScheduleFilter = "all" | "attention" | "scheduled" | "paused";

/** Presentation only: the row remains the authority for its action and disabled state. */
export function scheduleRowSection(row: ScheduleRow): ScheduleSection {
  if (row.action === "stop" || row.action === "view-progress") return "running";
  if (row.attention || row.action === "start-beside" || row.action === "check-previous") return "attention";
  return row.group === 2 ? "paused" : "ready";
}

export function scheduleRowGuidance(row: ScheduleRow): string {
  if (row.action === "check-previous") return "Confirm the earlier request before starting another run.";
  if (row.action === "review-plan") return "Review the steps before this job can run.";
  if (row.action === "start-beside") return "This website job is waiting for you to start it.";
  if (row.action === "stop") return "Website work is running beside you.";
  if (row.action === "view-progress") return "Open this run to see its progress.";
  if (row.attention === "Failed") return "Review the failed run before trying again.";
  if (row.attention === "Missed") return "Review the missed run before choosing what to do next.";
  if (row.attention === "Interrupted") return "Check where this run stopped before trying again.";
  if (row.attention === "Incomplete") return "Review what is finished and what still needs attention.";
  if (row.attention === "Unverified") return "Check the recorded result against the website.";
  if (row.attention === "Unconfirmed") return "Confirm the earlier request before starting another run.";
  if (row.attention === "Review") return "A result is waiting for your review.";
  if (row.action === "review-bank") return "Choose a bank file to review.";
  if (row.next === "Paused" && row.action !== "resume") return "Scheduled work is paused; saved results remain available.";
  if (row.action === "resume") return "Resume this job when you want it to run again.";
  if (row.action === "view-result") return "Open the saved result to see what happened.";
  if (row.next === SCHEDULE_NOT_CONFIRMED) return "Check the job's timing before relying on a scheduled run.";
  return "Open this job when you are ready to run it.";
}

function isPaused(row: ScheduleRow): boolean {
  if (row.manualOnly) return false;
  // Paused jobs with an unreviewed failure still belong in the Paused filter.
  return row.next === "Paused" || (row.recipe ? row.recipe.status === "paused" : row.loop?.enabled === false);
}

function hasConfirmedNextRun(row: ScheduleRow): boolean {
  if (row.manualOnly || !row.loop?.enabled || !Number.isFinite(row.loop.nextRunAt) || isPaused(row)) return false;
  if (row.recipe && recipeNeedsPlanApproval(row.recipe)) return false;
  // Active and uncertain requests replace next-run text; that text no longer
  // proves the schedule has a confirmed timezone. Keep those in their own section.
  if (!["run-now", "view-result", "review-result"].includes(row.action)) return false;
  return row.next !== SCHEDULE_NOT_CONFIRMED && row.next !== "Not scheduled";
}

/** Keep the caller's stable order, row objects and action contracts intact. */
export function filterScheduleRows(rows: readonly ScheduleRow[], filter: ScheduleFilter, search = ""): ScheduleRow[] {
  const query = search.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (query && !row.name.toLocaleLowerCase().includes(query)) return false;
    if (filter === "attention") return scheduleRowSection(row) === "attention";
    if (filter === "scheduled") return hasConfirmedNextRun(row);
    if (filter === "paused") return isPaused(row);
    return true;
  });
}
