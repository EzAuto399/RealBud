import type { JobCapability, Recipe } from "./desk";

export interface JobPlanFields {
  title: string;
  description: string;
  steps: string;
  origins: string;
  evidence: string;
  capabilities: JobCapability[];
  scheduled: boolean;
  time: string;
  weekdays: number[];
}

/** Only in app memory until Save; never put PM descriptions in browser storage. */
export interface JobDraftState {
  text: string;
  plan: Recipe | null;
  fields: JobPlanFields | null;
  saved: boolean;
}

export const EMPTY_JOB_DRAFT: JobDraftState = { text: "", plan: null, fields: null, saved: false };

export const JOB_ABILITY_LABELS: Record<JobCapability, string> = {
  "read-book": "Read this office's book",
  "read-files": "Read workroom files",
  "web-research": "Research the public web",
  analyse: "Compare and analyse facts",
  draft: "Prepare drafts for review",
  "portal-read": "Read the named portal",
  "portal-prefill": "Prefill portal forms",
  "portal-submit": "Ask before each permitted Submit",
};

export function jobPlanFields(plan: Recipe): JobPlanFields {
  return {
    title: plan.title,
    description: plan.description,
    steps: plan.steps.join("\n"),
    origins: plan.allowedOrigins.join("\n"),
    evidence: plan.evidence,
    capabilities: [...plan.capabilities],
    scheduled: plan.schedule != null,
    time: plan.schedule?.time ?? "09:00",
    weekdays: [...(plan.schedule?.weekdays ?? [1, 2, 3, 4, 5])],
  };
}

export function jobPlanChanged(plan: Recipe, fields: JobPlanFields): boolean {
  return JSON.stringify(jobPlanFields(plan)) !== JSON.stringify(fields);
}

export function jobPlanInput(
  plan: Recipe,
  fields: JobPlanFields,
  saved: boolean,
): Recipe & { expectedRevision: number } {
  const steps = fields.steps
    .split("\n")
    .map((step) => step.trim())
    .filter(Boolean);
  if (!fields.title.trim() || fields.title.trim().length > 80)
    throw new Error("Give this job a name of up to 80 characters.");
  if (fields.description.trim().length > 4000)
    throw new Error("Keep the inputs and context within 4,000 characters.");
  if (!steps.length || steps.length > 12 || steps.some((step) => step.length > 200)) {
    throw new Error("Write 1 to 12 steps, one per line, with up to 200 characters each.");
  }
  if (!fields.capabilities.length) throw new Error("Choose at least one ability under Sources and permissions.");
  if (
    fields.scheduled &&
    (!/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.time) ||
      !fields.weekdays.length ||
      fields.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
  ) {
    throw new Error("Choose a valid time and at least one day, or choose Only when I run it.");
  }
  return {
    ...plan,
    title: fields.title.trim(),
    description: fields.description.trim(),
    steps,
    allowedOrigins: fields.origins
      .split(/[\n,]/)
      .map((origin) => origin.trim())
      .filter(Boolean),
    evidence: fields.evidence.trim(),
    capabilities: fields.capabilities,
    schedule: fields.scheduled ? { time: fields.time, weekdays: fields.weekdays } : null,
    expectedRevision: saved ? plan.revision : 0,
  };
}
