// Watch-and-learn drafts: review rules, revisions, the publish gate and the
// merge into a portal pack. Synthetic recordings against the fictional pack only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createLearnedRecipeStore, learnLabelRisky, mergeLearnedRecipes } from "./learned-recipes.ts";
import { fictionalReiPack } from "./testing/fictional-rei-portal.ts";
import { plantPrivateFile, privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import type { LearnedRecipe, LearnStep } from "../shared/learned-recipes.ts";

const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await removeFixture(root); });
function store() {
  const root = privateTempRoot(join(tmpdir(), "rb-learned-")); cleanup.push(root);
  const file = join(root, "learned-recipes.json");
  return { file, store: createLearnedRecipeStore(file) };
}
const STEPS: LearnStep[] = [
  { nav: ["Accounts", "Arrears"] },
  { type: { field: "Date from", value: "{date_from}" } },
  { click: "Search" },
  { click: "Show fictional detail" },
  { read: "table" },
];
const draft = { portal: "rei-cloud", title: "Arrears check", steps: STEPS, inputs: ["date_from"], stopBefore: [], flags: [{ code: "needs-confirm" as const, label: "Show fictional detail" }] };

describe("learned recipe store", () => {
  it("creates drafts with unique learned- names and recomputed inputs", async () => {
    const { store: s } = store();
    const a = await s.create(draft);
    const b = await s.create({ ...draft, inputs: [] });
    expect(a).toMatchObject({ id: expect.stringMatching(/^lr_[0-9a-f]{24}$/), name: "learned-arrears-check", state: "draft", revision: 1, inputs: ["date_from"], confirmedLabels: [] });
    expect(b.name).toBe("learned-arrears-check-2");
    expect(b.inputs).toEqual(["date_from"]);
    expect(await s.list()).toHaveLength(2);
    await expect(s.create({ ...draft, steps: [{ click: "x", extra: 1 } as unknown as LearnStep] })).rejects.toMatchObject({ status: 400 });
    await expect(s.create({ ...draft, steps: [{ nav: [] }] })).rejects.toMatchObject({ status: 400 });
    await expect(s.create({ ...draft, title: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("only lets review remove steps, change typed values, acknowledge flags and confirm non-consequential clicks", async () => {
    const { store: s } = store();
    const { labels } = fictionalReiPack();
    const r = await s.create({ ...draft, flags: [...draft.flags, { code: "unsupported", label: "Include closed" }] });
    // Remove a step and turn the input into fixed text.
    const edited = await s.update(r.id, 1, { steps: [STEPS[0], { type: { field: "Date from", value: "01/09/2026" } }, STEPS[2], STEPS[3]] }, labels);
    expect(edited).toMatchObject({ revision: 2, inputs: [] });
    expect(edited.steps).toHaveLength(4);
    // A renamed input is recomputed; removing the unconfirmed click drops its derived flag.
    const renamed = await s.update(r.id, 2, { steps: [{ type: { field: "Date from", value: "{start}" } }, STEPS[2]] }, labels);
    expect(renamed).toMatchObject({ inputs: ["start"], flags: [{ code: "unsupported", label: "Include closed" }] });
    // Stale revision.
    await expect(s.update(r.id, 2, { title: "x" }, labels)).rejects.toMatchObject({ status: 409, message: "This recipe changed elsewhere. Reload and try again." });
    // New, reordered or retargeted steps.
    await expect(s.update(r.id, 3, { steps: [{ click: "Delete Pending" }] }, labels)).rejects.toMatchObject({ status: 400 });
    await expect(s.update(r.id, 3, { steps: [STEPS[2], { type: { field: "Date from", value: "{start}" } }] }, labels)).rejects.toMatchObject({ status: 400 });
    await expect(s.update(r.id, 3, { steps: [{ type: { field: "Password", value: "{start}" } }] }, labels)).rejects.toMatchObject({ status: 400 });
    await expect(s.update(r.id, 3, { steps: [{ type: { field: "Date from", value: "{Bad Key}" } }] }, labels)).rejects.toMatchObject({ status: 400 });
    // Other flags: acknowledge, never add.
    await expect(s.update(r.id, 3, { flags: [{ code: "off-portal", label: "elsewhere" }] }, labels)).rejects.toMatchObject({ status: 400 });
    // Confirmed labels: only labels the recipe clicks.
    await expect(s.update(r.id, 3, { confirmedLabels: ["Show fictional detail"] }, labels)).rejects.toMatchObject({ status: 400 });
    const title = await s.update(r.id, 3, { title: "  Renamed  " }, labels);
    expect(title).toMatchObject({ title: "Renamed", revision: 4 });
    await expect(s.update("lr_000000000000000000000000", 1, {}, labels)).rejects.toMatchObject({ status: 404 });
  });

  it("derives needs-confirm flags from the steps and confirmations; consequential labels can't be confirmed", async () => {
    const { store: s } = store();
    const { labels } = fictionalReiPack();
    const r = await s.create({ ...draft, steps: [...STEPS, { click: "Process Receipts" }] });
    // Confirm: the derived flag goes even though the client sent the old flags.
    const confirmed = await s.update(r.id, 1, { confirmedLabels: ["Show fictional detail"], flags: r.flags }, labels);
    expect(confirmed.flags).toEqual([{ code: "needs-confirm", label: "Process Receipts" }]);
    // Unconfirm brings it back; a client can't drop it by omitting it.
    const unconfirmed = await s.update(r.id, 2, { confirmedLabels: [], flags: [] }, labels);
    expect(unconfirmed.flags.map(flag => flag.label)).toEqual(["Show fictional detail", "Process Receipts"]);
    expect((await s.update(r.id, 3, { flags: [] }, labels)).flags).toHaveLength(2);
    await expect(s.update(r.id, 4, { confirmedLabels: ["Process Receipts"] }, labels)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/changes records/) });
  });

  it("blocks publish until flags are cleared and clicks confirmed, then publishes into a parseable pack", async () => {
    const { store: s } = store();
    const pack = fictionalReiPack();
    const r = await s.create(draft);
    await expect(s.publish(r.id, 1, pack)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/needs-confirm: Show fictional detail/) });
    const reviewed = await s.update(r.id, 1, { confirmedLabels: ["Show fictional detail"] }, pack.labels);
    expect(reviewed.flags).toEqual([]);
    await expect(s.publish(r.id, 1, pack)).rejects.toMatchObject({ status: 409 });
    const published = await s.publish(r.id, reviewed.revision, pack);
    expect(published).toMatchObject({ state: "published", revision: 3 });
    await expect(s.update(r.id, 3, { title: "x" }, pack.labels)).rejects.toMatchObject({ status: 409 });
    const merged = mergeLearnedRecipes(pack, await s.list());
    expect(merged.recipes[r.name]).toMatchObject({ kind: "read", inputs: ["date_from"], grantNeeds: [], steps: STEPS });
    expect(merged.labels.readSafe).toContain("Show fictional detail");
    expect((await s.unpublish(r.id, 3)).state).toBe("draft");
    await s.remove(r.id, 4);
    expect(await s.list()).toEqual([]);
  });

  it("refuses to confirm a label that would save, confirm, submit or sign in", async () => {
    const { store: s } = store();
    const { labels } = fictionalReiPack();
    const risky = ["Save changes", "SAVE", "Finalise month", "OK", "Continue", "Sign in", "Confirm"];
    const r = await s.create({ ...draft, steps: [...risky.map(click => ({ click })), { click: "Show fictional detail" }, { read: "controls" }], flags: [] });
    for (const label of risky) {
      expect(learnLabelRisky(labels, label), label).toBe(true);
      await expect(s.update(r.id, 1, { confirmedLabels: [label] }, labels)).rejects.toMatchObject({ status: 400, message: `${label} changes records, so Bud stops before it and it can't be confirmed.` });
    }
    expect((await s.update(r.id, 1, { confirmedLabels: ["Show fictional detail"] }, labels)).confirmedLabels).toEqual(["Show fictional detail"]);
    expect(learnLabelRisky(labels, "Next")).toBe(false); // shipped read-safe
    expect(learnLabelRisky(labels, "Processed list")).toBe(false); // "Process" only as a whole word
  });

  it("blocks publishing a stored risky confirmation and accepts a paged read", async () => {
    const { file, store: s } = store();
    const pack = fictionalReiPack();
    const r = await s.create({ ...draft, steps: [{ click: "Save changes" }, { wait: "table" }, { read: "table" }, { paginate: true }], flags: [] });
    // A file written before this check, or edited by hand, can't publish it.
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.recipes[0].confirmedLabels = ["Save changes"];
    plantPrivateFile(file, JSON.stringify(doc));
    await expect(s.publish(r.id, 1, pack)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/consequential: Save changes/) });
    // Removing the risky click leaves the paged read, which publishes.
    const edited = await s.update(r.id, 1, { steps: [{ wait: "table" }, { read: "table" }, { paginate: true }], confirmedLabels: [] }, pack.labels);
    expect((await s.publish(r.id, edited.revision, pack)).state).toBe("published");
    expect(mergeLearnedRecipes(pack, await s.list()).recipes[r.name].steps).toEqual([{ wait: "table" }, { read: "table" }, { paginate: true }]);
  });

  it("holds every change on a damaged file and never clears it", async () => {
    const { file, store: s } = store();
    plantPrivateFile(file, "{not json");
    await expect(s.list()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/need recovery/) });
    await expect(s.create(draft)).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });
});

describe("mergeLearnedRecipes", () => {
  const base = (over: Partial<LearnedRecipe>): LearnedRecipe => ({ version: 1, purpose: "realbud-learned-recipe", id: "lr_111111111111111111111111", portal: "rei-cloud", name: "learned-one", title: "One",
    state: "published", steps: [{ click: "Search" }], inputs: [], stopBefore: [], confirmedLabels: [], flags: [], createdAt: 1, updatedAt: 1, revision: 1, ...over });

  it("adds only published, unblocked recipes for this portal and never overwrites a shipped name", () => {
    const pack = fictionalReiPack();
    const shipped = pack.recipes["open-session"];
    const merged = mergeLearnedRecipes(pack, [
      base({}),
      base({ name: "learned-draft", state: "draft" }),
      base({ name: "learned-other", portal: "other-portal" }),
      base({ name: "open-session", steps: [{ click: "Search" }] }),
      base({ name: "learned-flagged", flags: [{ code: "unsupported", label: "checkbox" }] }),
      base({ name: "learned-consequential", steps: [{ click: "Process Receipts" }], confirmedLabels: ["Process Receipts"] }),
    ]);
    expect(Object.keys(merged.recipes).filter(name => name.startsWith("learned-"))).toEqual(["learned-one"]);
    expect(merged.recipes["open-session"]).toEqual(shipped);
    expect(merged.labels.readSafe).not.toContain("Process Receipts");
  });

  it("checks each recipe against the shipped labels and skips only the bad one", () => {
    const pack = fictionalReiPack();
    const merged = mergeLearnedRecipes(pack, [
      // Confirms "Show detail"; a later recipe can't ride on that confirmation.
      base({ name: "learned-a", steps: [{ click: "Show detail" }], confirmedLabels: ["Show detail"] }),
      base({ name: "learned-rides", steps: [{ click: "Show detail" }] }),
      base({ name: "learned-risky", steps: [{ click: "Save changes" }], confirmedLabels: ["Save changes"] }),
      base({ name: "learned-ok-label", steps: [{ click: "OK" }], confirmedLabels: ["OK"] }),
      base({ name: "learned-bad-stop", stopBefore: ["Not a pack label"] }),
      base({ name: "learned-unparseable", steps: [{ bogus: "x" } as unknown as LearnStep] }),
      base({ name: "learned-last" }),
    ]);
    expect(Object.keys(merged.recipes).filter(name => name.startsWith("learned-"))).toEqual(["learned-a", "learned-last"]);
    expect(merged.labels.readSafe).toContain("Show detail");
    expect(merged.labels.readSafe).not.toContain("Save changes");
    expect(merged.labels.readSafe).not.toContain("OK");
  });

  it("publish checks the whole pack with the other published recipes", async () => {
    const { store: s } = store();
    const pack = fictionalReiPack();
    const a = await s.create({ ...draft, steps: [{ click: "Search" }, { read: "controls" }], flags: [] });
    await s.publish(a.id, 1, pack);
    const b = await s.create({ ...draft, title: "Second", steps: [{ click: "Search" }, { read: "controls" }], flags: [] });
    expect((await s.publish(b.id, 1, pack)).state).toBe("published");
    const merged = mergeLearnedRecipes(pack, await s.list());
    expect(Object.keys(merged.recipes).filter(name => name.startsWith("learned-"))).toEqual(["learned-arrears-check", "learned-second"]);
  });
});
