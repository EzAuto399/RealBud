// Generates the machine-readable REI Cloud recipes (recipes.json beside
// site-map.json in the Austin pack's rei-cloud-navigation folder) from the
// task-first website map, so the deterministic runner and the map cannot drift.
//
//   node scripts/rei-recipes.mjs --check   exit 1 when recipes.json or provenance's recipesSha256 differs
//   node scripts/rei-recipes.mjs --write   regenerate recipes.json and pin its sha256 in provenance.json
//                                          (the runtime loader refuses recipes whose digest differs)
//
// Recipes, screens and labels are copied verbatim from the map's YAML blocks;
// origin, sign-in host and UI version come from site-map.json / the map. The
// runner-facing adapter (where the account marker and version are shown, the
// pagination label, batches) is declared once here. Austin pack content, not
// RealBud core; it grants nothing: the RealBud broker decides every step.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REI_NAVIGATION_DIR = "pack/workflows/austin-accounts/support/rei-cloud-navigation";
export const REI_RECIPES_FILE = `${REI_NAVIGATION_DIR}/recipes.json`;
const sha256 = text => createHash("sha256").update(text).digest("hex");

/** Where the runner finds account scope and the UI version on a page. Declared for REI only. */
const ADAPTER = {
  // Live REI (6 Oct 2026, UI 26.0922.0) has no banner or footer landmark: the business code is the
  // first button in the top bar's list, and the version is in the first link ("REI Cloud v 26.0922.0 P").
  account: { urlParam: "reicid", pageMarker: { landmark: "list", role: "button" } },
  uiVersion: { landmark: "link", pattern: "v ([\\d.]+)" },
  signInTexts: ["Choose your account", "Sign in with your email address", "Sign In Cancelled"],
  // The pager group's exact role and name are not confirmed on live REI Cloud: until the read-only
  // live look records them here, no pager is read-safe and live paging falls back to asking.
  pagination: { next: "Next", previous: "Previous", landmark: null, landmarkStatus: "unconfirmed for live REI Cloud: set role and name from the read-only live look" },
  // Map labels that are not read-safe wherever they appear: Cancel can cancel a
  // record, and Close and Archived are not scoped to a screen in the map. They
  // stay out of read-safe until the map scopes them.
  notReadSafe: ["Cancel", "Close", "Archived"],
  // Live REI (6 Oct 2026): record lists are Syncfusion grids with no pager. Tenants renders its first 90 rows and loads
  // more only when the grid's own content scrolls (keys, wheel and scrolling a cell into view load nothing).
  grid: { scrollContainer: ".e-gridcontent .e-content" },
};
/** Read batches a person or loop can start under one grant. */
const BATCHES = { morning: ["open-session", "arrears-review", "tasks-due", "bank-reconciliation-read"] };

/** Pure: the recipes document for one map text and site map. */
export function buildReiRecipes(mapText, siteMapText) {
  const siteMap = JSON.parse(siteMapText);
  const blocks = [...mapText.matchAll(/```yaml\n([\s\S]*?)```/g)].map(match => parse(match[1]));
  const screens = blocks.find(block => block?.screens)?.screens ?? [];
  const labels = blocks.find(block => block?.read_safe_labels);
  const version = mapText.match(/mapped UI version \*\*([\d.]+)\*\*/)?.[1];
  if (!labels || !screens.length || !version) throw new Error("The website map is missing its screens, labels or UI version.");
  if (version !== siteMap.version) throw new Error(`The website map (${version}) and site-map.json (${siteMap.version}) disagree on the UI version.`);
  const routes = Object.fromEntries(screens.map(screen => [screen.menu.join(" › "), screen.route]));
  // site-map.json names the Dashboard route the map's screens omit.
  const dashboard = siteMap.routes.find(route => route.name === "Dashboard");
  if (dashboard && !routes.Dashboard) routes.Dashboard = dashboard.path;
  const recipes = {};
  for (const block of blocks.filter(item => item?.recipe)) {
    const { recipe, kind, tier, inputs, grant_needs, steps, row_filter, stop_before, on_unknown, success } = block;
    recipes[recipe] = {
      kind, tier, inputs: inputs ?? [], grantNeeds: grant_needs ?? [], steps: steps ?? [], ...(row_filter ? { rowFilter: row_filter } : {}), stopBefore: stop_before ?? [],
      ...(on_unknown ? { onUnknown: on_unknown } : {}), ...(success ? { success } : {}),
    };
  }
  for (const [name, members] of Object.entries(BATCHES)) for (const member of members) if (!recipes[member]) throw new Error(`Batch ${name} names a missing recipe ${member}.`);
  return {
    schema: "realbud.portal-recipes.v1",
    portal: siteMap.portal,
    pack: siteMap.pack,
    skill: siteMap.skill,
    scopeNote: "Austin Realty add-on pack content, not RealBud core. Generated by scripts/rei-recipes.mjs from references/website-map.md and site-map.json; do not edit by hand. Grants no authority: the RealBud browser broker decides every step.",
    generatedFrom: { map: "references/website-map.md", mapSha256: sha256(mapText), siteMap: "site-map.json", siteMapSha256: sha256(siteMapText) },
    origin: siteMap.origin,
    uiVersion: version,
    signIn: { hosts: [siteMap.signIn.host], texts: ADAPTER.signInTexts },
    account: ADAPTER.account,
    versionMarker: ADAPTER.uiVersion,
    pagination: ADAPTER.pagination,
    grid: ADAPTER.grid,
    labels: { readSafe: labels.read_safe_labels.filter(label => !ADAPTER.notReadSafe.includes(label)), consequential: labels.consequential_labels, forbiddenAreas: labels.forbidden_areas },
    // Money and upload screens from both site-map observations: the classifier treats them as financial pages.
    financialRoutes: [...new Set([...siteMap.routes, ...(siteMap.live2026_10_06?.menuTree ?? []).map(entry => ({ path: entry.route, class: entry.class }))]
      .filter(route => route.class === "money" || route.class === "upload")
      .map(route => route.path.split("?")[0].toLowerCase().replace(/\/+$/, "")))].sort(),
    screens: screens.map(screen => ({ id: screen.id, label: screen.label, menu: screen.menu, route: screen.route, stop: screen.stop ?? [] })),
    routes,
    recipes,
    batches: BATCHES,
  };
}

export const renderReiRecipes = document => `${JSON.stringify(document, null, 2)}\n`;

/** The committed recipes.json and what the current map would generate. */
export async function reiRecipesDrift(mapPath = join(root, REI_NAVIGATION_DIR, "references/website-map.md")) {
  const [mapText, siteMapText, committed] = await Promise.all([
    readFile(mapPath, "utf8"), readFile(join(root, REI_NAVIGATION_DIR, "site-map.json"), "utf8"), readFile(join(root, REI_RECIPES_FILE), "utf8").catch(() => ""),
  ]);
  const expected = renderReiRecipes(buildReiRecipes(mapText, siteMapText));
  return { expected, committed, drifted: expected !== committed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== "--check" && mode !== "--write") { console.error("Use --check or --write."); process.exit(2); }
  const { expected, drifted } = await reiRecipesDrift();
  const provenanceFile = join(root, REI_NAVIGATION_DIR, "provenance.json");
  const provenance = JSON.parse(await readFile(provenanceFile, "utf8"));
  if (mode === "--write") {
    await writeFile(join(root, REI_RECIPES_FILE), expected);
    if (provenance.recipesSha256 !== sha256(expected)) await writeFile(provenanceFile, `${JSON.stringify({ ...provenance, recipesSha256: sha256(expected) }, null, 2)}\n`);
    console.log(`wrote ${REI_RECIPES_FILE} and its provenance digest`);
  } else if (drifted || provenance.recipesSha256 !== sha256(expected)) { console.error(`${REI_RECIPES_FILE} or its provenance digest is out of date with the website map. Run node scripts/rei-recipes.mjs --write and review the diff.`); process.exit(1); }
  else console.log(`${REI_RECIPES_FILE} and its provenance digest match the website map.`);
}
