// A published watch-and-learn recipe in the test's own DATA_DIR (the per-file
// test home, never ~/.realbud), with a reviewer-confirmed label. Used to prove
// that unattended loops and W1 never inherit learned recipes or labels.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { createLearnedRecipeStore } from "../learned-recipes.ts";
import { loadShippedPortalRecipePack } from "../portal-recipe-task.ts";

export const LEARNED_LEAK_RECIPE = "learned-loop-leak-check";
export const LEARNED_LEAK_LABEL = "Show fictional detail";

/** Publishes the recipe; returns a cleanup that removes the file. */
export async function publishLearnedInDataDir(): Promise<() => void> {
  const file = join(DATA_DIR, "learned-recipes.json");
  if (!process.env.HOME || !file.startsWith(process.env.HOME)) throw new Error("DATA_DIR is not the test home; refusing to write learned recipes.");
  const store = createLearnedRecipeStore(file);
  const shipped = await loadShippedPortalRecipePack("rei-cloud");
  const draft = await store.create({ portal: "rei-cloud", title: "Loop leak check", steps: [{ click: LEARNED_LEAK_LABEL }, { read: "controls" }], stopBefore: [], flags: [] });
  const confirmed = await store.update(draft.id, draft.revision, { confirmedLabels: [LEARNED_LEAK_LABEL] }, shipped.labels);
  await store.publish(confirmed.id, confirmed.revision, shipped);
  return () => rmSync(file, { force: true });
}
