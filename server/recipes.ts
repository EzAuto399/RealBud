// Recurring portal jobs. The book stores the card; a run is a later session.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Recipe, RecipeStatus } from "../shared/contracts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { parseClockTime, parseWeekdays } from "./routines.ts";

export { recipeClockRunnable } from "../shared/contracts.ts";

const MAX_TITLE = 80;
const MAX_STEPS = 12;
const MAX_STEP = 200;
const MAX_ORIGINS = 5;
const MAX_EVIDENCE = 200;
const ORIGIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/;

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
  steps: string[];
  allowedOrigins: string[];
  evidence: string;
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

  return { title, steps, allowedOrigins, evidence, siteNotes: siteNotes || null, schedule: parseRecipeSchedule(row.schedule) };
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
  return {
    id: row.id,
    title: row.title,
    steps: row.steps,
    allowedOrigins: row.allowedOrigins,
    evidence: row.evidence,
    siteNotes: typeof row.siteNotes === "string" && row.siteNotes.trim() ? row.siteNotes : null,
    status: row.status,
    createdAt: row.createdAt,
    schedule: parseRecipeSchedule(row.schedule),
    planApprovedAt: asPlanApprovedAt(row.planApprovedAt),
  };
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

export function saveRecipe(input: unknown): Recipe[] {
  const fields = validateRecipe(input);
  const row = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : randomUUID();
  const createdAt =
    typeof row.createdAt === "number" && Number.isFinite(row.createdAt) ? row.createdAt : Date.now();
  const status = isStatus(row.status) ? row.status : "shadow";
  const recipes = loadRecipes();
  const existing = recipes.find((item) => item.id === id);
  const recipe: Recipe = { id, ...fields, status, createdAt, planApprovedAt: existing?.planApprovedAt ?? null, siteNotes: fields.siteNotes ?? existing?.siteNotes ?? null };
  const next = recipes.filter((item) => item.id !== id);
  next.push(recipe);
  persist(next);
  return next;
}

export function patchRecipe(id: string, patch: { status?: unknown; planApproved?: unknown }): Recipe[] {
  const wantsStatus = patch.status !== undefined && patch.status !== "";
  const wantsApprove = patch.planApproved === true;
  if (wantsStatus && !isStatus(patch.status)) {
    throw Object.assign(new Error("Status must be shadow, active, or paused."), { status: 400 });
  }
  if (!wantsStatus && !wantsApprove) {
    throw Object.assign(new Error("Status must be shadow, active, or paused."), { status: 400 });
  }
  const recipes = loadRecipes();
  const idx = recipes.findIndex((recipe) => recipe.id === id);
  if (idx < 0) throw Object.assign(new Error("no such recipe"), { status: 404 });
  const current = recipes[idx];
  if (!current) throw Object.assign(new Error("no such recipe"), { status: 404 });
  recipes[idx] = {
    ...current,
    status: wantsStatus && isStatus(patch.status) ? patch.status : current.status,
    planApprovedAt: wantsApprove ? (current.planApprovedAt ?? Date.now()) : current.planApprovedAt,
  };
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
