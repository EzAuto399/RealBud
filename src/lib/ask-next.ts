import { recipeAttachment, recipePlanApproved } from "./portal-job";

export type AskNext =
  | { id: string; label: string; description: string; kind: "ask"; text: string }
  | { id: string; label: string; description: string; kind: "recheck" }
  | { id: string; label: string; description: string; kind: "desk" }
  | { id: string; label: string; description: string; kind: "you" }
  /** You → Bud's jobs (unscheduled jobs live there, not on Schedule). */
  | { id: string; label: string; description: string; kind: "you-jobs" }
  | { id: string; label: string; description: string; kind: "routines" }
  | { id: string; label: string; description: string; kind: "interrupt" }
  | { id: string; label: string; description: string; kind: "attend"; recipeId: string };

type AskAddress = {
  address: string;
  attention: "unchecked" | "quiet" | "needs-you" | "held" | "licensee";
};

type AskNextInput = {
  miss: boolean;
  needsYou: number;
  workerReady: boolean;
  workerSetupComplete?: boolean;
  lastRunAt?: number | null;
  addresses?: readonly AskAddress[];
  lastBotText?: string | null;
  attendedRunActive?: boolean;
  threadIdle?: boolean;
  recipes?: readonly AskSavedJob[];
};

type AskSavedJob = {
  id: string;
  title: string;
  planApprovedAt: number | null;
  revision: number;
  approvedRevision: number | null;
  attachment?: unknown;
};

export function savedJobTitleFromReply(text: string | null | undefined): string | null {
  if (typeof text !== "string" || !text.includes("is already a saved job")) return null;
  const match = text.match(/\*\*(.+?)\*\*/);
  const title = match?.[1]?.trim();
  return title || null;
}

export function attendRecipeForSavedJob<T extends AskSavedJob>(
  recipes: readonly T[],
  title: string,
): T | undefined {
  const matches = recipes.filter(
    (recipe) => recipe.title === title && recipePlanApproved(recipe) && recipeAttachment(recipe) != null,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function shortAddress(address: string): string {
  return address.split(",")[0]?.trim() || address;
}

/** Suggestions are deliberately derived from the current Desk, never a
 * static prompt gallery. Direct work (Recheck) runs through RealBud; only
 * an investigation/brief becomes an Ask turn. */
export function askNextActions(input: AskNextInput): AskNext[] {
  const next: AskNext[] = [];
  if (input.attendedRunActive) {
    next.push({
      id: "stop-attended",
      label: "Stop",
      description: "Stop this turn. Bud leaves the site as it is.",
      kind: "interrupt",
    });
    next.push({
      id: "open-schedule",
      label: "Open Schedule",
      description: "See this job and its run on Schedule.",
      kind: "routines",
    });
  }
  if (typeof input.lastBotText === "string" && input.lastBotText.includes("is already a saved job")) {
    const onSchedule = input.lastBotText.includes("Open Schedule");
    const title = savedJobTitleFromReply(input.lastBotText);
    const ready =
      input.threadIdle !== false && title && input.recipes
        ? attendRecipeForSavedJob(input.recipes, title)
        : undefined;
    if (ready) {
      next.push({
        id: "attend-now",
        label: "Run beside me now",
        description: "Start this saved job beside you.",
        kind: "attend",
        recipeId: ready.id,
      });
    } else {
      next.push({
        id: "open-job",
        label: "Open the job",
        description: onSchedule ? "Run it beside you from Schedule." : "Run it beside you from Bud's jobs on You.",
        kind: onSchedule ? "routines" : "you-jobs",
      });
    }
  }
  if (typeof input.lastBotText === "string" && input.lastBotText.includes("Approve the plan on ")) {
    // Bud's reply names the door: scheduled jobs sit on Schedule, the rest under You → Bud's jobs.
    const onSchedule = input.lastBotText.includes("Approve the plan on Schedule");
    next.push({
      id: "approve-plan",
      label: "Approve the plan",
      description: onSchedule
        ? "Open Schedule to approve the plan, then attach the site."
        : "Open Bud's jobs on You to approve the plan, then attach the site.",
      kind: onSchedule ? "routines" : "you-jobs",
    });
  }
  if (!input.workerReady || input.miss) {
    next.push({
      id: "attach",
      label: input.workerReady || input.workerSetupComplete ? "Check Bud" : "Set up Bud",
      description: input.miss
        ? "The last worker check missed. Repair the connection before relying on another run."
        : "Finish the private model and workroom check so Bud can take the next job.",
      kind: "you",
    });
  }
  if (!input.workerReady || input.miss) {
    if (input.needsYou > 0) {
      next.push({
        id: "desk",
        label: `Review ${input.needsYou} ${input.needsYou === 1 ? "decision" : "decisions"}`,
        description: "These are already prepared on Desk; no extra message to Bud is needed.",
        kind: "desk",
      });
    }
    return next.slice(0, 3);
  }

  const addresses = input.addresses ?? [];
  const unchecked = addresses.filter((row) => row.attention === "unchecked");
  if (input.lastRunAt == null || unchecked.length > 0) {
    const count = unchecked.length || addresses.length;
    next.push({
      id: "recheck",
      label: count > 0 ? `Check ${count} ${count === 1 ? "address" : "addresses"} now` : "Run Bud now",
      description: "Bud reads the current facts and puts every safe exception on Desk.",
      kind: "recheck",
    });
  }

  const licensee = addresses.find((row) => row.attention === "licensee");
  const prepared = addresses.find((row) => row.attention === "needs-you");
  const held = addresses.find((row) => row.attention === "held");
  const waiting = input.needsYou + addresses.filter((row) => row.attention === "licensee").length;
  if (waiting > 0) {
    next.push({
      id: "desk",
      label: `Review ${waiting} ${waiting === 1 ? "decision" : "decisions"}`,
      description: "Bud has already prepared the evidence and wording; you only decide what happens next.",
      kind: "desk",
    });
  }

  const focus = licensee ?? prepared ?? held;
  if (focus) {
    const street = shortAddress(focus.address);
    if (focus.attention === "licensee") {
      next.push({
        id: `licensee-${focus.address}`,
        label: `Prepare ${street} for review`,
        description: "Bud assembles a factual brief for the licensee without drafting a statutory notice.",
        kind: "ask",
        text: `Prepare a concise evidence brief for the licensee about ${focus.address}. Use only current Desk facts, identify missing evidence, and do not draft a statutory or legal notice.`,
      });
    } else if (focus.attention === "needs-you") {
      next.push({
        id: `brief-${focus.address}`,
        label: `Brief me on ${street}`,
        description: "Bud summarises the evidence behind the prepared decision before you open Desk.",
        kind: "ask",
        text: `Brief me on the prepared Desk item for ${focus.address}. Summarise the facts, evidence, proposed wording, and the one decision I need to make.`,
      });
    } else {
      next.push({
        id: `held-${focus.address}`,
        label: `Investigate ${street}`,
        description: "Bud checks why this address is held and names the exact evidence still missing.",
        kind: "ask",
        text: `Investigate why ${focus.address} is held. Use the current Desk context, do not guess, and tell me exactly what evidence or setup is missing.`,
      });
    }
  } else if (input.lastRunAt != null && addresses.length > 0) {
    next.push({
      id: "book-audit",
      label: `Audit ${addresses.length} checked ${addresses.length === 1 ? "address" : "addresses"}`,
      description: "Bud finds incomplete property, tenancy, owner, or contact details and prioritises the cleanup.",
      kind: "ask",
      text: `Audit the ${addresses.length} checked ${addresses.length === 1 ? "address" : "addresses"} in the current Desk context for incomplete property, tenancy, owner, and contact details. Give me a prioritised cleanup list and do not invent missing facts.`,
    });
  }

  return next.slice(0, 3);
}

const SEEDED_ASK_GREETING = "I'm Bud. Morning money lives on Desk";

export function isSeededAskGreeting(text: string | undefined | null): boolean {
  return typeof text === "string" && text.startsWith(SEEDED_ASK_GREETING);
}

/** Product Ask: the seeded greeting is not a conversation — hide it and show the empty state. */
export function isProductAskEmptyThread(
  messages: ReadonlyArray<{ role: string; kind?: string; text?: string }>,
): boolean {
  if (messages.some((m) => m.role === "user")) return false;
  return messages.every(
    (m) => m.role === "bot" && (m.kind == null || m.kind === "text") && isSeededAskGreeting(m.text),
  );
}
