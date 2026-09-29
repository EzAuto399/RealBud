// Versioned portal recipes. Candidates may auto-save; they never auto-publish.
import type { PortalRecipe } from "../shared/contracts.ts";

export const FAKE_PORTAL_RECIPE: PortalRecipe = {
  id: "fake-building-portal",
  version: 1,
  origin: "http://127.0.0.1",
  published: true,
  steps: ["open-login", "open-property", "read-ledger", "prefill-courtesy"],
  finalControlFingerprint: "button#submit-reminder",
};

export function recipeAllows(recipe: PortalRecipe, step: string): boolean {
  return recipe.steps.includes(step) && step !== "submit" && step !== "pay" && step !== "send";
}

export function isFinalControl(recipe: PortalRecipe, fingerprint: string): boolean {
  return fingerprint === recipe.finalControlFingerprint;
}

export function saveCandidate(base: PortalRecipe, _reason: string): PortalRecipe {
  return {
    ...base,
    version: base.version + 1,
    published: false,
    steps: [...base.steps],
    id: base.id,
    origin: base.origin,
    finalControlFingerprint: base.finalControlFingerprint,
  };
}

export function publishRecipe(recipe: PortalRecipe): PortalRecipe {
  if (recipe.published) return recipe;
  return { ...recipe, published: true };
}

// ── Pack recipe documents (realbud.portal-recipes.v1) ─────────────────────
// A workflow pack ships its portal's recipes as data (for REI Cloud:
// pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json,
// generated from its website map). Core knows the step grammar and where a
// pack says the account marker and UI version are shown, never a portal's
// names. A recipe grants nothing: server/portal-recipe-runner.ts replays it
// through the browser broker, which decides every step.
export const PORTAL_RECIPE_SCHEMA = "realbud.portal-recipes.v1" as const;
export const PORTAL_RECIPE_VERBS = ["nav", "check", "type", "select", "radio", "click", "wait", "read", "paginate", "upload", "download", "run"] as const;
export type PortalRecipeVerb = (typeof PORTAL_RECIPE_VERBS)[number];
export type PortalRecipeStep = { [verb in PortalRecipeVerb]?: unknown };
export interface PortalPackRecipe {
  kind: "read" | "prepare" | "study";
  tier: string[];
  inputs: string[];
  /** Grant action classes beyond reading this recipe needs (upload, download). */
  grantNeeds: string[];
  steps: PortalRecipeStep[];
  /** Labels that end Bud's part: never pressed by the runner. */
  stopBefore: string[];
  onUnknown?: string;
  success?: string;
}
export interface PortalRecipePack {
  schema: typeof PORTAL_RECIPE_SCHEMA;
  portal: string;
  pack: string;
  origin: string;
  uiVersion: string;
  signIn: { hosts: string[]; texts: string[] };
  /** The selected account: a URL query parameter and a marker shown on every page. */
  account: { urlParam: string; pageMarker: { landmark: string; role: string } };
  versionMarker: { landmark: string; pattern: string };
  /** `landmark`: the pager group exactly (role + name). Null until confirmed on the live portal: paging then asks. */
  pagination: { next: string; previous?: string; landmark: { role: string; name: string } | null; landmarkStatus?: string };
  labels: { readSafe: string[]; consequential: string[]; forbiddenAreas: string[] };
  screens: Array<{ id: string; label: string; menu: string[]; route: string; stop: string[] }>;
  /** Menu path joined with " › " → route without query. */
  routes: Record<string, string>;
  recipes: Record<string, PortalPackRecipe>;
  batches: Record<string, string[]>;
}

const INVALID_PACK = "These portal recipes are damaged or from another version. Regenerate them from the pack's website map.";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
/** Validates a pack's recipes document. Unknown verbs, a non-HTTPS origin, a
 * label both read-safe and consequential, or a missing recipe reference are rejected. */
export function parsePortalRecipePack(value: unknown): PortalRecipePack {
  const fail = (): never => { throw new Error(INVALID_PACK); };
  if (!object(value) || value.schema !== PORTAL_RECIPE_SCHEMA || typeof value.portal !== "string" || typeof value.origin !== "string") fail();
  const doc = value as unknown as PortalRecipePack;
  let origin: URL | null = null;
  try { origin = new URL(doc.origin); } catch { fail(); }
  if (!origin || origin.protocol !== "https:" || origin.origin !== doc.origin) fail();
  if (!object(doc.signIn) || !strings(doc.signIn.hosts) || !strings(doc.signIn.texts)) fail();
  if (!object(doc.account) || typeof doc.account.urlParam !== "string" || !object(doc.account.pageMarker)) fail();
  if (!object(doc.versionMarker) || typeof doc.versionMarker.pattern !== "string" || typeof doc.uiVersion !== "string") fail();
  if (!object(doc.labels) || !strings(doc.labels.readSafe) || !strings(doc.labels.consequential) || !strings(doc.labels.forbiddenAreas)) fail();
  if (doc.labels.readSafe.some(label => doc.labels.consequential.includes(label))) fail();
  if (!Array.isArray(doc.screens) || !object(doc.routes) || !object(doc.recipes) || !object(doc.batches) || !object(doc.pagination) || typeof doc.pagination.next !== "string" || (doc.pagination.previous !== undefined && typeof doc.pagination.previous !== "string") ||
    !(doc.pagination.landmark === null || object(doc.pagination.landmark) && typeof doc.pagination.landmark.role === "string" && typeof doc.pagination.landmark.name === "string")) fail();
  for (const recipe of Object.values(doc.recipes)) {
    if (!object(recipe) || !["read", "prepare", "study"].includes(String(recipe.kind)) || !Array.isArray(recipe.steps) ||
      !strings(recipe.stopBefore) || !strings(recipe.grantNeeds) || !strings(recipe.inputs)) fail();
    for (const step of recipe.steps) {
      const keys = object(step) ? Object.keys(step) : [];
      if (keys.length !== 1 || !(PORTAL_RECIPE_VERBS as readonly string[]).includes(keys[0])) fail();
      if (keys[0] === "run" && !Object.hasOwn(doc.recipes, String(step.run))) fail();
    }
    if (recipe.stopBefore.some(label => !doc.labels.consequential.includes(label))) fail();
  }
  for (const members of Object.values(doc.batches)) if (!strings(members) || members.some(name => !Object.hasOwn(doc.recipes, name))) fail();
  return structuredClone(doc);
}

