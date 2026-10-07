// Watch and learn, end to end: a recording shaped like the real Chrome run
// (outputs/learn-record-2026-10-07/events.json) is compiled, reviewed and
// published through the learned-recipe store, merged into the pack and replayed
// by the real runner and broker over the FICTIONAL REI mock. No network, no REI
// account, no credentials. A pass proves the learned path runs through RealBud's
// authority path, never that REI Cloud behaves this way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { browserTaskWorkroom, BrowserRuntime } from "./browser-runtime.ts";
import { BrowserApprovalStore } from "./browser-authority.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { compileLearnedSteps } from "./learn-compile.ts";
import { createLearnedRecipeStore, mergeLearnedRecipes } from "./learned-recipes.ts";
import type { PortalRecipePack } from "./portal-recipe.ts";
import { portalRecipeGrantNeeds, runPortalRecipes, type PersonApprove, type PortalRunRequest } from "./portal-recipe-runner.ts";
import { portalRecipeTaskProposal } from "./portal-recipe-task.ts";
import { FICTIONAL_BUSINESS, FICTIONAL_REI_ORIGIN, FICTIONAL_REICID, fictionalReiPack, fictionalReiPortal } from "./testing/fictional-rei-portal.ts";
import { plantPrivateFile, privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { parseBrowserTaskGrant } from "../shared/browser-task.ts";
import type { LearnEvent, LearnStep } from "../shared/learned-recipes.ts";

const cleanup: string[] = [];
afterEach(async () => { for (const root of cleanup.splice(0)) await removeFixture(root); });
const tempRoot = (prefix: string) => { const root = privateTempRoot(join(tmpdir(), prefix)); cleanup.push(root); return root; };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The real recording's shape (sign-in, menu, a table page, typing, a select, a control the
 * recorder places outside main, then a consequential button) on screens the mock has. */
const RECORDING: LearnEvent[] = [
  { kind: "page", url: `${FICTIONAL_REI_ORIGIN}/`, table: false },
  { kind: "secret", landmark: "main" },
  // Live REI menu (6 Oct): Arrears sits under Process.
  { kind: "click", role: "link", name: "Process", landmark: "navigation" },
  { kind: "click", role: "link", name: "Arrears", landmark: "navigation" },
  { kind: "page", url: `${FICTIONAL_REI_ORIGIN}/customers/arrears/`, table: true },
  { kind: "type", field: "From day", landmark: "main" },
  { kind: "select", field: "Hide vacated tenants", landmark: "main" },
  // The pager is a navigation landmark, so the recorder reports its Next there.
  { kind: "click", role: "button", name: "Next", landmark: "navigation" },
  { kind: "click", role: "button", name: "Notice", landmark: "main" },
];
const PORTAL = "rei-cloud";

async function publishLearned(pack: PortalRecipePack) {
  const store = createLearnedRecipeStore(join(tempRoot("rb-learn-replay-store-"), "learned-recipes.json"));
  const compiled = compileLearnedSteps(RECORDING, pack);
  const draft = await store.create({ portal: PORTAL, title: "Arrears from day", ...compiled });
  // Review: nothing to acknowledge or confirm (Next became a paged read); the select is pinned to a fixed option.
  const steps = draft.steps.map(step => "select" in step ? { select: { ...step.select, option: "Yes" } } : step);
  const reviewed = await store.update(draft.id, draft.revision, { steps, flags: [], confirmedLabels: [] }, pack.labels);
  const published = await store.publish(reviewed.id, reviewed.revision, pack);
  return { compiled, published, merged: mergeLearnedRecipes(pack, await store.list()) };
}

describe("learned recipe: recorded → published → replayed (fictional REI mock)", () => {
  it("compiles, publishes and replays through the real broker, stopping before the consequential label", async () => {
    const pack = fictionalReiPack();
    const { compiled, published, merged } = await publishLearned(pack);
    expect(compiled).toEqual({
      steps: [{ nav: ["Process", "Arrears"] }, { wait: "table" }, { type: { field: "From day", value: "{from_day}" } },
        { select: { field: "Hide vacated tenants", option: "{hide_vacated_tenants}" } }, { wait: "table" }, { read: "table" }, { paginate: true }],
      inputs: ["from_day", "hide_vacated_tenants"], stopBefore: ["Notice"], flags: [],
    });
    // The reviewer pinned the option, so it is no longer asked each run.
    expect(published).toMatchObject({ state: "published", name: "learned-arrears-from-day", inputs: ["from_day"], stopBefore: ["Notice"], flags: [] });
    expect(merged.recipes[published.name]).toMatchObject({ kind: "read", steps: published.steps, stopBefore: ["Notice"] });
    expect(published.steps).toContainEqual({ select: { field: "Hide vacated tenants", option: "Yes" } });

    // The runner test's harness: real runtime, broker, grant, fence and approvals over the mock.
    const root = tempRoot("rb-learn-replay-run-");
    const mock = fictionalReiPortal();
    const runtime = new BrowserRuntime({ root, command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
    await runtime.connect(); await runtime.select("work");
    const person = vi.fn<PersonApprove>(async () => false);
    const runs: PortalRunRequest[] = [{ recipe: "open-session" }, { recipe: published.name, inputs: { from_day: "1" } }];
    const needs = portalRecipeGrantNeeds(merged, runs);
    expect(needs.actions).not.toContain("submit");
    const grantId = `grant-${randomUUID()}`; const text = `Fictional task: open-session, ${published.name}`;
    const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: grantId, runId: `run-${randomUUID()}`, route: "ask", request: { text, sha256: sha256(text) },
      sites: needs.sites, browser: { id: null, accountMarker: FICTIONAL_BUSINESS }, actions: needs.actions, consequential: "ask-each", uploads: [], expiresAt: null, budget: null });
    const run = await runPortalRecipes({ pack: merged, runs, grant, runtime, workroom: browserTaskWorkroom(root, grantId),
      operations: new ConnectedAppOperationStore({ file: join(root, "operations.json") }), threadId: "thread-fictional", approve: person,
      account: { urlValue: FICTIONAL_REICID, marker: FICTIONAL_BUSINESS }, approvals: new BrowserApprovalStore({ file: join(root, `approvals-${grantId}.json`) }),
      rules: () => [], assertCapability: () => {}, pollMs: 0 });

    expect(run.outcome, run.detail).toBe("completed");
    const learned = run.results[1];
    expect(learned).toMatchObject({ recipe: published.name, outcome: "completed", table: "rows", pages: 2 });
    // Every page: the recorded Next became the pack's own paged read.
    expect(learned.rows.map(row => row.Name).slice(0, 5)).toEqual(["Fictional Tenant Bravo", "Fictional Tenant Charlie", "Fictional Tenant Echo", "Fictional Tenant Golf", "Fictional Tenant Hotel"]);
    expect(learned.rows).toHaveLength(6);
    expect(learned.filters).toMatchObject({ "From day": "1", "Hide vacated tenants": "Yes" });
    // The receipt has one ok entry per learned step, in order, and holds a hash, never the typed value.
    const steps = run.receipt.steps.filter(step => step.recipe === published.name);
    expect(steps.map(step => step.verb)).toEqual(compiled.steps.map(step => Object.keys(step)[0]));
    expect(steps.every(step => step.ok)).toBe(true);
    expect(steps.find(step => step.verb === "type")).toMatchObject({ target: "From day", valueSha256: sha256("1") });
    // Notice was reached and reported, never pressed: Process › Arrears is a mapped route, so the only click is the pager's Next, and no effect happened.
    expect(learned.stopBefore).toContain("Notice");
    expect(mock.calls.filter(args => args[0] === "click")).toHaveLength(1);
    expect(run.receipt.steps.filter(step => step.recipe === published.name && step.verb === "paginate")).toMatchObject([{ target: "Next", ok: true }]);
    expect(mock.effects).toEqual([]);
    expect(person).not.toHaveBeenCalled();
    expect(run.receipt.approvals.person).toBe(0);
    expect((await runtime.status()).active).toBe(false);
  });

  it("never publishes a consequential click, and skips a tampered file that marks one published", async () => {
    const pack = fictionalReiPack();
    const steps: LearnStep[] = [{ nav: ["Tenants", "Arrears"] }, { wait: "table" }, { click: "Notice" }, { read: "table" }];
    const root = tempRoot("rb-learn-replay-tamper-");
    const store = createLearnedRecipeStore(join(root, "learned-recipes.json"));
    const draft = await store.create({ portal: PORTAL, title: "Arrears notice", steps, stopBefore: [], flags: [] });
    await expect(store.update(draft.id, draft.revision, { confirmedLabels: ["Notice"] }, pack.labels)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Notice changes records/) });
    await expect(store.publish(draft.id, draft.revision, pack)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/needs-confirm: Notice/) });
    expect((await store.list())[0].state).toBe("draft");

    // Someone edits the saved file by hand: published, with Notice confirmed. Next to it, an honest published recipe.
    const [saved] = await store.list();
    const honest = { ...saved, id: "lr_222222222222222222222222", name: "learned-arrears-read", state: "published", steps: [steps[0], steps[1], steps[3]] };
    const tamperedFile = join(tempRoot("rb-learn-replay-tampered-"), "learned-recipes.json");
    plantPrivateFile(tamperedFile, JSON.stringify({ version: 1, purpose: "realbud-learned-recipes", revision: 9,
      recipes: [{ ...saved, state: "published", confirmedLabels: ["Notice"] }, honest] }));
    const listed = await createLearnedRecipeStore(tamperedFile).list();
    expect(listed.map(item => [item.name, item.state])).toEqual([[saved.name, "published"], ["learned-arrears-read", "published"]]);
    const merged = mergeLearnedRecipes(pack, listed);
    expect(merged.recipes[saved.name]).toBeUndefined();
    expect(merged.recipes["learned-arrears-read"]).toBeDefined();
    expect(merged.labels.readSafe).not.toContain("Notice");
  });

  it("proposes the learned recipe from Ask as a read-only task", async () => {
    const { published, merged } = await publishLearned(fictionalReiPack());
    const load = vi.fn(async () => merged);
    const proposal = await portalRecipeTaskProposal({ threadId: "thread-fictional", messageId: "message-fictional", portal: PORTAL, target: published.name,
      inputs: { from_day: "1" }, account: { marker: FICTIONAL_BUSINESS } }, load);
    expect(load).toHaveBeenCalledWith(PORTAL);
    expect(proposal.recipe.runs).toEqual([{ recipe: "open-session", inputs: {} }, { recipe: published.name, inputs: { from_day: "1" } }]);
    expect(proposal.actions).toEqual(expect.arrayContaining(["read", "click", "navigate", "fill"]));
    for (const action of ["submit", "upload", "download", "pay", "send"]) expect(proposal.actions).not.toContain(action);
    expect(proposal.request).toMatch(/Read only: nothing is saved, sent or paid\./);
    expect(proposal.sites).toEqual([FICTIONAL_REI_ORIGIN, "https://signin.rei-mock.fictional.test"]);
  });
});
