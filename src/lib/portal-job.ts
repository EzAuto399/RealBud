import { relativeAgo } from "./au";
import type { PortalSession, Recipe, RecipeStatus } from "./desk";

export const AWAITING_REVIEW_COPY =
  "Ready — review and submit in the portal yourself. A one-time submit lease for Bud lands with the desktop app.";

export function recipeSitesLine(origins: string[]): string {
  if (origins.length === 0) return "No websites named — Bud narrates from your words only";
  return `Only these sites: ${origins.join(", ")}`;
}

export function recipeStatusChip(status: RecipeStatus): { label: string; className: string } {
  if (status === "active") return { label: "Active", className: "bg-agency/10 text-agency" };
  if (status === "paused") return { label: "Paused", className: "bg-raised text-ink-muted" };
  return { label: "Shadow", className: "bg-hold/10 text-hold" };
}

export function nextRecipeStatus(status: RecipeStatus): RecipeStatus {
  return status === "active" ? "paused" : "active";
}

export function recipeNeedsPlanApproval(recipe: Pick<Recipe, "planApprovedAt">): boolean {
  return recipe.planApprovedAt == null;
}

export function recipeSavedLine(hasSchedule: boolean): string {
  return hasSchedule
    ? "Saved. It joins the clock after you approve the plan on You → Bud's jobs."
    : "Saved on You → Bud's jobs";
}

export function sessionSummaryLine(session: PortalSession, now = Date.now()): string {
  const notes = session.evidence.length;
  const noteLabel = notes === 1 ? "1 note" : `${notes} notes`;
  const kind = session.shadow ? "Shadow run" : "Run";
  return `${kind} · ${session.state} · ${noteLabel} · ${relativeAgo(session.endedAt ?? session.startedAt, now)}`;
}

export function latestSessionFor(sessions: PortalSession[], recipeId: string): PortalSession | undefined {
  return sessions.reduce<PortalSession | undefined>((best, session) => {
    if (session.recipeId !== recipeId) return best;
    if (!best || session.startedAt >= best.startedAt) return session;
    return best;
  }, undefined);
}
