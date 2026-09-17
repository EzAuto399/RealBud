import type { JobCapability, Recipe } from "@shared/contracts";

export type WorkflowAction = "desk" | "portal-read" | "portal-prefill";

export interface CustomWorkflow {
  outcome: string;
  time: string;
  weekdays: number[];
  site: string;
  action: WorkflowAction;
}

const HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const DESK_CAPABILITIES: JobCapability[] = ["read-book", "read-files", "web-research", "analyse", "draft"];
const READ_CAPABILITIES: JobCapability[] = ["read-book", "read-files", "web-research", "analyse", "draft", "portal-read"];
const PREFILL_CAPABILITIES: JobCapability[] = [
  "read-book",
  "read-files",
  "web-research",
  "analyse",
  "draft",
  "portal-read",
  "portal-prefill",
];

export type JobPreset = {
  id: string;
  label: string;
  hint: string;
  workflow: CustomWorkflow;
};

const WEEKDAYS = [1, 2, 3, 4, 5];

export const JOB_PRESETS: JobPreset[] = [
  {
    id: "bank",
    label: "Bank receipts",
    hint: "Add your bank host, then build.",
    workflow: {
      outcome: "Match overnight deposits to the book and put unmatched or partial payments on Desk.",
      time: "07:45",
      weekdays: WEEKDAYS,
      site: "",
      action: "portal-read",
    },
  },
  {
    id: "pms",
    label: "PMS arrears screen",
    hint: "Add the PMS host if Bud should open it.",
    workflow: {
      outcome: "Open the arrears screen, read who is unpaid, and prefill courtesy wording for review.",
      time: "07:30",
      weekdays: WEEKDAYS,
      site: "",
      action: "portal-prefill",
    },
  },
  {
    id: "inspections",
    label: "Inspection week",
    hint: "Desk only — they still walk the house.",
    workflow: {
      outcome: "List addresses due for routine inspection this week and prepare entry-notice wording to Copy. Do not invent a legal clock.",
      time: "09:00",
      weekdays: [1],
      site: "",
      action: "desk",
    },
  },
  {
    id: "renewals",
    label: "Renewals (90 days)",
    hint: "Draft offers. They send in the PMS.",
    workflow: {
      outcome: "List leases ending in 90 days and draft renewal or rent-review wording for Desk. Do not issue a notice.",
      time: "10:00",
      weekdays: [1],
      site: "",
      action: "desk",
    },
  },
  {
    id: "levy",
    label: "Levy / strata portal",
    hint: "Add the portal host.",
    workflow: {
      outcome: "Open the levy portal, read unpaid levies, and prefill the follow-up for the person to Submit.",
      time: "15:00",
      weekdays: [5],
      site: "",
      action: "portal-prefill",
    },
  },
  {
    id: "maintenance",
    label: "Maintenance classify",
    hint: "No tradie dispatch.",
    workflow: {
      outcome: "Classify open maintenance into urgent, owner-cap, or wait, and put only decisions on Desk. Do not dispatch a tradie.",
      time: "08:30",
      weekdays: WEEKDAYS,
      site: "",
      action: "desk",
    },
  },
];

const HOST_TOKEN = /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi;

export function hostInText(text: string): string | null {
  for (const raw of text.match(HOST_TOKEN) ?? []) {
    const host = normalizeWorkflowHost(raw);
    if (host) return host;
  }
  return null;
}

export function withInferredSite(workflow: CustomWorkflow): CustomWorkflow {
  const typed = normalizeWorkflowHost(workflow.site);
  if (typed) return { ...workflow, site: typed };
  const found = hostInText(workflow.outcome);
  if (!found) return workflow;
  return {
    ...workflow,
    site: found,
    action: workflow.action === "desk" ? "portal-read" : workflow.action,
  };
}

export function normalizeWorkflowHost(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^https?:\/\//, "");
  const cut = host.search(/[/?#]/);
  if (cut !== -1) host = host.slice(0, cut);
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  if (host.startsWith("www.")) host = host.slice(4);
  return HOST_RE.test(host) ? host : null;
}

export function workflowBlockReason(workflow: CustomWorkflow): string | null {
  const inferred = withInferredSite(workflow);
  if (!inferred.outcome.trim()) return "Say what Bud should check or prepare.";
  if (!TIME_RE.test(inferred.time)) return "Pick a time.";
  if (!inferred.weekdays.length) return "Pick at least one day.";
  if (inferred.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    return "Pick at least one day.";
  }
  if (inferred.action !== "desk") {
    if (!inferred.site.trim()) return "Name the website or bank (like propertyme.com.au).";
    if (!normalizeWorkflowHost(inferred.site)) return "Use a hostname like propertyme.com.au — no path.";
  } else if (inferred.site.trim() && !normalizeWorkflowHost(inferred.site)) {
    return "Use a hostname like propertyme.com.au — no path.";
  }
  return null;
}

function dayList(weekdays: number[]): string {
  const days = [...weekdays].sort((a, b) => a - b);
  if (days.join(",") === "1,2,3,4,5") return "weekday";
  if (days.length === 7) return "day";
  return days.map((day) => DAY_NAMES[day]).join(", ");
}

function actionLine(action: WorkflowAction): string {
  if (action === "portal-prefill") {
    return "Bud may: open the named site, read it, and prefill forms. Put decisions on Desk. The person Submits.";
  }
  if (action === "portal-read") {
    return "Bud may: open the named site and read it. Put anything that needs a person on Desk. Do not type into forms.";
  }
  return "Bud may: check the book and prepare wording. Put only decisions on Desk. Do not open a website unless a site is named.";
}

export function composeJobText(workflow: CustomWorkflow): string {
  const inferred = withInferredSite(workflow);
  const host = normalizeWorkflowHost(inferred.site);
  const lines = [
    `Every ${dayList(inferred.weekdays)} at ${inferred.time}.`,
    inferred.outcome.trim(),
  ];
  if (host) lines.push(`Site: ${host}`);
  lines.push(actionLine(inferred.action));
  lines.push("Never send, pay, sign, or issue a notice.");
  return lines.join("\n");
}

export function capabilitiesForAction(action: WorkflowAction): JobCapability[] {
  if (action === "portal-prefill") return [...PREFILL_CAPABILITIES];
  if (action === "portal-read") return [...READ_CAPABILITIES];
  return [...DESK_CAPABILITIES];
}

export function applyWorkflowToDraft(draft: Recipe, workflow: CustomWorkflow): Recipe {
  const inferred = withInferredSite(workflow);
  const host = normalizeWorkflowHost(inferred.site);
  const allowedOrigins = host ? [host] : inferred.action === "desk" ? [] : [...draft.allowedOrigins];
  return {
    ...draft,
    description: composeJobText(inferred),
    schedule: { time: inferred.time, weekdays: [...inferred.weekdays].sort((a, b) => a - b) },
    allowedOrigins,
    capabilities: capabilitiesForAction(inferred.action),
  };
}
