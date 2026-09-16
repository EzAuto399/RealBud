import { recipeAttachment, recipeCanAttach, recipeNeedsPlanApproval, recipePlanApproved } from "./portal-job";

export type AskNext =
  | { id: string; label: string; description: string; kind: "ask"; text: string }
  | { id: string; label: string; description: string; kind: "recheck" }
  | { id: string; label: string; description: string; kind: "desk" }
  | { id: string; label: string; description: string; kind: "you" }
  /** You → Bud's jobs (unscheduled jobs live there, not on Schedule). */
  | { id: string; label: string; description: string; kind: "you-jobs" }
  /** Open in-Ask Connected apps key sheet (optionally then connect this app). */
  | { id: string; label: string; description: string; kind: "connect-setup"; connectLabel?: string }
  | { id: string; label: string; description: string; kind: "routines" }
  | { id: string; label: string; description: string; kind: "interrupt" }
  | { id: string; label: string; description: string; kind: "attend"; recipeId: string }
  /** Approve (and attach when ready) without leaving Ask. */
  | { id: string; label: string; description: string; kind: "approve"; recipeId: string; attach: boolean }
  /** Collect portal hostname inline, then approve/attach. */
  | { id: string; label: string; description: string; kind: "set-site"; recipeId: string };

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
  /** True when the Connected apps broker key is already saved. */
  composioConfigured?: boolean;
  /** Job the PM just acted on in Ask — keep the next verb on this screen. */
  focusRecipeId?: string | null;
};

type AskSavedJob = {
  id: string;
  title: string;
  planApprovedAt: number | null;
  revision: number;
  approvedRevision: number | null;
  attachment?: unknown;
  capabilities?: readonly string[];
  allowedOrigins?: readonly string[];
  updatedAt?: number;
};

export function savedJobTitleFromReply(text: string | null | undefined): string | null {
  if (typeof text !== "string" || !text.includes("is already a saved job")) return null;
  const match = text.match(/\*\*(.+?)\*\*/);
  const title = match?.[1]?.trim();
  return title || null;
}

export function planTitleFromReply(text: string | null | undefined): string | null {
  if (typeof text !== "string" || !text.includes("Here's the plan")) return null;
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

/** Prefer the named job, else the single pending plan, else the newest pending. */
export function pendingPlanRecipeForReply<T extends AskSavedJob>(
  recipes: readonly T[],
  lastBotText: string | null | undefined,
): T | undefined {
  const pending = recipes.filter((recipe) => recipeNeedsPlanApproval(recipe));
  if (pending.length === 0) return undefined;
  const title = planTitleFromReply(lastBotText) ?? savedJobTitleFromReply(lastBotText);
  if (title) {
    const named = pending.find((recipe) => recipe.title === title);
    if (named) return named;
  }
  if (pending.length === 1) return pending[0];
  return [...pending].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

export function connectAppLabelFromReply(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const press = text.match(/\*\*Connect (.+?)\*\*/);
  if (press?.[1]?.trim()) return press[1].trim();
  const opened = text.match(/I opened (.+?) sign-in/i);
  if (opened?.[1]?.trim()) return opened[1].trim();
  return null;
}

function shortAddress(address: string): string {
  return address.split(",")[0]?.trim() || address;
}

function pushFocusRecipeActions(next: AskNext[], recipe: AskSavedJob, threadIdle: boolean): void {
  if (threadIdle === false) return;
  const caps = recipe.capabilities ?? [];
  const origins = recipe.allowedOrigins ?? [];
  const canAttach = recipeCanAttach({ capabilities: caps, allowedOrigins: origins });
  const approved = recipePlanApproved(recipe);
  const attached = recipeAttachment(recipe) != null;

  if (approved && attached) {
    next.push({
      id: "attend-now",
      label: "Run beside me now",
      description: "Start this job beside you — stay in Ask for Bud's requests.",
      kind: "attend",
      recipeId: recipe.id,
    });
    return;
  }

  if (!canAttach) {
    next.push({
      id: "set-site",
      label: "Add portal site",
      description: "Paste the portal address here, then approve and run beside you.",
      kind: "set-site",
      recipeId: recipe.id,
    });
    return;
  }

  if (!approved) {
    next.push({
      id: "approve-plan",
      label: "Approve plan and attach",
      description: "Approve here. You sign in; Bud reads and prefills; Submit, Pay and Send stay with you.",
      kind: "approve",
      recipeId: recipe.id,
      attach: true,
    });
    return;
  }

  next.push({
    id: "approve-plan",
    label: "Attach site",
    description: "Attach here so Bud can run beside you.",
    kind: "approve",
    recipeId: recipe.id,
    attach: true,
  });
}

/** Suggestions are deliberately derived from the current Desk, never a
 * static prompt gallery. Direct work (Recheck) runs through RealBud; only
 * an investigation/brief becomes an Ask turn. */
export function askNextActions(input: AskNextInput): AskNext[] {
  const next: AskNext[] = [];
  if (input.lastBotText?.includes("**Schedule work**")) next.push({ id: "schedule-here", label: "Schedule work", description: "Review the job and timing here.", kind: "routines" });
  if (input.lastBotText?.includes("**Add**")) next.push({ id: "office-connections", label: "Office connections", description: "Choose or reconnect an office app here.", kind: "connect-setup" });
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

  const focus =
    input.focusRecipeId && input.recipes
      ? input.recipes.find((recipe) => recipe.id === input.focusRecipeId)
      : undefined;
  if (focus) pushFocusRecipeActions(next, focus, input.threadIdle !== false);

  const connectLabel = connectAppLabelFromReply(input.lastBotText);
  if (
    typeof input.lastBotText === "string" &&
    /Connected apps needs its private (?:broker|connection) key/.test(input.lastBotText)
  ) {
    if (input.composioConfigured && connectLabel) {
      next.push({
        id: "connect-app",
        label: `Connect ${connectLabel}`,
        description: "Connection key is saved. Open the provider sign-in now.",
        kind: "ask",
        text: `connect ${connectLabel}`,
      });
    } else {
      next.push({
        id: "connect-setup",
        label: connectLabel ? `Save key · Connect ${connectLabel}` : "Save Connected apps key",
        description: "Save the private connection key here.",
        kind: "connect-setup",
        ...(connectLabel ? { connectLabel } : {}),
      });
    }
  } else if (
    typeof input.lastBotText === "string" &&
    /I opened .+ sign-in/i.test(input.lastBotText) &&
    connectLabel &&
    input.threadIdle !== false
  ) {
    next.push({
      id: "check-app-connection",
      label: `Check ${connectLabel} connection`,
      description: "Check whether provider sign-in finished without starting another sign-in.",
      kind: "ask",
      text: `check ${connectLabel} connection`,
    });
  }

  if (typeof input.lastBotText === "string" && input.lastBotText.includes("is already a saved job")) {
    const title = savedJobTitleFromReply(input.lastBotText);
    const matchingReady =
      input.threadIdle !== false && title && input.recipes
        ? input.recipes.filter(
            (recipe) =>
              recipe.title === title && recipePlanApproved(recipe) && recipeAttachment(recipe) != null,
          )
        : [];
    const ready = matchingReady.length === 1 ? matchingReady[0] : undefined;
    if (ready) {
      if (!next.some((row) => row.kind === "attend" && row.recipeId === ready.id)) {
        next.push({
          id: "attend-now",
          label: "Run beside me now",
          description: "Start this saved job beside you.",
          kind: "attend",
          recipeId: ready.id,
        });
      }
    } else if (title && input.recipes && input.threadIdle !== false && matchingReady.length === 0) {
      const named = input.recipes.find((recipe) => recipe.title === title);
      if (named && !focus) pushFocusRecipeActions(next, named, true);
    }
    if (
      input.threadIdle !== false &&
      !next.some((row) => row.kind === "attend" || row.kind === "approve" || row.kind === "set-site")
    ) {
      const openSchedule = /Open Schedule/i.test(input.lastBotText);
      next.push({
        id: "open-job",
        label: "Open the job",
        description: openSchedule
          ? "Open Schedule to find this job and press Run beside me."
          : "Open Schedule to review this saved job.",
        kind: openSchedule ? "routines" : "you-jobs",
      });
    }
  }

  if (
    typeof input.lastBotText === "string" &&
    (/Approve the plan/i.test(input.lastBotText) || /Here's the plan/i.test(input.lastBotText)) &&
    !focus
  ) {
    const pending =
      input.threadIdle !== false && input.recipes
        ? pendingPlanRecipeForReply(input.recipes, input.lastBotText)
        : undefined;
    if (pending) pushFocusRecipeActions(next, pending, true);
  }

  if (!input.workerReady) {
    next.push({
      id: "attach",
      label: input.workerReady || input.workerSetupComplete ? "Check Bud" : "Set up Bud",
      description: input.miss
        ? "Recheck missed. Set up Bud here before the next run."
        : "Finish the private model and workroom check so Bud can take the next job.",
      kind: "you",
    });
  }
  if (!input.workerReady) {
    if (input.needsYou > 0) {
      next.push({
        id: "desk",
        label: `Review ${input.needsYou} ${input.needsYou === 1 ? "decision" : "decisions"}`,
        description: "These are already prepared on Desk; no extra message to Bud is needed.",
        kind: "desk",
      });
    }
    return dedupeAskNext(next).slice(0, 3);
  }

  // Portal work already named on Ask — do not bury it under Desk address chips.
  if (next.some((row) => row.kind === "attend" || row.kind === "approve" || row.kind === "set-site")) {
    return dedupeAskNext(next).slice(0, 3);
  }

  const addresses = input.addresses ?? [];
  const unchecked = addresses.filter((row) => row.attention === "unchecked");
  if (input.miss || input.lastRunAt == null || unchecked.length > 0) {
    const count = unchecked.length || addresses.length;
    next.push({
      id: "recheck",
      label: count > 0 ? `Check ${count} ${count === 1 ? "address" : "addresses"} now` : "Run Bud now",
      description: input.miss ? "Bud is connected. Check the book again to refresh its facts." : "Bud reads the current facts and puts every safe exception on Desk.",
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

  const focusAddr = licensee ?? prepared ?? held;
  if (focusAddr) {
    const street = shortAddress(focusAddr.address);
    if (focusAddr.attention === "licensee") {
      next.push({
        id: `licensee-${focusAddr.address}`,
        label: `Prepare ${street} for review`,
        description: "Bud assembles a factual brief for the licensee without drafting a statutory notice.",
        kind: "ask",
        text: `Prepare a concise evidence brief for the licensee about ${focusAddr.address}. Use only current Desk facts, identify missing evidence, and do not draft a statutory or legal notice.`,
      });
    } else if (focusAddr.attention === "needs-you") {
      next.push({
        id: `brief-${focusAddr.address}`,
        label: `Brief me on ${street}`,
        description: "Bud summarises the evidence behind the prepared decision before you open Desk.",
        kind: "ask",
        text: `Brief me on the prepared Desk item for ${focusAddr.address}. Summarise the facts, evidence, proposed wording, and the one decision I need to make.`,
      });
    } else {
      next.push({
        id: `held-${focusAddr.address}`,
        label: `Investigate ${street}`,
        description: "Bud checks why this address is held and names the exact evidence still missing.",
        kind: "ask",
        text: `Investigate why ${focusAddr.address} is held. Use the current Desk context, do not guess, and tell me exactly what evidence or setup is missing.`,
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

  return dedupeAskNext(next).slice(0, 3);
}

function dedupeAskNext(rows: AskNext[]): AskNext[] {
  const seen = new Set<string>();
  const out: AskNext[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
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
