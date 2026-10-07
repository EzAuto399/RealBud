// A person-started portal recipe task: the live trigger for the recipe runner
// (server/portal-recipe-runner.ts). It rides the Ask browser task exactly:
//   1. propose  – a card is saved (server/browser-grants.ts) with the sites and
//                 action classes the recipes need, and nothing is allowed yet;
//   2. Start    – the person presses Start in Ask: the grant is saved, bound to
//                 their selected browser and the account marker they chose;
//   3. run      – RealBud's runner replays the recipes through the browser
//                 broker with that grant (no model turn). Anything the recipe
//                 cannot answer for goes to the person's approval card through
//                 this module's channel; Stop, expiry and the step limit end it.
// Ask starts read recipes, and an upload-and-preview recipe (UPLOAD_PREVIEW_RECIPES)
// only when bound to one reviewed file's {name, sha256}: the Start grant must list
// that exact file, and the upload itself is still asked once of the person.
// The pack file comes from a fixed list, never from a request. A terminal
// (scripts/portal-run.mjs) never reaches a live site: only this path does.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserApprovalProjection } from "./browser-broker.ts";
import type { BrowserJson } from "./browser-runtime.ts";
import type { BrowserSessionRuntime } from "./browser-session.ts";
import { validBrowserTaskRecipe, type BrowserTaskProposal, type BrowserTaskRecipe, type BrowserTaskRecord } from "./browser-grants.ts";
import { parsePortalRecipePack, type PortalRecipePack } from "./portal-recipe.ts";
import { portalRecipeGrantNeeds, runPortalRecipes, type PersonApprove, type PortalRunOptions, type PortalRunResult } from "./portal-recipe-runner.ts";
import { jobBrowserUrl } from "./browser-authority.ts";
import { portalPaths, type PortalPathStore } from "./portal-path-overrides.ts";
import { createLearnedRecipeStore, mergeLearnedRecipes } from "./learned-recipes.ts";
import { redactSecretsInText } from "./redact.ts";
import { browserTaskUploadName, LOOP_READ_ACTIONS, type BrowserTaskGrant } from "../shared/browser-task.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Portal name → the workflow pack's recipes document. The only packs a task can name. */
export const PORTAL_RECIPE_PACKS: Readonly<Record<string, string>> = {
  "rei-cloud": "pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json",
};
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** The pack as shipped in the repo, without learned paths or recipes: what watch-and-learn review compares click labels against. */
export async function loadShippedPortalRecipePack(portal: string): Promise<PortalRecipePack> {
  if (!Object.hasOwn(PORTAL_RECIPE_PACKS, portal)) throw fail(404, "RealBud has no recipes for that portal.");
  const pack = parsePortalRecipePack(JSON.parse(await readFile(join(ROOT, PORTAL_RECIPE_PACKS[portal]), "utf8")));
  if (pack.portal !== portal) throw fail(409, "These portal recipes are damaged or from another version. Regenerate them from the pack's website map.");
  return pack;
}

/** The pack's recipes from the repo, with any path Bud learned and the person allowed (server/portal-path-overrides.ts) over them. */
export async function loadPortalRecipePack(portal: string, paths: PortalPathStore = portalPaths()): Promise<PortalRecipePack> {
  const pack = await paths.apply(await loadShippedPortalRecipePack(portal));
  // Published watch-and-learn recipes join as read recipes; a damaged learned file never breaks the shipped ones.
  try {
    const { DATA_DIR } = await import("./config.ts");
    return mergeLearnedRecipes(pack, await createLearnedRecipeStore(join(DATA_DIR, "learned-recipes.json")).list());
  } catch {
    console.warn("[learn] Learned recipes could not be added; using the shipped portal recipes only.");
    return pack;
  }
}
export type PackLoader = (portal: string) => Promise<PortalRecipePack>;

/** The mapped portal an Ask task's grant includes (its exact origin), with learned paths applied; null when none. */
export async function portalMapForSites(sites: readonly string[], load: PackLoader = loadPortalRecipePack, paths: PortalPathStore = portalPaths()): Promise<{ portal: string; pack: PortalRecipePack } | null> {
  for (const portal of Object.keys(PORTAL_RECIPE_PACKS)) {
    const pack = await paths.apply(await load(portal));
    if (jobBrowserUrl(`${pack.origin}/`, sites)) return { portal, pack };
  }
  return null;
}

/** The card for a recipe or batch: sites and action classes are exactly what the recipes need. */
export async function portalRecipeTaskProposal(input: { threadId: string; messageId: string; portal: unknown; target: unknown; inputs?: unknown; account: unknown; upload?: unknown }, load: PackLoader = loadPortalRecipePack): Promise<BrowserTaskProposal & { recipe: BrowserTaskRecipe }> {
  if (typeof input.portal !== "string" || typeof input.target !== "string") throw fail(400, "Choose the portal and the recipe to run.");
  const pack = await load(input.portal);
  const members = Object.hasOwn(pack.batches, input.target) ? pack.batches[input.target] : Object.hasOwn(pack.recipes, input.target) ? [input.target] : null;
  if (!members) throw fail(404, `There is no recipe or batch named ${input.target.slice(0, 64)} for this portal.`);
  // Every run opens the session first: it checks the account and the portal version before anything else.
  const names = members[0] === "open-session" || !pack.recipes["open-session"] ? members : ["open-session", ...members];
  const inputs = input.inputs && typeof input.inputs === "object" && !Array.isArray(input.inputs) ? input.inputs as Record<string, unknown> : {};
  // A recipe and the recipes it runs share one set of inputs.
  const reachable = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) return []; seen.add(name);
    return [name, ...pack.recipes[name].steps.flatMap(step => "run" in step ? reachable(String(step.run), seen) : [])];
  };
  // Read recipes only from Ask, apart from an upload-and-preview recipe bound to one reviewed file:
  // other prepare recipes change records and belong to a reviewed job.
  const prepare = [...new Set(names.flatMap(name => reachable(name)))].filter(name => pack.recipes[name].kind !== "read");
  const upload = prepare.length ? uploadBinding(input.upload, prepare, inputs) : null;
  const recipe = { portal: input.portal, account: input.account,
    runs: names.map(name => ({ recipe: name, inputs: Object.fromEntries([...reachable(name).flatMap(inner => pack.recipes[inner].inputs).map(field => [field, inputs[field]]),
      ...(upload && reachable(name).some(inner => UPLOAD_PREVIEW_RECIPES.has(inner)) ? [["approved_sha256", upload.sha256]] : [])]) })) };
  if (!validBrowserTaskRecipe(recipe)) throw fail(400, "Give each recipe input and the account (the business code shown in the portal header; its web address value only if saved).");
  const needs = portalRecipeGrantNeeds(pack, recipe.runs);
  return {
    threadId: input.threadId, messageId: input.messageId, siteSource: "request", savedJob: null,
    request: upload
      ? `Run the ${pack.portal} recipes (${names.join(", ")}) for the account ${recipe.account.marker}: upload only the reviewed file ${upload.name} (sha256 ${upload.sha256}) after your approval, then read the preview. Bud stops before ${[...new Set(prepare.flatMap(name => pack.recipes[name].stopBefore))].join(", ")}; posting stays with you.`
      : `Run the ${pack.portal} read recipes (${names.join(", ")}) for the account ${recipe.account.marker}. Read only: nothing is saved, sent or paid.`,
    sites: needs.sites, actions: needs.actions, recipe,
  };
}

/** Prepare recipes Ask may start: they upload one reviewed file into a preview and stop before
 * anything that posts. Each needs the file's exact name and sha256, which the Start grant must list. */
export const UPLOAD_PREVIEW_RECIPES: ReadonlySet<string> = new Set(["bulk-receipting-preview"]);
const SHA256 = /^[0-9a-f]{64}$/;
function uploadBinding(value: unknown, prepare: string[], inputs: Record<string, unknown>): { name: string; sha256: string } {
  if (prepare.some(name => !UPLOAD_PREVIEW_RECIPES.has(name))) throw fail(400, "Only read recipes can run as a task from Ask.");
  const upload = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!upload || Object.keys(upload).length !== 2 || !browserTaskUploadName(upload.name) || typeof upload.sha256 !== "string" || !SHA256.test(upload.sha256)) {
    throw fail(400, "An upload recipe needs the reviewed file's exact name and sha256.");
  }
  if (inputs.approved_file !== upload.name) throw fail(400, "The file this recipe uploads must be the reviewed file.");
  return { name: upload.name, sha256: upload.sha256 };
}
/** Every run that uploads names a file the grant lists with the same hash; anything else is refused before the browser. */
function assertUploadBinding(recipe: BrowserTaskRecipe, grant: BrowserTaskGrant): void {
  for (const run of recipe.runs) {
    if (run.inputs.approved_file === undefined && run.inputs.approved_sha256 === undefined) continue;
    const granted = grant.uploads.find(upload => upload.name === run.inputs.approved_file);
    if (!granted || granted.sha256 !== run.inputs.approved_sha256 || !grant.actions.includes("upload")) {
      throw fail(409, "The file given to this task is not the reviewed file. Nothing was uploaded; attach the reviewed file and ask again.");
    }
  }
}

// ── the person's approval channel for a running recipe task ────────────────
// The host shows each ask as its ordinary approval card and answers it here.
export interface PortalRecipeAsk { requestId: string; tool: string; params: BrowserJson; summary: string; projection?: BrowserApprovalProjection }
const pending = new Map<string, (allowed: boolean, byPerson: boolean) => void>();
const running = new Set<string>();
const key = (threadId: string, requestId: string) => `${threadId}:${requestId}`;
export const PORTAL_RECIPE_ASK_MS = 5 * 60_000;
/** `open` shows the card; `settled` closes it (`byPerson` false: Stop, expiry or the timeout). */
export function portalRecipeApprovalChannel(threadId: string, open: (ask: PortalRecipeAsk) => void, settled: (requestId: string, allowed: boolean, byPerson: boolean) => void): PersonApprove {
  return (tool, params, summary, signal, projection) => new Promise<boolean>(resolve => {
    if (signal.aborted) { resolve(false); return; }
    const requestId = `recipe-${randomUUID()}`;
    const finish = (allowed: boolean, byPerson: boolean) => {
      if (!pending.delete(key(threadId, requestId))) return;
      clearTimeout(timer); signal.removeEventListener("abort", aborted);
      const ok = allowed && !signal.aborted;
      try { settled(requestId, ok, byPerson); } catch { /* the card still expires */ }
      resolve(ok);
    };
    const aborted = () => finish(false, false);
    const timer = setTimeout(aborted, PORTAL_RECIPE_ASK_MS); timer.unref?.();
    pending.set(key(threadId, requestId), finish);
    signal.addEventListener("abort", aborted, { once: true });
    try { open({ requestId, tool, params, summary, ...(projection ? { projection } : {}) }); } catch { finish(false, false); }
  });
}
/** True when the request belonged to a recipe task (answered here). */
export function answerPortalRecipeAsk(threadId: string, requestId: string, allowed: boolean): boolean {
  const finish = pending.get(key(threadId, requestId));
  if (!finish) return false;
  finish(allowed, true); return true;
}
const dispatching = new Set<string>();
/** A model turn never mounts a recipe task's grant. The host holds it from Start
 * (in the same tick the grant becomes live) until the task ends. */
export const portalRecipeTaskRunning = (grantId: string | undefined): boolean => grantId !== undefined && running.has(grantId);
export function holdPortalRecipeGrant(grantId: string): void { running.add(grantId); }
export function releasePortalRecipeGrant(grantId: string): void { running.delete(grantId); }

/** Runs a started recipe task with its saved grant. The record, not the caller, says what runs. */
export async function runPortalRecipeTask(input: {
  record: BrowserTaskRecord; grant: BrowserTaskGrant; runtime: BrowserSessionRuntime; approve: PersonApprove;
  signal: AbortSignal; isActive: () => boolean; load?: PackLoader;
} & Pick<PortalRunOptions, "operations" | "approvals" | "rules" | "assertCapability" | "now" | "workroom" | "pollMs">): Promise<PortalRunResult> {
  const { record, grant } = input;
  if (!record.recipe || grant.route !== "ask" || grant.id !== record.id || grant.request.text !== record.request || record.status !== "active") {
    throw fail(409, "This portal task's saved permission does not match it. Ask again to start it.");
  }
  assertUploadBinding(record.recipe, grant);
  if (dispatching.has(grant.id)) throw fail(409, "This portal task is already running.");
  // Held here too when no host holds it (a direct call); a host's hold outlives the run.
  const own = !running.has(grant.id);
  dispatching.add(grant.id); running.add(grant.id);
  try {
    const pack = await (input.load ?? loadPortalRecipePack)(record.recipe.portal);
    return await runPortalRecipes({
      pack, runs: record.recipe.runs, account: record.recipe.account, grant, threadId: record.threadId, runtime: input.runtime,
      approve: input.approve, signal: input.signal, isActive: input.isActive,
      ...(input.operations ? { operations: input.operations } : {}), ...(input.approvals ? { approvals: input.approvals } : {}),
      ...(input.rules ? { rules: input.rules } : {}), ...(input.assertCapability ? { assertCapability: input.assertCapability } : {}),
      ...(input.now ? { now: input.now } : {}), ...(input.workroom ? { workroom: input.workroom } : {}), ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
    });
  } finally { dispatching.delete(grant.id); if (own) running.delete(grant.id); }
}

// ── a loop's unattended read (route loop-read) ──────────────────────────────
/** The pack's site map: each route's risk class (read, local-ui, export, upload, money, send, record-change, never). */
export interface PortalSiteMap { routes: Array<{ path: string; class: string }> }
/** The site map beside the pack's recipes document, from the same fixed list. */
export async function loadPortalSiteMap(portal: string): Promise<PortalSiteMap> {
  if (!Object.hasOwn(PORTAL_RECIPE_PACKS, portal)) throw fail(404, "RealBud has no site map for that portal.");
  const map = JSON.parse(await readFile(join(ROOT, dirname(PORTAL_RECIPE_PACKS[portal]), "site-map.json"), "utf8")) as { portal?: unknown; routes?: unknown };
  if (map.portal !== portal || !Array.isArray(map.routes) || !map.routes.every(route => typeof route?.path === "string" && typeof route?.class === "string")) {
    throw fail(409, "This portal's site map is damaged or from another version.");
  }
  return { routes: map.routes.map(({ path, class: risk }) => ({ path, class: risk })) };
}

/** Why these runs cannot go under a loop's read-only grant, or null. Every recipe they reach must be a read recipe
 * whose every step is read-class: menu paths to routes the site map calls `read`, filters and declared read-safe
 * controls only on such a page, and never an upload, download, a learned step that asks, or a non-read recipe. */
export function loopReadRefusal(pack: PortalRecipePack, map: PortalSiteMap, runs: ReadonlyArray<{ recipe: string; inputs?: Record<string, string> }>): string | null {
  const classOf = (route: string) => map.routes.find(row => row.path.split("?")[0] === route)?.class ?? "unmapped";
  const readSafe = new Set(pack.labels.readSafe), consequential = new Set(pack.labels.consequential);
  const check = (name: string, inputs: Record<string, string>, seen: Set<string>): string | null => {
    const recipe = pack.recipes[name];
    if (!recipe) return `There is no recipe named ${name}.`;
    if (seen.has(name)) return null; seen.add(name);
    if (recipe.kind !== "read" || recipe.grantNeeds.length) return `${name} is not a read recipe.`;
    const fill = (value: unknown) => String(value).replace(/\{(\w+)\}/g, (_, key: string) => inputs[key] ?? `{${key}}`);
    let page: string | null = null;
    for (const step of recipe.steps) {
      const [verb, raw] = Object.entries(step)[0];
      if (verb === "check" || verb === "wait" || verb === "read" || verb === "paginate") continue;
      if (verb === "run") { const inner = check(String(raw), inputs, seen); if (inner) return inner; continue; }
      if (verb === "nav") {
        const path = (raw as unknown[]).map(fill).join(" › ");
        const route = pack.routes[path];
        page = route ? classOf(route) : "unmapped";
        if (page !== "read" || pack.labels.forbiddenAreas.some(area => path === area || path.startsWith(`${area} › `))) return `${name} opens ${path}, which the site map does not call a read page.`;
        continue;
      }
      if (page !== "read") return `${name} acts before it opens a read page.`;
      if (verb === "type" || verb === "select") {
        const field = fill((raw as Record<string, unknown>).field);
        if (consequential.has(field)) return `${name} fills ${field}, which can change records.`;
        continue;
      }
      if (verb === "click" || verb === "radio") {
        const label = typeof raw === "string" ? fill(raw) : null;
        if (label === null || !readSafe.has(label) || consequential.has(label)) return `${name} presses a control the site map does not call read-safe.`;
        continue;
      }
      return `${name} has a ${verb} step, which is not a read.`;
    }
    return null;
  };
  for (const run of runs) { const refused = check(run.recipe, run.inputs ?? {}, new Set()); if (refused) return refused; }
  return null;
}

/** Runs read recipes under a loop's read-only grant: nobody is asked, so anything beyond reading ends the run. The
 * recipes are checked against the site map before the browser is touched; the broker then refuses every step that
 * is not plainly read-only (server/browser-authority.ts), whatever a recipe tries. */
export async function runPortalReadLoop(input: {
  pack: PortalRecipePack; map: PortalSiteMap; runs: PortalRunOptions["runs"]; account: PortalRunOptions["account"];
  grant: BrowserTaskGrant; runtime: BrowserSessionRuntime; threadId: string; signal: AbortSignal;
} & Pick<PortalRunOptions, "operations" | "approvals" | "rules" | "assertCapability" | "now" | "workroom" | "pollMs">): Promise<PortalRunResult> {
  const { grant } = input;
  if (grant.route !== "loop-read" || grant.uploads.length || grant.actions.some(action => !(LOOP_READ_ACTIONS as readonly string[]).includes(action))) {
    throw fail(409, "This scheduled read's permission is not read-only. Nothing was opened.");
  }
  const refused = loopReadRefusal(input.pack, input.map, input.runs);
  if (refused) throw fail(409, `${refused} A scheduled refresh only reads, so nothing was opened.`);
  if (dispatching.has(grant.id)) throw fail(409, "This portal read is already running.");
  dispatching.add(grant.id); running.add(grant.id);
  try {
    // No `approve`: the runner refuses anything a person would have to answer.
    // Only the site map's read pages may have their grid scrolled to load every row.
    const readRoutes = input.map.routes.filter(route => route.class === "read").map(route => route.path.split("?")[0]);
    return await runPortalRecipes({
      pack: input.pack, runs: input.runs, account: input.account, grant, threadId: input.threadId, runtime: input.runtime, signal: input.signal, readRoutes,
      ...(input.operations ? { operations: input.operations } : {}), ...(input.approvals ? { approvals: input.approvals } : {}),
      ...(input.rules ? { rules: input.rules } : {}), ...(input.assertCapability ? { assertCapability: input.assertCapability } : {}),
      ...(input.now ? { now: input.now } : {}), ...(input.workroom ? { workroom: input.workroom } : {}), ...(input.pollMs !== undefined ? { pollMs: input.pollMs } : {}),
    });
  } finally { dispatching.delete(grant.id); running.delete(grant.id); }
}

/** What the person reads in Ask afterwards: outcome, rows read, and where it stopped. */
export function portalRecipeTaskReply(result: PortalRunResult): string {
  // Only a finished run that nobody was asked about is known to have only read.
  const readOnly = result.outcome === "completed" && result.receipt.approvals.person === 0;
  const lines = [result.outcome === "completed" ? "The portal read finished." : `The portal read ended early (${result.reason ?? result.outcome}).`,
    readOnly ? "Nothing was saved, sent or paid." : "RealBud cannot confirm what changed in the portal. Check it there before relying on this."];
  if (result.detail) lines.push(result.detail);
  for (const item of result.results) {
    if (item.outcome === "not-run" || item.recipe === "open-session") continue;
    lines.push(`\n**${item.recipe}**: ${item.table === "unread" ? "not read" : `${item.rows.length} row${item.rows.length === 1 ? "" : "s"} over ${item.pages} page${item.pages === 1 ? "" : "s"}`}${item.stopBefore.length ? `; stopped before ${item.stopBefore.join(", ")}` : ""}.`);
    for (const row of item.rows.slice(0, 20)) lines.push(`- ${Object.values(row).join(" | ")}`);
    if (item.rows.length > 20) lines.push(`- …and ${item.rows.length - 20} more.`);
  }
  if (result.receipt.flags.length) lines.push(`\nCheck: ${result.receipt.flags.join("; ")}.`);
  return redactSecretsInText(lines.join("\n")).slice(0, 8000);
}
