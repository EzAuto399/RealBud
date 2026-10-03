import { recipeClockRunnable, type JobRun, type Recipe } from "./desk";
import { recipeHasPortalCapability } from "./portal-job";

export const JOB_OUTCOME_EXAMPLES = [
  { title: "Morning priorities", text: "Prepare a morning brief from the inbox evidence supplied for this job. Show urgent decisions, unanswered questions, waiting follow-ups and FYIs, with message references and any missing coverage. Do not send or change messages. I would like this before work on weekdays, after I have tried and reviewed it once." },
  { title: "Weekly bill review", text: "Review the bill emails and attachments supplied for this job for Kevin. Compare them with accepted bill records; show new bills, duplicates, due dates and missing evidence. Use the example Property.csv only to understand matching and timing. Propose calendar follow-ups; do not claim bills, calendar entries or notifications were saved. I would like this weekly after a reviewed trial." },
  { title: "Read a work website", text: "Read [website address] beside me after I sign in and confirm the account. Use only permitted reading, search and filter controls. Prepare a source-linked summary of [the information I need], with gaps and questions for review. Do not change records, upload, download or submit anything. Try this once before choosing any repeat timing." },
] as const;

/** A newly generated suggestion starts on demand; its description retains the
 * requested cadence for the person to choose after seeing a result. */
export function firstTrySuggestion(plan: Recipe): Recipe {
  return { ...plan, schedule: null, status: "shadow", planApprovedAt: null, approvedRevision: null,
    attachment: null, submitAcknowledgedAt: null };
}

const material = (plan: Recipe) => JSON.stringify({ title: plan.title, description: plan.description,
  steps: plan.steps, allowedOrigins: plan.allowedOrigins, evidence: plan.evidence, capabilities: plan.capabilities,
  limits: plan.limits, siteNotes: plan.siteNotes ?? null, schedule: plan.schedule,
  attachment: plan.attachment, submitAcknowledgedAt: plan.submitAcknowledgedAt });

/** One explicit button may approve the displayed local plan and then try it.
 * A confirmed, unchanged approval receipt is required before the caller runs.
 * Browser attachment and repeat schedules keep their separate existing paths. */
export async function approveSingleTry(plan: Recipe, patch: (body: { planApproved: true; status: "active"; expectedRevision: number }) => Promise<{ recipes?: Recipe[] }>): Promise<Recipe> {
  if (plan.schedule || recipeHasPortalCapability(plan)) throw new Error("Review this job's website or repeat settings before approving it.");
  if (recipeClockRunnable(plan)) return plan;
  const result = await patch({ planApproved: true, status: "active", expectedRevision: plan.revision });
  const saved = result.recipes?.find(item => item.id === plan.id);
  if (!saved || saved.revision !== plan.revision || material(saved) !== material(plan) || !recipeClockRunnable(saved)) {
    throw new Error("The approved plan could not be confirmed. Reload the job before trying it; no run was started.");
  }
  return saved;
}

export function latestJobTrial(plan: Recipe, runs: readonly JobRun[]): JobRun | undefined {
  return runs.filter(run => run.jobId === plan.id && run.jobRevision === plan.revision && run.mode !== "shadow" &&
    !["queued", "running"].includes(run.status)).sort((a, b) => b.createdAt - a.createdAt)[0];
}
