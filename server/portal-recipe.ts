// Versioned portal recipes. Candidates may auto-save; they never auto-publish.
import type { PortalRecipe } from "../shared/contracts.ts";
import type { PortalRecipeResult, PortalRunRequest } from "./portal-recipe-runner.ts";
import { GRID_SCROLL } from "./hermes-browser-transport.ts";

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
  /** Filters RealBud applies to the rows after the read (filterPortalRunRows), so a recipe never needs a portal's filter controls. */
  rowFilter?: PortalRowFilter[];
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
  /** A list grid that loads more rows only when its own container scrolls: the container's CSS selector. A `read: table` scrolls it. */
  grid?: { scrollContainer: string };
  labels: { readSafe: string[]; consequential: string[]; forbiddenAreas: string[] };
  /** Routes the map classes as money or upload (lowercase paths): the classifier treats them as financial pages. */
  financialRoutes?: string[];
  screens: Array<{ id: string; label: string; menu: string[]; route: string; stop: string[] }>;
  /** Menu path joined with " › " → route without query. */
  routes: Record<string, string>;
  recipes: Record<string, PortalPackRecipe>;
  batches: Record<string, string[]>;
}

/** Keep rows whose `column` cell, read `as` a number or a date, is `op` the run's `input`. */
export interface PortalRowFilter { column: string; op: ">=" | "<="; input: string; as: "number" | "date" }
const ROW_FILTER_KEYS = ["as", "column", "input", "op"].join();

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
  if (doc.grid !== undefined && (!object(doc.grid) || Object.keys(doc.grid).join() !== "scrollContainer" || typeof doc.grid.scrollContainer !== "string" || !GRID_SCROLL.test(doc.grid.scrollContainer))) fail();
  if (doc.financialRoutes !== undefined && (!strings(doc.financialRoutes) || doc.financialRoutes.some(route => !/^\/[a-z0-9/_-]*$/.test(route)))) fail();
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
    if (recipe.rowFilter !== undefined && (!Array.isArray(recipe.rowFilter) || recipe.rowFilter.some(filter => !object(filter) || Object.keys(filter).sort().join() !== ROW_FILTER_KEYS ||
      typeof filter.column !== "string" || !filter.column.trim() || !(filter.op === ">=" || filter.op === "<=") || !(filter.as === "number" || filter.as === "date") ||
      typeof filter.input !== "string" || !recipe.inputs.includes(filter.input)))) fail();
  }
  for (const members of Object.values(doc.batches)) if (!strings(members) || members.some(name => !Object.hasOwn(doc.recipes, name))) fail();
  return structuredClone(doc);
}


// ── row filters, after the read ───────────────────────────────────────────
const tidy = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
/** The row's key for a column: the header itself, or a DataTables header that reads "<name>: activate to sort column …". */
const columnKey = (row: Record<string, string>, column: string) => Object.keys(row).find(key => tidy(key) === tidy(column) || tidy(key).startsWith(`${tidy(column)}:`));
/** A number ("$1,320.00", "-3") or a date (YYYY-MM-DD or DD/MM/YYYY, time ignored) as a comparable value; null when unreadable. */
function comparable(text: string, as: PortalRowFilter["as"]): number | string | null {
  const clean = text.trim();
  if (as === "number") { const plain = clean.replace(/[$,\s]/g, ""); return /^-?\d+(\.\d+)?$/.test(plain) ? Number(plain) : null; }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(clean); if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(clean);
  return dmy ? `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}` : null;
}
/** Pure: the rows a recipe's row filters keep. A filter whose column no row shows, or whose input is unreadable, is not
 * applied (its column is listed in `unapplied`) and keeps every row; a row whose cell is unreadable fails that filter. */
export function filterPortalRows(recipe: Pick<PortalPackRecipe, "rowFilter">, inputs: Record<string, string>, rows: Array<Record<string, string>>): { rows: Array<Record<string, string>>; unapplied: string[] } {
  const unapplied: string[] = [];
  const active = (recipe.rowFilter ?? []).filter(filter => {
    const ok = comparable(inputs[filter.input] ?? "", filter.as) !== null && rows.some(row => columnKey(row, filter.column) !== undefined);
    if (!ok && rows.length) unapplied.push(filter.column);
    return ok;
  });
  const keep = (row: Record<string, string>) => active.every(filter => {
    const key = columnKey(row, filter.column);
    const cell = key === undefined ? null : comparable(row[key], filter.as), bound = comparable(inputs[filter.input], filter.as)!;
    return cell !== null && (filter.op === ">=" ? cell >= bound : cell <= bound);
  });
  return { rows: rows.filter(keep), unapplied: [...new Set(unapplied)] };
}
/** A read whose rows were filtered after the run: `read` is how many rows the portal showed, so completeness is judged on those. */
export type FilteredPortalResult = PortalRecipeResult & { filtered?: { read: number; unapplied: string[] } };
/** Each run's results with its recipe's row filters applied (sub-recipes use the run's inputs). The runner's rows are not changed. */
export function filterPortalRunRows(pack: PortalRecipePack, runs: readonly PortalRunRequest[], results: readonly PortalRecipeResult[]): FilteredPortalResult[] {
  const one = (result: PortalRecipeResult, inputs: Record<string, string>): FilteredPortalResult => {
    const sub = result.sub ? { sub: Object.fromEntries(Object.entries(result.sub).map(([name, inner]) => [name, one(inner, inputs)])) } : {};
    const recipe = pack.recipes[result.recipe];
    if (!recipe?.rowFilter?.length || result.table === "unread") return { ...result, ...sub };
    const kept = filterPortalRows(recipe, inputs, result.rows);
    return { ...result, ...sub, rows: kept.rows, filtered: { read: result.rows.length, unapplied: kept.unapplied } };
  };
  return results.map((result, index) => one(result, runs[index]?.inputs ?? {}));
}
