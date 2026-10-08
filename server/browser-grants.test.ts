// Ask one-off browser tasks: the card is saved before it shows, Start saves an
// explicit grant bound to the thread and browser, the broker offers that
// grant's tools, and Stop, time, the step limit or a restart end it for good.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  ASK_TASK_BUDGET,
  ASK_TASK_MINUTES,
  ASK_TASK_OFFER_MS,
  askBrowserTaskSystemBlock,
  BROWSER_TASK_OFFER,
  BROWSER_TASK_PAUSED_NOTE,
  BROWSER_TASK_RESTART_NOTE,
  browserTaskCapabilities,
  browserTaskCardView,
  browserTaskProgress,
  browserTaskLimitReached,
  BrowserTaskStore,
  desktopWindowChoice,
  desktopWindowChoices,
  threadAttachedFiles,
  type BrowserTaskProposal,
  validBrowserTaskRecipe,
} from "./browser-grants.ts";
import { grantedBrowserTools } from "./attended-run.ts";
import { authorizeBrowserAction, BrowserApprovalStore } from "./browser-authority.ts";
import { startBrowserBroker } from "./browser-broker.ts";
import { BrowserRuntime, browserTaskWorkroom } from "./browser-runtime.ts";
import { saveAskAttachment } from "./ask-attach.ts";
import { browserTaskIntent } from "./portal-job-intent.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { parseBrowserTaskGrant, type BrowserTaskGrant } from "../shared/browser-task.ts";

const SITE = "portal.fictional-strata.example";
const NOW = 1_800_000_000_000;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  const root = privateTempRoot(join(tmpdir(), "rb-browser-grants-")); cleanup.push(() => removeFixture(root));
  const file = join(root, "browser-tasks.json");
  return { root, file, store: new BrowserTaskStore({ file }) };
}
const proposal = (text: string, extra: Partial<BrowserTaskProposal> = {}): BrowserTaskProposal => {
  const intent = browserTaskIntent(text, () => []);
  if (!intent) throw new Error(`not a task: ${text}`);
  return { threadId: "thread-ask", messageId: "message-1", ...intent, ...extra };
};

describe("Ask browser task cards", () => {
  it("saves the card privately before anything is allowed, with the steps, fixed policy, time and step limit", async () => {
    const { store, file } = fixture();
    const record = await store.propose(proposal("Download this month's invoices from portal.fictional-strata.example"), NOW);
    expect(record).toMatchObject({ status: "proposed", grant: null, sites: [SITE], siteSource: "request", actions: ["read", "navigate", "click", "download"], minutes: ASK_TASK_MINUTES, budget: ASK_TASK_BUDGET });
    // Windows reports no Unix mode; its protection is the ACL the private writer applies.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ version: 1, purpose: "browser-tasks", tasks: [{ version: 1, purpose: "browser-task", id: record.id }] });
    expect(browserTaskCardView(record)).toEqual({
      id: record.id, messageId: "message-1", status: "proposed", request: "Download this month's invoices from portal.fictional-strata.example",
      sites: [SITE], siteSource: "request", savedJob: null, actions: ["read", "navigate", "click", "download"],
      consequential: ["pay", "sign", "send", "notice", "delete", "account-change"], minutes: 30, budget: 40,
      offerExpiresAt: NOW + ASK_TASK_OFFER_MS, startedAt: null, expiresAt: null, endNote: null, progress: [],
    });
    expect(await store.list("thread-ask")).toHaveLength(1);
    expect(await store.list("thread-other")).toEqual([]);
    expect(BROWSER_TASK_OFFER).toContain("**Start this task**");
  });

  it("shows what the task did as short progress lines, never an action record's hashes or a field value", () => {
    const at = NOW;
    expect(browserTaskProgress([
      { at, kind: "action", note: "Signed in to REI Cloud." },
      { at, kind: "action", note: "allowed for this browser task" },
      { at, kind: "action", note: "Allowed once by you." },
      { at, kind: "asked", note: "Asked you to confirm the account FICT1 on rei-mock.fictional.test." },
      { at, kind: "action", note: "You confirmed the account FICT1 on rei-mock.fictional.test." },
      { at, kind: "action", note: "Opened Reports on rei-mock.fictional.test." },
      { at, kind: "action", note: "Opened Reports on rei-mock.fictional.test." },
      { at, kind: "action", note: 'Chose an option in combobox "Output" on rei-mock.fictional.test. Action record: tool=browser_select values-sha256=' + "a".repeat(64) },
      { at, kind: "action", note: "Downloaded 'fictional-tenant-list.csv' (812 bytes, text/csv, sha256 0123456789ab) from rei-mock.fictional.test into this task's private folder. Action record: tool=browser_download" },
      { at, kind: "action", note: "Saved the tenant-list path Bud found on rei-mock.fictional.test (version 1) with your approval." },
    ])).toEqual(["Signed in to REI Cloud", "You confirmed the account FICT1", "Opened Reports", "Chose an option in Output", "Downloaded fictional-tenant-list.csv", "Saved the tenant-list path Bud found"]);
    expect(browserTaskProgress([{ at, kind: "action", note: "You finished the sign-in page on portal.fictional-strata.example. Bud read the page again and continues the same task." }])).toEqual(["Signed in"]);
  });

  it("starts with an explicit grant bound to this thread and the selected browser", async () => {
    const { store, file } = fixture();
    const { id } = await store.propose(proposal("Can you submit this maintenance request on portal.fictional-strata.example?"), NOW);
    const started = await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW + 1000);
    expect(started.grant).toEqual(parseBrowserTaskGrant({
      version: 1, purpose: "browser-task-grant", id, runId: `ask-${id}`, route: "ask",
      request: { text: "Submit this maintenance request on portal.fictional-strata.example", sha256: started.grant.request.sha256 },
      sites: [SITE], browser: { id: "fictional-browser", accountMarker: null }, actions: ["read", "navigate", "fill", "click", "submit"],
      consequential: "ask-each", uploads: [], expiresAt: NOW + 1000 + 30 * 60_000, budget: 40,
    }));
    expect(started.grant.request.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(file, "utf8")).tasks[0]).toMatchObject({ status: "active", startedAt: NOW + 1000, grant: { id } });
    expect(browserTaskCapabilities(started.grant.actions)).toEqual(["portal-read", "portal-prefill", "portal-submit"]);
    // Pressing Start twice never starts a second copy.
    await expect(store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW + 2000)).rejects.toMatchObject({ status: 409 });
  });

  it("never lets another thread start or answer the card, and allows one running task per thread", async () => {
    const { store } = fixture();
    const first = await store.propose(proposal("Download the levy notice from portal.fictional-strata.example"), NOW);
    const second = await store.propose(proposal("Download the invoices from portal.fictional-strata.example", { messageId: "message-2" }), NOW);
    await expect(store.start(first.id, { threadId: "thread-other", browserId: "fictional-browser" }, NOW)).rejects.toMatchObject({ status: 404 });
    await expect(store.answer(first.id, "thread-other", "declined", NOW)).rejects.toMatchObject({ status: 404 });
    await store.start(first.id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    await expect(store.start(second.id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW)).rejects.toThrow("Another browser task is running in this conversation");
  });

  it("does not start without a connected browser, a site, or a current card", async () => {
    const { store } = fixture();
    const noSite = await store.propose(proposal("Download this month's invoices from the strata portal"), NOW);
    expect(noSite.siteSource).toBe("none");
    await expect(store.start(noSite.id, { threadId: "thread-ask", browserId: "" }, NOW)).rejects.toThrow("Connect your browser before starting this task.");
    await expect(store.start(noSite.id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW)).rejects.toMatchObject({ status: 400 });
    await expect(store.start(noSite.id, { threadId: "thread-ask", browserId: "fictional-browser", site: "http://10.0.0.1/admin" }, NOW)).rejects.toMatchObject({ status: 400 });
    const started = await store.start(noSite.id, { threadId: "thread-ask", browserId: "fictional-browser", site: "https://Portal.Fictional-Strata.example/levies?x=1" }, NOW);
    expect(started.grant.sites).toEqual([SITE]);
    expect(started.siteSource).toBe("person");
    const stale = await store.propose(proposal("Download the invoices from portal.fictional-strata.example", { threadId: "thread-late" }), NOW);
    await expect(store.start(stale.id, { threadId: "thread-late", browserId: "fictional-browser" }, NOW + ASK_TASK_OFFER_MS + 1)).rejects.toThrow("more than an hour ago");
  });

  it("keeps Not now and Save as a job instead final", async () => {
    const { store } = fixture();
    const declined = await store.propose(proposal("Download the invoices from portal.fictional-strata.example"), NOW);
    expect((await store.answer(declined.id, "thread-ask", "declined", NOW)).status).toBe("declined");
    await expect(store.start(declined.id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW)).rejects.toMatchObject({ status: 409 });
    const saved = await store.propose(proposal("Download the invoices from portal.fictional-strata.example"), NOW);
    expect((await store.answer(saved.id, "thread-ask", "saved-as-job", NOW)).status).toBe("saved-as-job");
    await expect(store.answer(saved.id, "thread-ask", "declined", NOW)).rejects.toMatchObject({ status: 409 });
  });

  it("ends a task for good on Stop, with its evidence kept and never restarted", async () => {
    const { store } = fixture();
    const { id } = await store.propose(proposal("Download the invoices from portal.fictional-strata.example"), NOW);
    await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    await store.appendEvidence(id, [{ at: NOW + 5, kind: "action", note: "Downloaded 'Fictional invoice.pdf' from portal.fictional-strata.example." }]);
    const stopped = await store.end(id, "stopped", undefined, NOW + 10);
    expect(stopped).toMatchObject({ status: "stopped", endedAt: NOW + 10, endNote: "Stopped by you. Nothing more will be done in your browser for this task." });
    expect(stopped?.evidence).toEqual([{ at: NOW + 5, kind: "action", note: "Downloaded 'Fictional invoice.pdf' from portal.fictional-strata.example." }]);
    expect(await store.end(id, "finished", undefined, NOW + 20)).toBeNull();
    await store.appendEvidence(id, [{ at: NOW + 30, kind: "note", note: "late" }]);
    expect((await store.get(id))?.evidence).toHaveLength(1);
    await expect(store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW + 40)).rejects.toMatchObject({ status: 409 });
  });

  it("names the time and step limit when they end the task", async () => {
    const { store } = fixture();
    const { id } = await store.propose(proposal("Download the invoices from portal.fictional-strata.example"), NOW);
    await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    expect((await store.end(id, "budget", undefined, NOW + 1))?.endNote).toBe("This task used its 40 browser steps, so Bud stopped using your browser. Ask again to continue.");
    const other = await store.propose(proposal("Download the levy notice from portal.fictional-strata.example"), NOW);
    await store.start(other.id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    expect((await store.end(other.id, "expired", undefined, NOW + 1))?.endNote).toBe("This task's 30 minutes ran out, so Bud stopped using your browser. Ask again to continue.");
  });

  it("recognises the authority's own time-up and step-limit refusals", async () => {
    const { store } = fixture();
    const { id } = await store.propose(proposal("Download the invoices from portal.fictional-strata.example"), NOW);
    const { grant } = await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    const page = { url: `https://${SITE}/invoices`, text: '@e1 link "September invoice"' };
    const budget = authorizeBrowserAction(grant, page, "browser_read", { tab_id: 1 }, { now: NOW + 1, used: grant.budget! });
    const expired = authorizeBrowserAction(grant, page, "browser_read", { tab_id: 1 }, { now: grant.expiresAt!, used: 0 });
    expect(budget.decision === "deny" && browserTaskLimitReached(`Tried to read the page. ${budget.reason}`)).toBe("budget");
    expect(expired.decision === "deny" && browserTaskLimitReached(`Tried to read the page. ${expired.reason}`)).toBe("expired");
    expect(browserTaskLimitReached("Tried to read the page. That tab is outside this job.")).toBeNull();
  });

  it("ends a running task as interrupted after a restart, so a saved grant never resumes", async () => {
    const { store, file } = fixture();
    const { id } = await store.propose(proposal("Download the invoices from portal.fictional-strata.example"), NOW);
    await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    const restarted = new BrowserTaskStore({ file });
    expect(await restarted.get(id)).toMatchObject({ status: "interrupted", endNote: BROWSER_TASK_RESTART_NOTE });
    expect(JSON.parse(readFileSync(file, "utf8")).tasks[0].status).toBe("interrupted");
    await expect(restarted.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW)).rejects.toMatchObject({ status: 409 });
  });

  it("pauses for sign-in with the same grant, keeps the pause over a restart, and continues only that grant", async () => {
    const { store, file } = fixture();
    const { id } = await store.propose(proposal("Download the invoices from portal.fictional-strata.example"), NOW);
    const { grant } = await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    const paused = await store.pause(id);
    expect(paused).toMatchObject({ status: "paused", endNote: BROWSER_TASK_PAUSED_NOTE, grant, endedAt: null });
    expect(browserTaskCardView(paused!)).toMatchObject({ status: "paused", expiresAt: grant.expiresAt });
    // A second pause only changes what the card says (the page wait handed over to the sign-in request).
    expect(await store.pause(id, "Fictional page wait.")).toMatchObject({ status: "paused", endNote: "Fictional page wait.", grant });
    expect(await store.pause(id)).toMatchObject({ status: "paused", endNote: BROWSER_TASK_PAUSED_NOTE });
    // Still this conversation's task: another cannot start, and what happens on the page is still recorded.
    const other = await store.propose(proposal("Download the levy notice from portal.fictional-strata.example"), NOW);
    await expect(store.start(other.id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW)).rejects.toThrow("Another browser task is running in this conversation. Stop it first.");
    await store.appendEvidence(id, [{ at: NOW + 5, kind: "asked", note: "Asked you to finish the sign-in page on portal.fictional-strata.example in your browser." }]);
    const restarted = new BrowserTaskStore({ file });
    expect(await restarted.get(id)).toMatchObject({ status: "paused", grant });
    expect(JSON.parse(readFileSync(file, "utf8")).tasks[0].status).toBe("paused");
    await expect(restarted.resume(id, { threadId: "thread-other" }, NOW + 60_000)).rejects.toMatchObject({ status: 404 });
    await expect(restarted.resume(id, { threadId: "thread-ask", browserId: "fictional-other-browser" }, NOW + 60_000))
      .rejects.toThrow("The selected browser changed while this task was paused. Start the task again from your request.");
    const resumed = await restarted.resume(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW + 60_000);
    expect(resumed).toMatchObject({ status: "active", endNote: null, startedAt: NOW });
    expect(resumed.grant).toEqual(grant);
    expect(resumed.evidence).toHaveLength(1);
    await expect(restarted.resume(id, { threadId: "thread-ask" }, NOW + 60_000)).rejects.toThrow("This task is no longer waiting for sign-in. Start the task again from your request.");
    // A pause can also be stopped for good, and an ended task never pauses again.
    await restarted.pause(id);
    expect(await restarted.end(id, "stopped", undefined, NOW + 70_000)).toMatchObject({ status: "stopped" });
    expect(await restarted.pause(id)).toBeNull();
    await expect(restarted.resume(id, { threadId: "thread-ask" }, NOW + 80_000)).rejects.toMatchObject({ status: 409 });
  });

  it("never continues a paused task after its time ran out, and a restart marks it expired", async () => {
    const { store, file } = fixture();
    const { id } = await store.propose(proposal("Download the invoices from portal.fictional-strata.example"), NOW);
    const { grant } = await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    await store.pause(id);
    await expect(store.resume(id, { threadId: "thread-ask", browserId: "fictional-browser" }, grant.expiresAt!))
      .rejects.toThrow("This task's permission has ended. Start the task again from your request.");
    expect((await store.get(id))?.status).toBe("paused");
    // One started 40 minutes ago (by the real clock) has lapsed while paused: a restart ends it.
    const started = Date.now() - 40 * 60_000;
    const lapsed = await store.propose(proposal("Download the levy notice from portal.fictional-strata.example", { threadId: "thread-lapsed" }), started);
    await store.start(lapsed.id, { threadId: "thread-lapsed", browserId: "fictional-browser" }, started);
    await store.pause(lapsed.id);
    const restarted = new BrowserTaskStore({ file });
    expect(await restarted.get(lapsed.id)).toMatchObject({ status: "expired", endNote: "This task's time ran out while it waited for you to sign in. Nothing more will be done in your browser; start the task again from your request." });
    expect((await restarted.get(id))?.status).toBe("paused");
  });

  it("holds a damaged record file instead of clearing it", async () => {
    const { store, file } = fixture();
    await store.propose(proposal("Download the invoices from portal.fictional-strata.example"), NOW);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.tasks[0].status = "running-anyway";
    writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
    const reopened = new BrowserTaskStore({ file });
    await expect(reopened.list("thread-ask")).rejects.toMatchObject({ status: 503 });
    expect(JSON.parse(readFileSync(file, "utf8")).tasks[0].status).toBe("running-anyway");
  });
});

describe("the started task's browser", () => {
  async function offered(root: string, grant: BrowserTaskGrant) {
    const runtime = new BrowserRuntime({ root, command: async () => ({}), executable: async () => "/fixture/bsk", startDaemon: async () => {} });
    const broker = await startBrowserBroker({ runtime, threadId: "thread-ask", runId: grant.runId, grant,
      context: { allowedOrigins: [...grant.sites], capabilities: browserTaskCapabilities(grant.actions) },
      approvals: new BrowserApprovalStore({ file: join(root, "approvals.json") }), isActive: () => true, approve: async () => false, assertCapability: () => {} });
    try {
      const response = await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: broker.descriptor.headers[0].value },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      return ((await response.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(tool => tool.name);
    } finally { broker.close(); await broker.released(); }
  }

  it("mounts exactly the grant's tools for a submission, and the worker is told the same list", async () => {
    const { store, root } = fixture();
    const { id } = await store.propose(proposal("Can you submit this maintenance request on portal.fictional-strata.example?"), NOW);
    const { grant } = await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    const tools = await offered(root, grant);
    expect(tools).toEqual(grantedBrowserTools(grant, true));
    expect(tools).toEqual(["browser_tabs", "browser_borrow", "browser_read", "browser_navigate", "browser_fill", "browser_click_semantic", "browser_select", "browser_release"]);
    const block = askBrowserTaskSystemBlock(grant);
    expect(block).toContain(`Use only RealBud's browser tools for this saved job: ${tools.slice(0, -1).join(", ")} and browser_release.`);
    expect(block).toContain("Request:\nSubmit this maintenance request on portal.fictional-strata.example");
    expect(block).toContain(`Allowed sites: ${SITE}`);
    expect(block).toContain("ends 30 minutes after it started or after 40 browser steps");
  });

  it("offers a download task no key, dropdown or upload tool, and refuses typing it was not given", async () => {
    const { store, root } = fixture();
    const { id } = await store.propose(proposal("Download this month's invoices from portal.fictional-strata.example"), NOW);
    const { grant } = await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW);
    const tools = await offered(root, grant);
    // Exactly the grant's classes: no typing tool for a download-only request.
    expect(tools).toEqual(grantedBrowserTools(grant, true));
    expect(tools).not.toContain("browser_fill");
    expect(tools.some(tool => ["browser_press", "browser_select", "browser_upload"].includes(tool))).toBe(false);
    expect(tools).toContain("browser_download");
    const fill = authorizeBrowserAction(grant, { url: `https://${SITE}/invoices`, text: '@e1 textbox "Search invoices"' }, "browser_fill", { tab_id: 1, ref: "@e1", value: "September" }, { now: NOW + 1 });
    expect(fill.decision).toBe("deny");
  });
});

describe("files the person attached in this thread", () => {
  const attach = (root: string, name: string, text: string) => saveAskAttachment(root, { name, contentBase64: Buffer.from(text).toString("base64") }).path;
  const tag = (path: string) => `<attached-file path="${path.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" />`;
  const UPLOAD = ["read", "navigate", "click", "upload"] as const;
  async function threads() {
    const { root, file } = fixture();
    const mine = attach(root, "fictional-lease.pdf", "%PDF-1.7 fictional lease");
    const other = attach(root, "fictional-other-lease.pdf", "%PDF-1.7 another thread's lease");
    const outside = join(root, "fictional-outside.pdf"); writeFileSync(outside, "%PDF-1.7 outside", { mode: 0o600 });
    // Saved exactly as the Store writes a thread (server/store.ts messages-<thread>.json).
    writeFileSync(join(root, "messages-thread-ask.json"), JSON.stringify({ activeLeafId: "m3", messages: [
      { id: "m1", role: "user", kind: "text", text: `Upload my lease to ${SITE}\n\n${tag(mine)}\n\n${tag(outside)}\n\n${tag(`${mine}.inspection.json`)}\n\n${tag(`${dirname(mine)}/../ask-uploads/${basename(mine)}`)}\n\n${tag(other)}` },
      // A model's text is never a person's attachment.
      { id: "m2", role: "bot", kind: "text", text: tag(other) },
      { id: "m3", role: "user", kind: "text", text: tag(mine) },
    ] }), { mode: 0o600 });
    writeFileSync(join(root, "messages-thread-other.json"), JSON.stringify({ activeLeafId: "o1", messages: [{ id: "o1", role: "user", kind: "text", text: tag(other) }] }), { mode: 0o600 });
    const store = new BrowserTaskStore({ file, dataDir: root });
    const { id } = await store.propose(proposal(`Upload my lease to ${SITE}`, { actions: [...UPLOAD] }), NOW);
    const started = await store.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW + 1000);
    return { root, mine, other, started };
  }

  it("grants exactly this thread's private attachment copies, copied into the task's own folder", async () => {
    const { root, mine, started } = await threads();
    const bytes = readFileSync(mine);
    expect(started.grant.uploads).toEqual([{ name: "fictional-lease.pdf", sha256: createHash("sha256").update(bytes).digest("hex") }]);
    const copy = join(browserTaskWorkroom(join(root, "browser"), started.grant.id), "uploads", "fictional-lease.pdf");
    expect(readFileSync(copy)).toEqual(bytes);
    if (process.platform !== "win32") expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(askBrowserTaskSystemBlock(started.grant)).toContain("browser_upload may send after their approval: fictional-lease.pdf. No other file can be uploaded.");
    // A task that may not upload copies nothing.
    const plain = new BrowserTaskStore({ file: join(root, "plain.json"), dataDir: root });
    const { id } = await plain.propose(proposal(`Download the invoices from ${SITE}`), NOW);
    expect((await plain.start(id, { threadId: "thread-ask", browserId: "fictional-browser" }, NOW + 1000)).grant.uploads).toEqual([]);
  });

  it("refuses another thread's file, an original path, a report or a traversal", async () => {
    const { root, other, started } = await threads();
    // The other thread's copy is its own; pasting its reference here does not make it this thread's.
    expect(await threadAttachedFiles(root, [{ role: "user", text: tag(other) }])).toEqual([{ name: "fictional-other-lease.pdf", path: realpathSync(other) }]);
    expect(await threadAttachedFiles(root, [{ role: "user", text: tag(other) }], [[{ role: "user", text: tag(other) }]])).toEqual([]);
    expect(started.grant.uploads.map(file => file.name)).toEqual(["fictional-lease.pdf"]);
    const form = { url: `https://${SITE}/requests`, text: '@e1 button "Choose file"' };
    expect(authorizeBrowserAction(started.grant, form, "browser_upload", { tab_id: 1, ref: "@e1", file: "fictional-other-lease.pdf" }, { now: NOW + 2000 }))
      .toMatchObject({ decision: "deny", reason: "Only files given to this task can be uploaded. Ask the person to add the file to the task." });
    const runtime = new BrowserRuntime({ root, command: async () => ({}), executable: async () => "/fixture/bsk", startDaemon: async () => {} });
    const broker = await startBrowserBroker({ runtime, threadId: "thread-ask", runId: started.grant.runId, grant: started.grant,
      context: { allowedOrigins: [...started.grant.sites], capabilities: browserTaskCapabilities(started.grant.actions) },
      approvals: new BrowserApprovalStore({ file: join(root, "approvals.json") }), isActive: () => true, approve: async () => false, assertCapability: () => {} });
    try {
      const response = await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: broker.descriptor.headers[0].value },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
      const tools = ((await response.json()) as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }> } }).result.tools;
      expect(tools.find(tool => tool.name === "browser_upload")!.inputSchema.properties.file.enum).toEqual(["fictional-lease.pdf"]);
    } finally { broker.close(); await broker.released(); }
  });

  it("names the file and the destination origin on the upload card", async () => {
    const { started } = await threads();
    const form = { url: `https://${SITE}/requests`, text: '@e1 button "Choose file"' };
    expect(authorizeBrowserAction(started.grant, form, "browser_upload", { tab_id: 1, ref: "@e1", file: "fictional-lease.pdf" }, { now: NOW + 2000 })).toMatchObject({
      decision: "ask", once: true, fence: { surface: "portal-prefill", origin: SITE },
      summary: `Upload the file 'fictional-lease.pdf' to https://${SITE} through Choose file. This sends the file to that site; this approval applies once.`,
    });
  });
});

describe("portal recipe task account", () => {
  const runs = [{ recipe: "open-session", inputs: {} }];
  it("accepts the header business code alone (no web address value), as a business-code-only W1 preview saves it", () => {
    expect(validBrowserTaskRecipe({ portal: "rei-cloud", runs, account: { marker: "FICT1" } })).toBe(true);
    expect(validBrowserTaskRecipe({ portal: "rei-cloud", runs, account: { urlValue: "fictional-reicid-1", marker: "FICT1" } })).toBe(true);
  });
  it("refuses an account without the header marker, an empty marker or a bad web address value", () => {
    expect(validBrowserTaskRecipe({ portal: "rei-cloud", runs, account: {} })).toBe(false);
    expect(validBrowserTaskRecipe({ portal: "rei-cloud", runs, account: { urlValue: "fictional-reicid-1" } })).toBe(false);
    expect(validBrowserTaskRecipe({ portal: "rei-cloud", runs, account: { marker: "" } })).toBe(false);
    expect(validBrowserTaskRecipe({ portal: "rei-cloud", runs, account: { marker: "FICT1", urlValue: "" } })).toBe(false);
    expect(validBrowserTaskRecipe({ portal: "rei-cloud", runs, account: { marker: "FICT1\n" } })).toBe(false);
    expect(validBrowserTaskRecipe({ portal: "rei-cloud", runs, account: { marker: "FICT1", other: "x" } })).toBe(false);
  });
});

describe("desktop tasks (one app window)", () => {
  const MAIL = { appName: "Mail", bundleId: "com.apple.mail", pid: 501, windowId: 77, title: "Inbox" };
  const row = (pid: number, window_id: number, app_name: string, title: string, bundle_id?: string) => ({ pid, window_id, app_name, title, ...(bundle_id ? { bundle_id } : {}) });

  it("offers only titled windows of other apps, never RealBud, browsers, terminals, editors, settings or password stores", () => {
    expect(desktopWindowChoices([
      row(501, 77, "Mail", "Inbox", "com.apple.mail"), row(502, 80, "Xero", "Bills"), row(501, 78, "Mail", "  "), row(501, 77, "Mail", "Inbox again"),
      row(4242, 1, "Fictional Helper", "Own window"), row(601, 2, "Google Chrome", "Portal"), row(602, 3, "msedge.exe", "Portal"), row(603, 4, "iTerm2", "zsh"),
      row(604, 5, "Cursor", "x.ts"), row(605, 6, "PyCharm CE", "x.py"), row(606, 7, "System Settings", "Privacy"), row(607, 8, "Bitwarden", "Vault"),
      row(608, 9, "RealBud", "Work"), row(609, 10, "Renamed", "Page", "com.google.Chrome"), row(610, 11, "Notes", "Bad\ntitle"), "junk", null,
    ], [4242])).toEqual([MAIL, { appName: "Xero", bundleId: "Xero", pid: 502, windowId: 80, title: "Bills" }]);
  });

  it("never offers RealBud's own helper overlay, its Helper windows, shell windows or zero-size windows", () => {
    const sized = (r: ReturnType<typeof row>, width: number, height: number) => ({ ...r, bounds: { x: 0, y: 0, width, height } });
    const NOTEPAD = sized(row(700, 20, "Notepad.exe", "Untitled - Notepad"), 800, 600);
    expect(desktopWindowChoices([
      sized(row(701, 21, "cua-driver.exe", "Cua.AgentCursorOverlay.default"), 1920, 1080), row(702, 22, "Overlay Host", "Cua.AgentCursorOverlay.default"),
      row(703, 23, "RealBud Helper (Renderer)", "RealBud"), row(704, 24, "RealBud.exe", "RealBud"),
      row(705, 25, "explorer.exe", "Program Manager"), row(706, 26, "TextInputHost.exe", "Windows Input Experience"), row(707, 27, "Dock", "Dock"),
      sized(row(708, 28, "Fictional App", "Hidden"), 0, 0), sized(row(709, 29, "Fictional App", "Stub"), 640, 0),
      NOTEPAD, sized(row(710, 30, "explorer.exe", "Documents"), 900, 700),
    ], [])).toEqual([
      { appName: "Notepad.exe", bundleId: "Notepad.exe", pid: 700, windowId: 20, title: "Untitled - Notepad" },
      { appName: "explorer.exe", bundleId: "explorer.exe", pid: 710, windowId: 30, title: "Documents" },
    ]);
  });

  it("keeps an app request an app task on the card, with or without a preselected window, and never with a site", async () => {
    const { store, file } = fixture();
    const card = await store.propose({ threadId: "thread-ask", messageId: "m-app", request: "Open Notepad on this computer", sites: [], siteSource: "none", savedJob: null, actions: ["read"], appTask: true }, NOW);
    expect(browserTaskCardView(card)).toMatchObject({ appTask: true, sites: [] });
    expect(browserTaskCardView(card)).not.toHaveProperty("desktop");
    expect(browserTaskCardView((await new BrowserTaskStore({ file }).get(card.id))!).appTask).toBe(true);
    expect(browserTaskCardView(await store.propose(proposal("Download this month's invoices from portal.fictional-strata.example"), NOW))).not.toHaveProperty("appTask");
    await expect(store.propose({ ...proposal("Download this month's invoices from portal.fictional-strata.example"), appTask: true }, NOW)).rejects.toMatchObject({ status: 400 });
  });

  it("takes a Start window as exactly {pid, windowId}", () => {
    expect(desktopWindowChoice({ pid: 501, windowId: 77 })).toEqual({ pid: 501, windowId: 77 });
    for (const bad of [null, {}, { pid: 501 }, { pid: 0, windowId: 77 }, { pid: 501, windowId: 77, title: "x" }, { pid: "501", windowId: 77 }]) {
      expect(() => desktopWindowChoice(bad)).toThrow("Choose the app window again.");
    }
  });

  it("starts with the window and no sites, never on a website card, and a restart interrupts it", async () => {
    const { store, file } = fixture();
    const card = await store.propose({ threadId: "thread-ask", messageId: "m-desk", request: "Open the inbox in the Mail app", sites: [], siteSource: "none", savedJob: null, actions: ["read", "click"], desktop: MAIL }, NOW);
    expect(browserTaskCardView(card).desktop).toEqual(MAIL);
    const started = await store.start(card.id, { threadId: "thread-ask", desktop: MAIL }, NOW + 1);
    expect(started.grant).toMatchObject({ sites: [], browser: { id: null, accountMarker: null }, uploads: [], desktop: MAIL });
    expect(askBrowserTaskSystemBlock(started.grant)).not.toContain("Inbox");
    const site = await store.propose(proposal("Download this month's invoices from portal.fictional-strata.example", { threadId: "thread-other" }), NOW);
    await expect(store.start(site.id, { threadId: "thread-other", desktop: MAIL }, NOW + 1)).rejects.toMatchObject({ status: 409 });
    await expect(store.propose({ ...proposal("Download this month's invoices from portal.fictional-strata.example"), desktop: MAIL }, NOW)).rejects.toMatchObject({ status: 400 });
    const restarted = new BrowserTaskStore({ file });
    expect(await restarted.get(card.id)).toMatchObject({ status: "interrupted", endNote: "RealBud restarted before this task finished. Nothing more will be done in Mail; ask again to continue." });
  });
});
