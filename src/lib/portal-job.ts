import { relativeAgo } from "./au";
import type { PortalSession, Recipe, RecipeStatus } from "./desk";

export const AWAITING_REVIEW_COPY =
  "Ready — review and submit in the portal yourself. A one-time submit lease for Bud lands with the desktop app.";

export const PORTAL_JOB_PATH_COPY =
  "Describe a portal routine in Ask or here; approve the plan; attach the site; then Run beside me — you sign in, Bud does the steps, Submit and Pay stay with you.";

/** Assumed while shared contracts land: includes `"portal-submit"`. */
export const PORTAL_JOB_CAPABILITIES = ["portal-read", "portal-prefill", "portal-submit"] as const;

/** Assumed Recipe.attachment while shared contracts land. */
export type RecipeAttachment = {
  attachedAt: number;
  acknowledged: "human-login-and-submit";
} | null;

export function recipeIdFromLoop(loopId: string): string | null {
  return loopId.startsWith("recipe-") ? loopId.slice("recipe-".length) : null;
}

export function findRecipeForLoop(recipes: readonly Recipe[], loopId: string): Recipe | undefined {
  const id = recipeIdFromLoop(loopId);
  return id ? recipes.find((recipe) => recipe.id === id) : undefined;
}

export function recipeHasPortalCapability(recipe: { capabilities: readonly string[] }): boolean {
  return recipe.capabilities.some((capability) =>
    (PORTAL_JOB_CAPABILITIES as readonly string[]).includes(capability),
  );
}

export function recipeHasSubmitCapability(recipe: { capabilities: readonly string[] }): boolean {
  return recipe.capabilities.some((capability) => capability === "portal-submit");
}

/** Assumed Recipe.submitAcknowledgedAt while shared contracts land. */
export function recipeSubmitAcknowledged(recipe: object): number | null {
  const value = (recipe as { submitAcknowledgedAt?: unknown }).submitAcknowledgedAt;
  return typeof value === "number" ? value : null;
}

export function alwaysAllowOfferLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "Always allow";
  return `Always allow ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}

export function portalRuleLabel(rule: { label: string; surface?: string; origin?: string }): string {
  if (rule.origin && rule.surface === "portal-read") return `Reading on ${rule.origin}`;
  if (rule.origin && rule.surface === "portal-prefill") return `Prefill on ${rule.origin}`;
  return rule.label;
}

export function isPortalSiteRule(rule: { surface?: string; origin?: string }): boolean {
  return (rule.surface === "portal-read" || rule.surface === "portal-prefill") && Boolean(rule.origin);
}

export function recipePortalModeLabel(recipe: { capabilities: readonly string[] }): "read-only" | "reads and prefills" {
  return recipe.capabilities.some((capability) => capability === "portal-prefill") ? "reads and prefills" : "read-only";
}

export function recipePortalSiteLine(recipe: {
  allowedOrigins: readonly string[];
  capabilities: readonly string[];
}): string {
  if (!recipeHasPortalCapability(recipe) || recipe.allowedOrigins.length === 0) {
    return "No portal site on this job";
  }
  return `Site: ${recipe.allowedOrigins.join(", ")} · ${recipePortalModeLabel(recipe)}`;
}

export function recipeAttachment(recipe: object): RecipeAttachment {
  const value = (recipe as { attachment?: unknown }).attachment;
  if (value == null) return null;
  if (typeof value !== "object") return null;
  const attachedAt = (value as { attachedAt?: unknown }).attachedAt;
  const acknowledged = (value as { acknowledged?: unknown }).acknowledged;
  if (typeof attachedAt !== "number" || acknowledged !== "human-login-and-submit") return null;
  return { attachedAt, acknowledged };
}

export function recipePlanApproved(
  recipe: Pick<Recipe, "planApprovedAt" | "revision" | "approvedRevision">,
): boolean {
  return recipe.planApprovedAt != null && recipe.approvedRevision === recipe.revision;
}

export function recipeCanAttach(recipe: {
  allowedOrigins: readonly string[];
  capabilities: readonly string[];
}): boolean {
  return recipeHasPortalCapability(recipe) && recipe.allowedOrigins.length > 0;
}

export function isLiveCapableHost(hostPlatform?: string | null): boolean {
  const ogb = typeof window !== "undefined" ? window.ogb?.platform : undefined;
  if (ogb === "darwin" || hostPlatform === "darwin") return true;
  if (ogb === "linux" || ogb === "win32") return false;
  if (hostPlatform === "linux" || hostPlatform === "win32") return false;
  return true;
}

export function recipeSitesLine(origins: string[]): string {
  if (origins.length === 0) return "No website is authorised";
  return `Only these sites: ${origins.join(", ")}`;
}

export function recipeSourceLine(recipe: Pick<Recipe, "allowedOrigins" | "capabilities">): string {
  if (recipe.allowedOrigins.length) return `Reads only: ${recipe.allowedOrigins.join(", ")}`;
  const local: string[] = [];
  if (recipe.capabilities.includes("read-book")) local.push("current Desk book");
  if (recipe.capabilities.includes("read-files")) local.push("private workroom files");
  if (recipe.capabilities.includes("web-research")) local.push("public web research");
  if (local.length) return `Reads: ${local.join(", ")}; no website login is authorised`;
  return "No live source is authorised — rehearsal uses the saved description only";
}

export function recipeStatusChip(status: RecipeStatus): { label: string; className: string } {
  if (status === "active") return { label: "Active", className: "bg-agency/10 text-agency" };
  if (status === "paused") return { label: "Paused", className: "bg-raised text-ink-muted" };
  return { label: "Shadow", className: "bg-hold/10 text-hold" };
}

export function nextRecipeStatus(status: RecipeStatus): RecipeStatus {
  return status === "active" ? "paused" : "active";
}

export function recipeNeedsPlanApproval(
  recipe: Pick<Recipe, "planApprovedAt" | "revision" | "approvedRevision">,
): boolean {
  return recipe.planApprovedAt == null || recipe.approvedRevision !== recipe.revision;
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
