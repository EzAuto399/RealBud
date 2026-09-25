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
// The pack file comes from a fixed list, never from a request. A terminal
// (scripts/portal-run.mjs) never reaches a live site: only this path does.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserApprovalProjection } from "./browser-broker.ts";
import type { BrowserJson, BrowserRuntime } from "./browser-runtime.ts";
import { validBrowserTaskRecipe, type BrowserTaskProposal, type BrowserTaskRecipe, type BrowserTaskRecord } from "./browser-grants.ts";
import { parsePortalRecipePack, type PortalRecipePack } from "./portal-recipe.ts";
import { portalRecipeGrantNeeds, runPortalRecipes, type PersonApprove, type PortalRunOptions, type PortalRunResult } from "./portal-recipe-runner.ts";
import { redactSecretsInText } from "./redact.ts";
import type { BrowserTaskGrant } from "../shared/browser-task.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Portal name → the workflow pack's recipes document. The only packs a task can name. */
export const PORTAL_RECIPE_PACKS: Readonly<Record<string, string>> = {
  "rei-cloud": "pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json",
};
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function loadPortalRecipePack(portal: string): Promise<PortalRecipePack> {
  if (!Object.hasOwn(PORTAL_RECIPE_PACKS, portal)) throw fail(404, "RealBud has no recipes for that portal.");
  const pack = parsePortalRecipePack(JSON.parse(await readFile(join(ROOT, PORTAL_RECIPE_PACKS[portal]), "utf8")));
  if (pack.portal !== portal) throw fail(409, "These portal recipes are damaged or from another version. Regenerate them from the pack's website map.");
  return pack;
}
export type PackLoader = (portal: string) => Promise<PortalRecipePack>;

/** The card for a recipe or batch: sites and action classes are exactly what the recipes need. */
export async function portalRecipeTaskProposal(input: { threadId: string; messageId: string; portal: unknown; target: unknown; inputs?: unknown; account: unknown }, load: PackLoader = loadPortalRecipePack): Promise<BrowserTaskProposal & { recipe: BrowserTaskRecipe }> {
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
  const recipe = { portal: input.portal, account: input.account,
    runs: names.map(name => ({ recipe: name, inputs: Object.fromEntries(reachable(name).flatMap(inner => pack.recipes[inner].inputs).map(field => [field, inputs[field]])) })) };
  if (!validBrowserTaskRecipe(recipe)) throw fail(400, "Give each recipe input and the account (its web address value and the name shown in the portal header).");
  // Read recipes only from Ask: a prepare recipe changes records and belongs to a reviewed job.
  if (names.flatMap(name => reachable(name)).some(name => pack.recipes[name].kind !== "read")) throw fail(400, "Only read recipes can run as a task from Ask.");
  const needs = portalRecipeGrantNeeds(pack, recipe.runs);
  return {
    threadId: input.threadId, messageId: input.messageId, siteSource: "request", savedJob: null,
    request: `Run the ${pack.portal} read recipes (${names.join(", ")}) for the account ${recipe.account.marker}. Read only: nothing is saved, sent or paid.`,
    sites: needs.sites, actions: needs.actions, recipe,
  };
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
  record: BrowserTaskRecord; grant: BrowserTaskGrant; runtime: BrowserRuntime; approve: PersonApprove;
  signal: AbortSignal; isActive: () => boolean; load?: PackLoader;
} & Pick<PortalRunOptions, "operations" | "approvals" | "rules" | "assertCapability" | "now" | "workroom" | "pollMs">): Promise<PortalRunResult> {
  const { record, grant } = input;
  if (!record.recipe || grant.route !== "ask" || grant.id !== record.id || grant.request.text !== record.request || record.status !== "active") {
    throw fail(409, "This portal task's saved permission does not match it. Ask again to start it.");
  }
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
