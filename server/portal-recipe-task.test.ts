// A portal recipe task started from Ask: the card is saved from the pack's
// needs, Start saves the grant (sites include the sign-in host, the selected
// account marker is bound), and RealBud's runner replays the recipes through
// the real broker against the FICTIONAL REI-style portal. No network, no REI
// account, no credentials: this proves the wiring, never REI Cloud behaviour.
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserApprovalStore } from "./browser-authority.ts";
import { BrowserTaskStore } from "./browser-grants.ts";
import { addBrowserTaskUpload, BrowserRuntime } from "./browser-runtime.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { answerPortalRecipeAsk, holdPortalRecipeGrant, releasePortalRecipeGrant, learnedReadSafe, loadPortalRecipePack, portalTaskPack, portalRecipeApprovalChannel, verifiedShippedRecipesText, portalRecipeTaskProposal, portalRecipeTaskReply, portalRecipeTaskRunning, runPortalRecipeTask, type PortalRecipeAsk } from "./portal-recipe-task.ts";
import { FICTIONAL_BUSINESS, FICTIONAL_REICID, fictionalReiPack, fictionalReiPortal } from "./testing/fictional-rei-portal.ts";
import { plantPrivateFile, privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { DATA_DIR } from "./config.ts";
import { LEARNED_RECIPES_DAMAGED, mergeLearnedRecipes } from "./learned-recipes.ts";
import type { LearnedRecipe } from "../shared/learned-recipes.ts";
import type { PortalPathStore } from "./portal-path-overrides.ts";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const NOW = Date.now();
const ACCOUNT = { urlValue: FICTIONAL_REICID, marker: FICTIONAL_BUSINESS };
const fictional = async () => fictionalReiPack();
const MORNING_INPUTS = { min_days: "1", date_from: "2026-09-25", date_to: "2026-09-30" };

async function fixture(portal: Parameters<typeof fictionalReiPortal>[0] = {}) {
  const root = privateTempRoot(join(tmpdir(), "rb-recipe-task-")); cleanup.push(() => removeFixture(root));
  const store = new BrowserTaskStore({ file: join(root, "browser-tasks.json") });
  const mock = fictionalReiPortal(portal);
  const runtime = new BrowserRuntime({ root, command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  const stores = { operations: new ConnectedAppOperationStore({ file: join(root, "operations.json") }), approvals: new BrowserApprovalStore({ file: join(root, "approvals.json") }),
    rules: () => [], assertCapability: () => {}, pollMs: 0, workroom: join(root, "work") };
  return { root, store, mock, runtime, stores };
}

describe("portal recipe task cards", () => {
  it("proposes exactly what the recipes need, including the sign-in host, and only read recipes", async () => {
    const live = await portalRecipeTaskProposal({ threadId: "thread-ask", messageId: "m1", portal: "rei-cloud", target: "morning", inputs: MORNING_INPUTS, account: ACCOUNT });
    expect(live.sites).toEqual(["https://app.reimasterapps.com.au", "https://reimasterapps.b2clogin.com"]);
    expect(live.actions).toEqual(expect.arrayContaining(["read", "click", "navigate", "fill", "keys"]));
    expect(live.actions).not.toContain("submit");
    expect(live.recipe.runs.map(run => run.recipe)).toEqual(["open-session", "arrears-review", "tasks-due", "bank-reconciliation-read"]);
    expect(live.recipe.runs[1].inputs).toEqual({ min_days: "1" });
    expect(live.request).toContain("Read only");
    // A single read recipe still opens the session first.
    expect((await portalRecipeTaskProposal({ threadId: "t", messageId: "m", portal: "rei-cloud", target: "bank-reconciliation-read", account: ACCOUNT })).recipe.runs.map(run => run.recipe)).toEqual(["open-session", "bank-reconciliation-read"]);
    await expect(portalRecipeTaskProposal({ threadId: "t", messageId: "m", portal: "rei-cloud", target: "receipt-register", inputs: MORNING_INPUTS, account: ACCOUNT })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Only read recipes/) });
    await expect(portalRecipeTaskProposal({ threadId: "t", messageId: "m", portal: "rei-cloud", target: "arrears-review", account: ACCOUNT })).rejects.toMatchObject({ status: 400 });
    await expect(portalRecipeTaskProposal({ threadId: "t", messageId: "m", portal: "rei-cloud", target: "morning", inputs: MORNING_INPUTS, account: { urlValue: "x" } })).rejects.toMatchObject({ status: 400 });
    await expect(portalRecipeTaskProposal({ threadId: "t", messageId: "m", portal: "../secrets", target: "morning", account: ACCOUNT })).rejects.toMatchObject({ status: 404 });
    await expect(portalRecipeTaskProposal({ threadId: "t", messageId: "m", portal: "rei-cloud", target: "nope", account: ACCOUNT })).rejects.toMatchObject({ status: 404 });
    expect((await loadPortalRecipePack("rei-cloud")).portal).toBe("rei-cloud");
  });

  it("loads the shipped recipes only when their text matches the reviewed digest", async () => {
    const real = await verifiedShippedRecipesText("rei-cloud");
    expect(JSON.parse(real).portal).toBe("rei-cloud");
    // A CRLF checkout of the same text passes; one changed byte, or a missing pin, is refused before anything is parsed.
    const read = (edit: (text: string, path: string) => string) => (path: string) => Promise.resolve(edit(readFileSync(path, "utf8"), path));
    expect(await verifiedShippedRecipesText("rei-cloud", read((text, path) => path.endsWith("recipes.json") ? text.replace(/\n/g, "\r\n") : text))).toBe(real);
    await expect(verifiedShippedRecipesText("rei-cloud", read((text, path) => path.endsWith("recipes.json") ? text.replace("\"read\"", "\"prepare\"") : text)))
      .rejects.toMatchObject({ status: 409, message: "These REI recipes were changed after review. Reinstall RealBud." });
    await expect(verifiedShippedRecipesText("rei-cloud", read((text, path) => path.endsWith("provenance.json") ? "{}" : text))).rejects.toMatchObject({ status: 409 });
    await expect(verifiedShippedRecipesText("../x")).rejects.toMatchObject({ status: 404 });
  });

  it("saves the recipe with the card, binds the account marker in the grant, and keeps older records loadable", async () => {
    const { store, root } = await fixture();
    const proposal = await portalRecipeTaskProposal({ threadId: "thread-ask", messageId: "m1", portal: "rei-cloud", target: "morning", inputs: MORNING_INPUTS, account: ACCOUNT }, fictional);
    const card = await store.propose(proposal, NOW);
    expect(card.recipe).toEqual(proposal.recipe);
    const started = await store.start(card.id, { threadId: "thread-ask", browserId: "work" }, NOW);
    expect(started.grant).toMatchObject({ route: "ask", sites: ["https://rei-mock.fictional.test", "https://signin.rei-mock.fictional.test"], browser: { id: "work", accountMarker: FICTIONAL_BUSINESS } });
    // A record written before recipe tasks existed (no `recipe`) still loads; a damaged recipe holds the store for recovery.
    const file = join(root, "browser-tasks.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const { recipe: _recipe, ...older } = saved.tasks[0];
    writeFileSync(file, JSON.stringify({ ...saved, tasks: [{ ...older, status: "finished", endedAt: NOW, endNote: "Finished." }] }), { mode: 0o600 });
    expect(await new BrowserTaskStore({ file }).get(card.id)).toMatchObject({ status: "finished" });
    writeFileSync(file, JSON.stringify({ ...saved, tasks: [{ ...saved.tasks[0], recipe: { ...saved.tasks[0].recipe, portal: "../x" } }] }), { mode: 0o600 });
    await expect(new BrowserTaskStore({ file }).get(card.id)).rejects.toThrow(/need recovery/);
    await expect(store.propose({ ...proposal, recipe: { ...proposal.recipe, runs: [] } }, NOW)).rejects.toMatchObject({ status: 400 });
  });
});

describe("upload-and-preview recipe tasks", () => {
  const BYTES = Buffer.from('25/09/2026,"540.00",FICTIONAL PAYMENT,,,,,FT-BRAVO\n');
  const SHA = createHash("sha256").update(BYTES).digest("hex");
  const PREVIEW_INPUTS = { bank_format: "ANZ(csv file)", approved_file: "fictional-bank.csv", expected_rows: "1", expected_total: "540.00" };
  const UPLOAD = { name: "fictional-bank.csv", sha256: SHA };
  it("needs the reviewed file's exact name and sha256, and still refuses every other prepare recipe", async () => {
    const card = await portalRecipeTaskProposal({ threadId: "t", messageId: "m", portal: "rei-cloud", target: "bulk-receipting-preview", inputs: PREVIEW_INPUTS, account: ACCOUNT, upload: UPLOAD }, fictional);
    expect(card.actions).toEqual(expect.arrayContaining(["upload", "fill"]));
    expect(card.actions).not.toContain("submit");
    expect(card.recipe.runs.map(run => run.recipe)).toEqual(["open-session", "bulk-receipting-preview"]);
    expect(card.recipe.runs[1].inputs).toEqual({ ...PREVIEW_INPUTS, approved_sha256: SHA });
    expect(card.request).toContain(`fictional-bank.csv (sha256 ${SHA})`);
    expect(card.request).toMatch(/stops before Process Receipts, Receipt All, Save, Post, Finalise; posting stays with you/);
    const base = { threadId: "t", messageId: "m", portal: "rei-cloud", target: "bulk-receipting-preview", inputs: PREVIEW_INPUTS, account: ACCOUNT };
    await expect(portalRecipeTaskProposal(base, fictional)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/exact name and sha256/) });
    await expect(portalRecipeTaskProposal({ ...base, upload: { ...UPLOAD, sha256: "abc" } }, fictional)).rejects.toMatchObject({ status: 400 });
    await expect(portalRecipeTaskProposal({ ...base, upload: { ...UPLOAD, name: "other.csv" } }, fictional)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/reviewed file/) });
    await expect(portalRecipeTaskProposal({ ...base, target: "receipt-register", inputs: MORNING_INPUTS, upload: UPLOAD }, fictional)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Only read recipes/) });
    // A caller cannot smuggle a hash into a read recipe.
    const read = await portalRecipeTaskProposal({ ...base, target: "arrears-review", inputs: { min_days: "1", approved_sha256: SHA } }, fictional);
    expect(read.recipe.runs[1].inputs).toEqual({ min_days: "1" });
  });

  it("runs only when the Start grant lists that exact file, and the upload is still asked of the person", async () => {
    const f = await fixture();
    const card = await f.store.propose(await portalRecipeTaskProposal({ threadId: "thread-ask", messageId: "m1", portal: "rei-cloud", target: "bulk-receipting-preview", inputs: PREVIEW_INPUTS, account: ACCOUNT, upload: UPLOAD }, fictional), NOW);
    const started = await f.store.start(card.id, { threadId: "thread-ask", browserId: "work" }, NOW);
    const base = { record: started, runtime: f.runtime, signal: new AbortController().signal, isActive: () => true, load: fictional, ...f.stores };
    // No attachment in the thread: the grant lists no file.
    await expect(runPortalRecipeTask({ ...base, grant: started.grant, approve: async () => true })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not the reviewed file/) });
    await expect(runPortalRecipeTask({ ...base, grant: { ...started.grant, uploads: [{ ...UPLOAD, sha256: "0".repeat(64) }] }, approve: async () => true })).rejects.toMatchObject({ status: 409 });
    expect(f.mock.calls.some(args => args[0] === "session")).toBe(false);
    const upload = await addBrowserTaskUpload(f.stores.workroom, UPLOAD.name, BYTES);
    const asked: string[] = [];
    const result = await runPortalRecipeTask({ ...base, grant: { ...started.grant, uploads: [upload] }, approve: async tool => { asked.push(tool); return true; } });
    expect(result.outcome, result.detail).toBe("completed");
    expect(asked).toContain("browser_upload");
    expect(f.mock.effects).toEqual(["upload"]);
    expect(portalRecipeTaskReply(result)).toContain("RealBud cannot confirm what changed in the portal");
  });
});

describe("running a started recipe task", () => {
  it("runs the morning batch with the task's own grant, the bank grid multi-page, and asks nobody", async () => {
    const f = await fixture({ pageSize: 1 });
    const card = await f.store.propose(await portalRecipeTaskProposal({ threadId: "thread-ask", messageId: "m1", portal: "rei-cloud", target: "morning", inputs: MORNING_INPUTS, account: ACCOUNT }, fictional), NOW);
    const started = await f.store.start(card.id, { threadId: "thread-ask", browserId: "work" }, NOW);
    const approve = vi.fn(async () => false);
    let during = false;
    const result = await runPortalRecipeTask({ record: started, grant: started.grant, runtime: f.runtime, approve, signal: new AbortController().signal,
      isActive: () => { during ||= portalRecipeTaskRunning(started.grant.id); return true; }, load: fictional, ...f.stores });
    expect(result.outcome, result.detail).toBe("completed");
    expect(during).toBe(true);
    expect(portalRecipeTaskRunning(started.grant.id)).toBe(false);
    const bank = result.results.find(item => item.recipe === "bank-reconciliation-read")!;
    expect(bank).toMatchObject({ outcome: "completed", pages: 2, stopBefore: ["Reconcile"] });
    expect(approve).not.toHaveBeenCalled();
    expect(f.mock.effects).toEqual([]);
    // The Ask task's step budget covers this batch at one row per page.
    expect(result.receipt.steps.every(step => step.ok)).toBe(true);
    const reply = portalRecipeTaskReply(result);
    expect(reply).toContain("Nothing was saved, sent or paid");
    expect(reply).toContain("**bank-reconciliation-read**: 2 rows over 2 pages; stopped before Reconcile.");
    // Anything else (ended early, or the person approved a step) never claims nothing changed.
    for (const other of [{ ...result, outcome: "handover" as const, reason: "sign-in" }, { ...result, receipt: { ...result.receipt, approvals: { recipe: 1, person: 1 } } }]) {
      const text = portalRecipeTaskReply(other);
      expect(text).not.toContain("Nothing was saved");
      expect(text).toContain("RealBud cannot confirm what changed in the portal");
    }
  });

  it("keeps a host's hold on the grant from Start until the task ends, across the run", async () => {
    const f = await fixture();
    const card = await f.store.propose(await portalRecipeTaskProposal({ threadId: "thread-ask", messageId: "m1", portal: "rei-cloud", target: "morning", inputs: MORNING_INPUTS, account: ACCOUNT }, fictional), NOW);
    const started = await f.store.start(card.id, { threadId: "thread-ask", browserId: "work" }, NOW);
    holdPortalRecipeGrant(started.grant.id);
    expect(portalRecipeTaskRunning(started.grant.id)).toBe(true);
    const run = runPortalRecipeTask({ record: started, grant: started.grant, runtime: f.runtime, approve: async () => false, signal: new AbortController().signal, isActive: () => true, load: fictional, ...f.stores });
    // A second run of the same task is refused while the first runs.
    await expect(runPortalRecipeTask({ record: started, grant: started.grant, runtime: f.runtime, approve: async () => false, signal: new AbortController().signal, isActive: () => true, load: fictional, ...f.stores })).rejects.toMatchObject({ status: 409 });
    expect((await run).outcome).toBe("completed");
    // The run ending does not release the host's hold; only the task ending does.
    expect(portalRecipeTaskRunning(started.grant.id)).toBe(true);
    releasePortalRecipeGrant(started.grant.id);
    expect(portalRecipeTaskRunning(started.grant.id)).toBe(false);
  });

  it("refuses a record without a recipe, or a grant that is not the record's own", async () => {
    const f = await fixture();
    const card = await f.store.propose(await portalRecipeTaskProposal({ threadId: "thread-ask", messageId: "m1", portal: "rei-cloud", target: "morning", inputs: MORNING_INPUTS, account: ACCOUNT }, fictional), NOW);
    const started = await f.store.start(card.id, { threadId: "thread-ask", browserId: "work" }, NOW);
    const base = { runtime: f.runtime, approve: async () => false, signal: new AbortController().signal, isActive: () => true, load: fictional, ...f.stores };
    await expect(runPortalRecipeTask({ ...base, record: { ...started, recipe: undefined }, grant: started.grant })).rejects.toMatchObject({ status: 409 });
    await expect(runPortalRecipeTask({ ...base, record: started, grant: { ...started.grant, id: "0f0f0f0f-0000-4000-8000-000000000000" } })).rejects.toMatchObject({ status: 409 });
    await expect(runPortalRecipeTask({ ...base, record: { ...started, status: "stopped" }, grant: started.grant })).rejects.toMatchObject({ status: 409 });
    expect(f.mock.calls.some(args => args[0] === "session")).toBe(false);
  });

  it("says in the reply when the learned recipes file is damaged, and still runs the shipped recipes", async () => {
    const file = join(DATA_DIR, "learned-recipes.json");
    expect(file.startsWith(process.env.HOME!)).toBe(true); // the test home, never ~/.realbud
    plantPrivateFile(file, "{not json"); cleanup.push(() => rmSync(file, { force: true }));
    // The real loader (learned merge included) over the fictional pack, so the run can reach the mock.
    const load = (portal: string) => loadPortalRecipePack(portal, { apply: async () => fictionalReiPack() } as unknown as PortalPathStore);
    const f = await fixture();
    const card = await f.store.propose(await portalRecipeTaskProposal({ threadId: "thread-ask", messageId: "m1", portal: "rei-cloud", target: "bank-reconciliation-read", account: ACCOUNT }, fictional), NOW);
    const started = await f.store.start(card.id, { threadId: "thread-ask", browserId: "work" }, NOW);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}); cleanup.push(() => warn.mockRestore());
    const result = await runPortalRecipeTask({ record: started, grant: started.grant, runtime: f.runtime, approve: async () => false, signal: new AbortController().signal, isActive: () => true, load, ...f.stores });
    expect(result.outcome, result.detail).toBe("completed");
    expect(portalRecipeTaskReply(result)).toContain(`${LEARNED_RECIPES_DAMAGED} Only the shipped portal recipes were available.`);
    // An intact (or missing) file adds nothing to the reply.
    rmSync(file);
    const again = await f.store.start((await f.store.propose(await portalRecipeTaskProposal({ threadId: "thread-ask-2", messageId: "m2", portal: "rei-cloud", target: "bank-reconciliation-read", account: ACCOUNT }, fictional), NOW)).id, { threadId: "thread-ask-2", browserId: "work" }, NOW);
    const clean = await runPortalRecipeTask({ record: again, grant: again.grant, runtime: f.runtime, approve: async () => false, signal: new AbortController().signal, isActive: () => true, load, ...f.stores });
    expect(clean.outcome, clean.detail).toBe("completed");
    expect(portalRecipeTaskReply(clean)).not.toContain("need recovery");
  });

  it("ends at once when the task is stopped mid-run", async () => {
    const f = await fixture();
    const card = await f.store.propose(await portalRecipeTaskProposal({ threadId: "thread-ask", messageId: "m1", portal: "rei-cloud", target: "morning", inputs: MORNING_INPUTS, account: ACCOUNT }, fictional), NOW);
    const started = await f.store.start(card.id, { threadId: "thread-ask", browserId: "work" }, NOW);
    const stop = new AbortController(); let active = true;
    const inner = f.mock.command; let navs = 0;
    const runtime = new BrowserRuntime({ root: privateTempRoot(join(tmpdir(), "rb-recipe-task-stop-")), command: async args => { const out = await inner(args); if (args[0] === "navigate" && ++navs === 2) { active = false; stop.abort(); } return out; },
      executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
    cleanup.push(() => removeFixture(runtime.root));
    await runtime.connect(); await runtime.select("work");
    const result = await runPortalRecipeTask({ record: started, grant: started.grant, runtime, approve: async () => false, signal: stop.signal, isActive: () => active, load: fictional, ...f.stores });
    expect(result.outcome).toBe("stopped");
    expect((await runtime.status()).active).toBe(false);
  });
});

describe("learned confirmations are read-safe only in a task that runs their recipe", () => {
  const learned = (name: string, label: string): LearnedRecipe => ({ version: 1, purpose: "realbud-learned-recipe", id: `lr_${"1".repeat(24)}`, portal: "rei-cloud", name, title: name,
    state: "published", steps: [{ click: label }, { read: "controls" }], inputs: [], stopBefore: [], confirmedLabels: [label], flags: [], createdAt: 1, updatedAt: 1, revision: 1 });
  const merged = () => {
    const pack = mergeLearnedRecipes(fictionalReiPack(), [learned("learned-a", "Show fictional detail"), learned("learned-b", "Open fictional notes")]);
    // A shipped-style recipe that runs a learned one: its confirmations come along.
    pack.recipes.wrapper = { kind: "read", tier: [], inputs: [], grantNeeds: [], steps: [{ run: "learned-b" }], stopBefore: [] };
    return pack;
  };

  it("adds nothing to a task that runs only shipped recipes", () => {
    const pack = merged();
    const shipped = fictionalReiPack().labels.readSafe;
    expect(pack.labels.readSafe).toEqual(shipped);
    expect(learnedReadSafe(pack, [{ recipe: "open-session" }])).toEqual([]);
    expect(portalTaskPack(pack, [{ recipe: "open-session" }])).toBe(pack);
    expect(portalTaskPack(pack, [{ recipe: "open-session" }]).labels.readSafe).not.toContain("Show fictional detail");
  });

  it("adds a learned recipe's own confirmations, and another's only when that one runs too", () => {
    const pack = merged();
    const shipped = fictionalReiPack().labels.readSafe;
    const a = portalTaskPack(pack, [{ recipe: "open-session" }, { recipe: "learned-a" }]);
    expect(a.labels.readSafe).toEqual([...shipped, "Show fictional detail"]);
    expect(a.labels.readSafe).not.toContain("Open fictional notes");
    expect(portalTaskPack(pack, [{ recipe: "learned-b" }]).labels.readSafe).toEqual([...shipped, "Open fictional notes"]);
    expect(learnedReadSafe(pack, [{ recipe: "learned-a" }, { recipe: "learned-b" }])).toEqual(["Show fictional detail", "Open fictional notes"]);
    expect(learnedReadSafe(pack, [{ recipe: "wrapper" }])).toEqual(["Open fictional notes"]);
    // The loaded pack itself is never changed.
    expect(pack.labels.readSafe).toEqual(shipped);
  });
});

describe("the recipe task's approval channel", () => {
  it("shows the broker's ask, takes only the person's answer, and says no on Stop or when nobody answers", async () => {
    const opened: PortalRecipeAsk[] = []; const settled: Array<[string, boolean, boolean]> = [];
    const approve = portalRecipeApprovalChannel("thread-ask", ask => opened.push(ask), (id, allowed, byPerson) => settled.push([id, allowed, byPerson]));
    const projection = { fence: { surface: "portal-read" as const, origin: "rei-mock.fictional.test", ruleOffer: null }, approvalPolicy: "once" as const };
    const first = approve("browser_click_semantic", { label: 'button "Finalise"' }, "Use Finalise.", new AbortController().signal, projection);
    expect(opened[0]).toMatchObject({ tool: "browser_click_semantic", summary: "Use Finalise.", projection });
    expect(answerPortalRecipeAsk("thread-other", opened[0].requestId, true)).toBe(false);
    expect(answerPortalRecipeAsk("thread-ask", opened[0].requestId, true)).toBe(true);
    expect(await first).toBe(true);
    expect(answerPortalRecipeAsk("thread-ask", opened[0].requestId, true)).toBe(false);
    const stop = new AbortController();
    const second = approve("browser_click_semantic", {}, "x", stop.signal, projection);
    stop.abort();
    expect(await second).toBe(false);
    expect(answerPortalRecipeAsk("thread-ask", opened[1].requestId, true)).toBe(false);
    expect(settled).toEqual([[opened[0].requestId, true, true], [opened[1].requestId, false, false]]);
    // A card that cannot be shown is a refusal.
    const failing = portalRecipeApprovalChannel("thread-ask", () => { throw new Error("no card"); }, () => {});
    expect(await failing("browser_click_semantic", {}, "x", new AbortController().signal, projection)).toBe(false);
  });
});
