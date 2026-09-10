// Recurring portal jobs. The book stores the card; a run is a later session.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  JOB_CAPABILITIES,
  type JobCapability,
  type JobLimits,
  type Recipe,
  type RecipeStatus,
} from "../shared/contracts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { parseClockTime, parseWeekdays } from "./routines.ts";

export { recipeClockRunnable } from "../shared/contracts.ts";

const MAX_TITLE = 80;
const MAX_STEPS = 12;
const MAX_STEP = 200;
const MAX_ORIGINS = 5;
const MAX_EVIDENCE = 200;
const MAX_DESCRIPTION = 4_000;
const ORIGIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

export const DEFAULT_JOB_CAPABILITIES: JobCapability[] = ["read-book", "analyse", "draft"];
export const DEFAULT_JOB_LIMITS: JobLimits = { maxRuntimeMinutes: 2, maxTurns: 6 };

function recipesPath(): string {
  return join(DATA_DIR, "recipes.json");
}

function bad(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function isStatus(value: unknown): value is RecipeStatus {
  return value === "shadow" || value === "active" || value === "paused";
}

function asPlanApprovedAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function asRevision(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;
}

function asUpdatedAt(value: unknown, createdAt: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : createdAt;
}

function parseCapabilities(value: unknown): JobCapability[] {
  if (value === undefined) return [...DEFAULT_JOB_CAPABILITIES];
  if (!Array.isArray(value) || value.length < 1 || value.length > JOB_CAPABILITIES.length) {
    bad(`Choose between 1 and ${JOB_CAPABILITIES.length} safe job capabilities.`);
  }
  const out: JobCapability[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !(JOB_CAPABILITIES as readonly string[]).includes(raw)) {
      bad("That job asks for a capability Bud cannot be granted.");
    }
    const capability = raw as JobCapability;
    if (!out.includes(capability)) out.push(capability);
  }
  if (!out.length) bad("Choose at least one safe job capability.");
  if (out.includes("portal-prefill") && !out.includes("portal-read")) out.unshift("portal-read");
  if (out.includes("portal-submit") && !out.includes("portal-prefill")) {
    bad("Add prefill before Bud may press Submit.");
  }
  return out;
}

export function recipeHasPortalCapability(capabilities: readonly JobCapability[]): boolean {
  return (
    capabilities.includes("portal-read") ||
    capabilities.includes("portal-prefill") ||
    capabilities.includes("portal-submit")
  );
}

export function fenceCapabilitiesFor(recipe: Pick<Recipe, "capabilities" | "submitAcknowledgedAt">): JobCapability[] {
  if (recipe.submitAcknowledgedAt != null) return [...recipe.capabilities];
  return recipe.capabilities.filter((capability) => capability !== "portal-submit");
}

export type RecipeAttachment = { attachedAt: number; acknowledged: "human-login-and-submit" };

function asAttachment(value: unknown): RecipeAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.acknowledged !== "human-login-and-submit") return null;
  if (typeof row.attachedAt !== "number" || !Number.isFinite(row.attachedAt) || row.attachedAt <= 0) return null;
  return { attachedAt: row.attachedAt, acknowledged: "human-login-and-submit" };
}

function parseLimits(value: unknown): JobLimits {
  if (value === undefined) return { ...DEFAULT_JOB_LIMITS };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    bad("Job limits must name maxRuntimeMinutes and maxTurns.");
  }
  const row = value as Record<string, unknown>;
  if (!Number.isInteger(row.maxRuntimeMinutes) || Number(row.maxRuntimeMinutes) < 1 || Number(row.maxRuntimeMinutes) > 5) {
    bad("Job runtime must be between 1 and 5 minutes.");
  }
  if (!Number.isInteger(row.maxTurns) || Number(row.maxTurns) < 1 || Number(row.maxTurns) > 12) {
    bad("Job turns must be between 1 and 12.");
  }
  return { maxRuntimeMinutes: Number(row.maxRuntimeMinutes), maxTurns: Number(row.maxTurns) };
}

/** Bare https host: lowercase, drop scheme/path/port, drop a leading www. */
export function normalizeOrigin(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "");
  const cut = host.search(/[/?#]/);
  if (cut !== -1) host = host.slice(0, cut);
  const colon = host.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  if (host.startsWith("www.")) host = host.slice(4);
  return ORIGIN_RE.test(host) ? host : null;
}

/** Optional clock. Missing or unusable cadence becomes null — never fails the card. */
export function parseRecipeSchedule(value: unknown): { time: string; weekdays: number[] } | null {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const time = parseClockTime(row.time);
  const weekdays = parseWeekdays(row.weekdays);
  if (!time || !weekdays) return null;
  return { time, weekdays };
}

export function validateRecipe(input: unknown): {
  title: string;
  description: string;
  steps: string[];
  allowedOrigins: string[];
  evidence: string;
  capabilities: JobCapability[];
  limits: JobLimits;
  siteNotes: string | null;
  schedule: { time: string; weekdays: number[] } | null;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    bad("That is not a job card.");
  }
  const row = input as Record<string, unknown>;
  if (typeof row.title !== "string") bad("Give the job a name — 1 to 80 characters.");
  const title = row.title.trim();
  if (!title || title.length > MAX_TITLE) bad("Give the job a name — 1 to 80 characters.");

  if (row.description !== undefined && typeof row.description !== "string") {
    bad("Job description must be at most 4000 characters.");
  }
  const description = typeof row.description === "string" ? row.description.trim() : "";
  if (description.length > MAX_DESCRIPTION) bad("Job description must be at most 4000 characters.");

  if (!Array.isArray(row.steps)) bad("List between 1 and 12 steps.");
  if (row.steps.length < 1 || row.steps.length > MAX_STEPS) bad("List between 1 and 12 steps.");
  const steps: string[] = [];
  for (const step of row.steps) {
    if (typeof step !== "string") bad("Each step must be 1 to 200 characters.");
    const trimmed = step.trim();
    if (!trimmed || trimmed.length > MAX_STEP) bad("Each step must be 1 to 200 characters.");
    steps.push(trimmed);
  }

  if (!Array.isArray(row.allowedOrigins)) bad("Name at most 5 portal sites.");
  if (row.allowedOrigins.length > MAX_ORIGINS) bad("Name at most 5 portal sites.");
  const allowedOrigins: string[] = [];
  for (const origin of row.allowedOrigins) {
    if (typeof origin !== "string") {
      bad("Use a portal hostname like propertyme.com.au — no path or port.");
    }
    const host = normalizeOrigin(origin);
    if (!host) bad("Use a portal hostname like propertyme.com.au — no path or port.");
    if (!allowedOrigins.includes(host)) allowedOrigins.push(host);
  }

  if (row.evidence !== undefined && typeof row.evidence !== "string") {
    bad("Evidence must be at most 200 characters.");
  }
  const evidence = typeof row.evidence === "string" ? row.evidence.trim() : "";
  if (evidence.length > MAX_EVIDENCE) bad("Evidence must be at most 200 characters.");

  if (row.siteNotes !== undefined && row.siteNotes !== null && typeof row.siteNotes !== "string") {
    bad("Site notes must be at most 500 characters.");
  }
  const siteNotes = typeof row.siteNotes === "string" ? row.siteNotes.trim() : "";
  if (siteNotes.length > 500) bad("Site notes must be at most 500 characters.");

  const capabilities = parseCapabilities(row.capabilities);
  if (recipeHasPortalCapability(capabilities) && allowedOrigins.length < 1) {
    bad("Name the portal site this job may open.");
  }

  return {
    title,
    description,
    steps,
    allowedOrigins,
    evidence,
    capabilities,
    limits: parseLimits(row.limits),
    siteNotes: siteNotes || null,
    schedule: parseRecipeSchedule(row.schedule),
  };
}

function asRecipe(value: unknown): Recipe | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id.trim()) return null;
  if (typeof row.title !== "string") return null;
  if (!Array.isArray(row.steps) || !row.steps.every((step) => typeof step === "string")) return null;
  if (!Array.isArray(row.allowedOrigins) || !row.allowedOrigins.every((origin) => typeof origin === "string")) {
    return null;
  }
  if (typeof row.evidence !== "string") return null;
  if (!isStatus(row.status)) return null;
  if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)) return null;
  try {
    const fields = validateRecipe(row);
    const createdAt = row.createdAt;
    const revision = asRevision(row.revision);
    const planApprovedAt = asPlanApprovedAt(row.planApprovedAt);
    const explicitApproved =
      typeof row.approvedRevision === "number" && Number.isInteger(row.approvedRevision) && row.approvedRevision > 0
        ? row.approvedRevision
        : null;
    return {
      id: row.id,
      ...fields,
      status: row.status,
      createdAt,
      planApprovedAt,
      revision,
      updatedAt: asUpdatedAt(row.updatedAt, createdAt),
      // A legacy approved row had only one implicit revision.
      approvedRevision: planApprovedAt ? (explicitApproved ?? 1) : null,
      attachment: asAttachment(row.attachment),
      submitAcknowledgedAt: asPlanApprovedAt(row.submitAcknowledgedAt),
    };
  } catch {
    return null;
  }
}

function persist(recipes: Recipe[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(recipesPath(), `${JSON.stringify({ recipes }, null, 2)}\n`, 0o600);
}

export function loadRecipes(): Recipe[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(recipesPath(), "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { recipes?: unknown }).recipes)
        ? (parsed as { recipes: unknown[] }).recipes
        : null;
    if (!list) return [];
    const out: Recipe[] = [];
    for (const row of list) {
      const recipe = asRecipe(row);
      if (recipe) out.push(recipe);
    }
    return out;
  } catch {
    return [];
  }
}

export function listRecipes(): Recipe[] {
  return loadRecipes();
}

export function getRecipe(id: string): Recipe | undefined {
  return loadRecipes().find((recipe) => recipe.id === id);
}

/** Optional for older callers; the plan editor always supplies its read version. */
export function assertRecipeRevision(current: Recipe | undefined, expectedRevision: unknown): void {
  if (expectedRevision === undefined) return;
  if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0) {
    bad("The saved job version is invalid. Reload the job and try again.");
  }
  if ((current?.revision ?? 0) !== expectedRevision) {
    throw Object.assign(new Error("This job changed elsewhere. Reload the saved plan before saving or approving it."), { status: 409 });
  }
}

export function saveRecipe(input: unknown): Recipe[] {
  const fields = validateRecipe(input);
  const row = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : randomUUID();
  const recipes = loadRecipes();
  const existing = recipes.find((item) => item.id === id);
  assertRecipeRevision(existing, row.expectedRevision);
  const now = Date.now();
  const createdAt = existing?.createdAt ??
    (typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : now);
  const status = isStatus(row.status) ? row.status : (existing?.status ?? "shadow");
  const effective = {
    ...fields,
    description: row.description === undefined && existing ? existing.description : fields.description,
    capabilities: row.capabilities === undefined && existing ? existing.capabilities : fields.capabilities,
    limits: row.limits === undefined && existing ? existing.limits : fields.limits,
    siteNotes: fields.siteNotes ?? existing?.siteNotes ?? null,
  };
  const material = (recipe: Pick<Recipe, "title" | "description" | "steps" | "allowedOrigins" | "evidence" | "capabilities" | "limits" | "siteNotes" | "schedule">) =>
    JSON.stringify({
      title: recipe.title,
      description: recipe.description,
      steps: recipe.steps,
      allowedOrigins: recipe.allowedOrigins,
      evidence: recipe.evidence,
      capabilities: recipe.capabilities,
      limits: recipe.limits,
      siteNotes: recipe.siteNotes ?? null,
      schedule: recipe.schedule,
    });
  const changed = existing ? material(existing) !== material(effective) : false;
  const originsChanged =
    existing != null && JSON.stringify(existing.allowedOrigins) !== JSON.stringify(effective.allowedOrigins);
  const capabilitiesChanged =
    existing != null && JSON.stringify(existing.capabilities) !== JSON.stringify(effective.capabilities);
  const recipe: Recipe = {
    id,
    ...effective,
    status,
    createdAt,
    planApprovedAt: changed ? null : (existing?.planApprovedAt ?? null),
    revision: existing ? (changed ? existing.revision + 1 : existing.revision) : 1,
    updatedAt: existing ? (changed ? now : existing.updatedAt) : createdAt,
    approvedRevision: changed ? null : (existing?.approvedRevision ?? null),
    attachment: originsChanged ? null : (existing?.attachment ?? null),
    submitAcknowledgedAt: originsChanged || capabilitiesChanged ? null : (existing?.submitAcknowledgedAt ?? null),
  };
  const next = recipes.filter((item) => item.id !== id);
  next.push(recipe);
  persist(next);
  return next;
}

export function patchRecipe(
  id: string,
  patch: {
    expectedRevision?: unknown;
    status?: unknown;
    planApproved?: unknown;
    attach?: unknown;
    submitAcknowledged?: unknown;
    /** Replace authorised portal hosts (normalised). Clears attachment when changed. */
    allowedOrigins?: unknown;
    /** When setting a portal site from Ask, ensure read/prefill capabilities exist. */
    ensurePortal?: unknown;
  },
): Recipe[] {
  const wantsStatus = patch.status !== undefined && patch.status !== "";
  const wantsApprove = patch.planApproved === true;
  const wantsAttach = patch.attach === true;
  const wantsDetach = patch.attach === false;
  const wantsSubmitAck = patch.submitAcknowledged === true;
  const wantsSubmitOff = patch.submitAcknowledged === false;
  const wantsOrigins = Array.isArray(patch.allowedOrigins);
  const wantsEnsurePortal = patch.ensurePortal === true;
  if (wantsStatus && !isStatus(patch.status)) {
    throw Object.assign(new Error("Status must be shadow, active, or paused."), { status: 400 });
  }
  if (
    !wantsStatus &&
    !wantsApprove &&
    !wantsAttach &&
    !wantsDetach &&
    !wantsSubmitAck &&
    !wantsSubmitOff &&
    !wantsOrigins
  ) {
    throw Object.assign(new Error("Status must be shadow, active, or paused."), { status: 400 });
  }
  const recipes = loadRecipes();
  const idx = recipes.findIndex((recipe) => recipe.id === id);
  if (idx < 0) throw Object.assign(new Error("no such recipe"), { status: 404 });
  const current = recipes[idx];
  if (!current) throw Object.assign(new Error("no such recipe"), { status: 404 });
  assertRecipeRevision(current, patch.expectedRevision);

  let allowedOrigins = current.allowedOrigins;
  let capabilities = [...current.capabilities];
  let materialChanged = false;

  if (wantsOrigins) {
    const nextOrigins: string[] = [];
    for (const raw of patch.allowedOrigins as unknown[]) {
      if (typeof raw !== "string") continue;
      const host = normalizeOrigin(raw);
      if (!host) {
        throw Object.assign(new Error("Use a portal hostname like propertyme.com.au — no path or port."), {
          status: 400,
        });
      }
      if (!nextOrigins.includes(host)) nextOrigins.push(host);
    }
    if (nextOrigins.length > MAX_ORIGINS) {
      throw Object.assign(new Error("Name at most 5 portal sites."), { status: 400 });
    }
    if (nextOrigins.length < 1) {
      throw Object.assign(new Error("Name the portal site this job may open."), { status: 400 });
    }
    if (JSON.stringify(current.allowedOrigins) !== JSON.stringify(nextOrigins)) {
      allowedOrigins = nextOrigins;
      materialChanged = true;
    }
  }

  if (wantsEnsurePortal || (wantsOrigins && !recipeHasPortalCapability(capabilities))) {
    for (const cap of ["portal-read", "portal-prefill"] as const) {
      if (!capabilities.includes(cap)) {
        capabilities.push(cap);
        materialChanged = true;
      }
    }
  }

  if (wantsAttach && (!allowedOrigins.length || !recipeHasPortalCapability(capabilities))) {
    throw Object.assign(new Error("Add the portal site and a portal capability before attaching it."), {
      status: 409,
    });
  }
  if (wantsSubmitAck && !capabilities.includes("portal-submit")) {
    throw Object.assign(new Error("Add 'Bud may press Submit' only on a job with the portal-submit capability."), {
      status: 409,
    });
  }

  const now = Date.now();
  recipes[idx] = {
    ...current,
    allowedOrigins,
    capabilities,
    status: wantsStatus && isStatus(patch.status) ? patch.status : wantsApprove ? "active" : current.status,
    planApprovedAt: materialChanged
      ? null
      : wantsApprove
        ? (current.approvedRevision === current.revision ? (current.planApprovedAt ?? now) : now)
        : current.planApprovedAt,
    approvedRevision: materialChanged ? null : wantsApprove ? current.revision : current.approvedRevision,
    revision: materialChanged ? current.revision + 1 : current.revision,
    updatedAt:
      materialChanged || wantsApprove || wantsAttach || wantsDetach || wantsSubmitAck || wantsSubmitOff || wantsStatus
        ? now
        : current.updatedAt,
    attachment: wantsAttach
      ? ({ attachedAt: now, acknowledged: "human-login-and-submit" } as const)
      : wantsDetach || materialChanged
        ? null
        : current.attachment,
    submitAcknowledgedAt: wantsSubmitAck
      ? (current.submitAcknowledgedAt ?? now)
      : wantsSubmitOff || materialChanged
        ? null
        : current.submitAcknowledgedAt,
  };

  // Approve after a same-request origin set: stamp the new revision.
  if (wantsApprove && materialChanged) {
    const row = recipes[idx]!;
    recipes[idx] = {
      ...row,
      planApprovedAt: now,
      approvedRevision: row.revision,
      status: wantsStatus && isStatus(patch.status) ? patch.status : "active",
    };
  }
  // Attach after a same-request origin set (and optional approve).
  if (wantsAttach) {
    const row = recipes[idx]!;
    if (!row.allowedOrigins.length || !recipeHasPortalCapability(row.capabilities)) {
      throw Object.assign(new Error("Add the portal site and a portal capability before attaching it."), {
        status: 409,
      });
    }
    recipes[idx] = {
      ...row,
      attachment: row.attachment ?? { attachedAt: now, acknowledged: "human-login-and-submit" },
    };
  }

  persist(recipes);
  return recipes;
}

export function patchRecipeStatus(id: string, status: string): Recipe[] {
  return patchRecipe(id, { status });
}

export function deleteRecipe(id: string): Recipe[] {
  const recipes = loadRecipes();
  const next = recipes.filter((recipe) => recipe.id !== id);
  if (next.length === recipes.length) throw Object.assign(new Error("no such recipe"), { status: 404 });
  persist(next);
  return next;
}
