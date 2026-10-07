// A published watch-and-learn recipe and a person-approved path, both in the
// test's own DATA_DIR (the per-file test home, never ~/.realbud). Used to prove
// what unattended loops and W1 inherit: loops neither, W1 the path only.
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, ensureDirs } from "../config.ts";
import { createLearnedRecipeStore } from "../learned-recipes.ts";
import { checkPortalPathProposal, portalPaths } from "../portal-path-overrides.ts";
import { loadShippedPortalRecipePack } from "../portal-recipe-task.ts";

const testHome = (file: string) => { if (!process.env.HOME || !file.startsWith(process.env.HOME)) throw new Error("DATA_DIR is not the test home; refusing to write."); };

// Create the data folder at import, as the app does at launch, so on Windows it
// carries its own protected descriptor. Left to the first store that needs it
// (connected-app operations is a plain mkdir), it inherits the temp folder's
// ACL and every private store below is refused (windows-acl:inheritance-not-protected).
testHome(DATA_DIR); ensureDirs();

export const LEARNED_LEAK_RECIPE = "learned-loop-leak-check";
export const LEARNED_LEAK_LABEL = "Show fictional detail";

/** Publishes the recipe; returns a cleanup that removes the file. */
export async function publishLearnedInDataDir(): Promise<() => void> {
  const file = join(DATA_DIR, "learned-recipes.json");
  testHome(file);
  const store = createLearnedRecipeStore(file);
  const shipped = await loadShippedPortalRecipePack("rei-cloud");
  const draft = await store.create({ portal: "rei-cloud", title: "Loop leak check", steps: [{ click: LEARNED_LEAK_LABEL }, { read: "controls" }], stopBefore: [], flags: [] });
  const confirmed = await store.update(draft.id, draft.revision, { confirmedLabels: [LEARNED_LEAK_LABEL] }, shipped.labels);
  await store.publish(confirmed.id, confirmed.revision, shipped);
  return () => rmSync(file, { force: true });
}

/** An approved tenant-list path (Reports › export) on REI's own origin; returns a cleanup that restores the shipped path. */
export async function saveApprovedPathInDataDir(): Promise<() => Promise<void>> {
  testHome(DATA_DIR);
  const report = "Tenant Contact Export (fictional)";
  const steps = [{ verb: "nav", label: "Reports" }, { verb: "click", label: report }, { verb: "select", label: "Output", option: "Export Only" }, { verb: "download", label: "Export" }];
  const seen = [
    { tool: "click" as const, role: "link", label: "Reports", path: "/customers/dashboard", outcome: "succeeded" as const, at: 1 },
    { tool: "click" as const, role: "link", label: report, path: "/report/reportlist", outcome: "succeeded" as const, at: 2 },
    { tool: "select" as const, role: "combobox", label: "Output", path: "/report/reportlist", valuesHash: createHash("sha256").update(JSON.stringify(["Export Only"])).digest("hex"), outcome: "succeeded" as const, at: 3 },
    { tool: "download" as const, role: "button", label: "Export", path: "/report/reportlist", outcome: "succeeded" as const, at: 4 }];
  const shipped = await loadShippedPortalRecipePack("rei-cloud");
  await portalPaths().save("rei-cloud", checkPortalPathProposal(shipped, { slot: "tenant-list", steps }, seen), { grantId: "g", runId: "r", threadId: "t", origin: shipped.origin });
  return () => portalPaths().restore("rei-cloud", "tenant-list", null);
}
