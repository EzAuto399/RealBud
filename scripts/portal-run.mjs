// Run pack portal recipes through RealBud's browser broker, deterministically.
//
//   node scripts/portal-run.mjs rei arrears-review --fictional --input min_days=1
//   node scripts/portal-run.mjs rei morning --fictional --input date_from=2026-09-25 --input date_to=2026-09-30
//
// Only --fictional runs from here: a FICTIONAL REI-style portal played by the
// browser helper's command interface (server/testing/fictional-rei-portal.ts),
// with no network, account or credentials. The run goes through the real
// BrowserBroker with a grant built by the same validator and limited to what
// the recipes need, and nobody to approve anything the recipe cannot answer
// for, so consequential steps and uploads are refused.
//
// A live run is not started from a terminal: it needs the person's task
// permission (the Ask task grant), their selected browser and account, and
// their approval channel, which exist only inside the running app. This CLI
// never mints a grant for a live site. Prints the run's JSON (rows + receipt).
// Needs Node 24 (runs the server's TypeScript directly).
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORTALS = { rei: "pack/workflows/austin-accounts/support/rei-cloud-navigation/recipes.json" };
const args = process.argv.slice(2);
const [portal, target] = args;
const fictional = args.includes("--fictional");
// Rows per fictional page, to exercise pagination (for example the bank reconciliation grid).
const pageSize = args.includes("--page-size") ? Number(args[args.indexOf("--page-size") + 1]) || undefined : undefined;
const inputs = Object.fromEntries(args.flatMap((arg, index) => arg === "--input" && args[index + 1]?.includes("=") ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
const usage = "Usage: node scripts/portal-run.mjs rei <recipe|batch> --fictional [--page-size N] [--input key=value ...]";
if (!Object.hasOwn(PORTALS, portal ?? "") || !target) { console.error(usage); process.exit(2); }
if (!fictional) {
  console.error("Live portal runs start in RealBud with the person's task permission, selected browser and account, and their approvals. This command only runs the fictional mock (--fictional); it never opens a live account.");
  process.exit(2);
}

const { parsePortalRecipePack } = await import("../server/portal-recipe.ts");
const { runPortalRecipes, portalRecipeGrantNeeds } = await import("../server/portal-recipe-runner.ts");
const { BrowserRuntime } = await import("../server/browser-runtime.ts");
const { BrowserApprovalStore } = await import("../server/browser-authority.ts");
const { ConnectedAppOperationStore } = await import("../server/connected-app-operations.ts");
const { parseBrowserTaskGrant } = await import("../shared/browser-task.ts");
const mockModule = await import("../server/testing/fictional-rei-portal.ts");

const livePack = parsePortalRecipePack(JSON.parse(await readFile(join(root, PORTALS[portal]), "utf8")));
const pack = mockModule.fictionalReiPack();
const members = livePack.batches[target] ?? [target];
if (members.some(name => !pack.recipes[name])) { console.error(`No recipe or batch named ${target}.`); process.exit(2); }
const runs = members.map(recipe => ({ recipe, inputs }));
if (members[0] !== "open-session") runs.unshift({ recipe: "open-session", inputs: {} });

const work = await mkdtemp(join(tmpdir(), "realbud-portal-run-"));
try {
  const mock = mockModule.fictionalReiPortal(pageSize ? { pageSize } : {});
  const runtime = new BrowserRuntime({ root: work, command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  const needs = portalRecipeGrantNeeds(pack, runs);
  const text = `Fictional run: ${members.join(", ")}`;
  const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: `grant-${randomUUID()}`, runId: `run-${randomUUID()}`, route: "ask",
    request: { text, sha256: createHash("sha256").update(text).digest("hex") }, sites: needs.sites, browser: { id: null, accountMarker: mockModule.FICTIONAL_BUSINESS },
    actions: needs.actions, consequential: "ask-each", uploads: [], expiresAt: Date.now() + 10 * 60_000, budget: 400 });
  const result = await runPortalRecipes({ pack, runs, grant, runtime, threadId: "fictional-cli", pollMs: 0,
    account: { urlValue: mockModule.FICTIONAL_REICID, marker: mockModule.FICTIONAL_BUSINESS },
    operations: new ConnectedAppOperationStore({ file: join(work, "operations.json") }), approvals: new BrowserApprovalStore({ file: join(work, "approvals.json") }),
    rules: () => [], assertCapability: () => {} });
  console.log(JSON.stringify({ layer: "fictional mock through the RealBud browser broker; not REI Cloud", ...result, effects: mock.effects }, null, 2));
  process.exitCode = result.outcome === "completed" ? 0 : 1;
} finally { await rm(work, { recursive: true, force: true }); }
