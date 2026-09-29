import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDatabase } from "./workflow-database.ts";
import { HumanHandoffs, validateLoginBinding } from "./human-handoffs.ts";
import { BrowserRuntime, type BrowserJson } from "./browser-runtime.ts";
import { browserTaskUsage, onBrowserDecision, onBrowserSignIn, restoreBrowserTaskUsage, startBrowserBroker } from "./browser-broker.ts";
import { BrowserApprovalStore } from "./browser-authority.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { parseBrowserTaskGrant } from "../shared/browser-task.ts";
import { createHash } from "node:crypto";
const binding = { version: 1 as const, pid: 123, windowId: 345, origin: "https://bank.example", accountMarker: "Fictional office 41", readyMarker: "Transaction history" };
const input = { runId: "run-1", threadId: "thread-1", botId: "bud", jobRevision: 1, reason: "mfa" as const };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bud-hold-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 9) }); cleanup.push(() => db.close());
  const host = { release: vi.fn(async () => {}), verify: vi.fn(async () => true), restore: vi.fn(async () => {}) };
  return { dir, db, host, service: new HumanHandoffs(db, host) };
}
describe("durable human sign-in handovers", () => {
  it("saves the pause before release; missing calibration cannot be approved by Continue", async () => {
    const { service, host } = setup();
    host.release.mockImplementation(async () => { expect(service.list()[0].value.state).toBe("releasing"); });
    const held = await service.open(input);
    expect(held.value.state).toBe("awaiting_login");
    expect(held.value.botId).toBe("bud");
    expect((await service.open(input)).id).toBe(held.id);
    expect(host.release).toHaveBeenCalledTimes(1);
    await expect(service.continue(held.id, held.revision)).rejects.toThrow(/save its visible labels/);
    expect(host.verify).not.toHaveBeenCalled();
  });
  it("rejects open without a Bud botId", async () => {
    const { service } = setup();
    await expect(service.open({ ...input, botId: "" })).rejects.toThrow(/Invalid sign-in checkpoint/);
  });
  it("checks once, releases again and never dispatches a previous action", async () => {
    const { service, host } = setup();
    const opened = await service.open(input), held = service.bind(opened.id, opened.revision, binding);
    const result = await service.continue(held.id, held.revision);
    expect(result.value.state).toBe("verified");
    expect(host.verify).toHaveBeenCalledTimes(1); expect(host.release).toHaveBeenCalledTimes(2);
    await expect(service.continue(held.id, held.revision)).rejects.toThrow(/changed/);
    expect((await service.close(result.id, result.revision)).value.state).toBe("closed");
    expect(host.restore).toHaveBeenCalledTimes(1);
  });
  it("waits after a wrong account, timeout or verification failure and does not loop", async () => {
    const { service, host } = setup(); host.verify.mockRejectedValue(new Error("private raw error"));
    const opened = await service.open(input), held = service.bind(opened.id, opened.revision, binding);
    const result = await service.continue(held.id, held.revision);
    expect(result.value.state).toBe("awaiting_login"); expect(JSON.stringify(result)).not.toContain("private raw error");
    expect(host.verify).toHaveBeenCalledTimes(1);
  });
  it("holds when release fails and permits a bounded retry", async () => {
    const { service, host } = setup(); host.release.mockRejectedValueOnce(new Error("cannot stop"));
    const held = await service.open(input); expect(held.value.state).toBe("recovery_required");
    expect((await service.retryRelease(held.id, held.revision)).value.state).toBe("awaiting_login");
  });
  it("allows only one concurrent Continue and Stop wins over late verification", async () => {
    const { service, host } = setup(); let resolve!: (value: boolean) => void;
    host.verify.mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    const opened = await service.open(input), held = service.bind(opened.id, opened.revision, binding);
    const pending = service.continue(held.id, held.revision);
    await expect(service.continue(held.id, held.revision)).rejects.toThrow(/changed/);
    const checking = service.get(held.id);
    expect((await service.stop(checking.id, checking.revision)).value.state).toBe("stopped");
    resolve(true); expect((await pending).value.state).toBe("stopped");
    expect(host.restore).not.toHaveBeenCalled();
  });
  it("recovers interrupted verification after restart without replay", async () => {
    const { service, db, host } = setup();
    const held = await service.open(input);
    db.update("handoff", held.id, held.revision, value => ({ ...(value as object), state: "checking" }));
    const restarted = new HumanHandoffs(db, host); restarted.recover();
    expect(restarted.get(held.id).value.state).toBe("recovery_required"); expect(host.verify).not.toHaveBeenCalled();
  });
  it("dispatches only the selected reviewed step once with a durable claim", async () => {
    const { db, host } = setup();
    const resume = vi.fn(async (_handoff: unknown, _step: number) => "new-attempt");
    const service = new HumanHandoffs(db, { ...host, resume });
    const opened = await service.open({ ...input, steps: ["Download", "Review references"] });
    const held = service.bind(opened.id, opened.revision, binding);
    const verified = await service.continue(held.id, held.revision);
    const done = await service.resumeStep(verified.id, verified.revision, 1);
    expect(done.value).toMatchObject({ state: "closed", resumeStep: 1, resumedRunId: "new-attempt" });
    expect(resume.mock.calls[0][1]).toBe(1);
    await expect(service.resumeStep(verified.id, verified.revision, 1)).rejects.toThrow(/changed/);
    expect(resume).toHaveBeenCalledTimes(1);
  });
  it("holds an uncertain dispatch and never replays it on recovery", async () => {
    const { db, host } = setup();
    const resume = vi.fn(async () => { throw new Error("uncertain response"); });
    const service = new HumanHandoffs(db, { ...host, resume });
    const opened = await service.open({ ...input, steps: ["Read payments"] });
    const held = service.bind(opened.id, opened.revision, binding);
    const verified = await service.continue(held.id, held.revision);
    expect((await service.resumeStep(verified.id, verified.revision, 0)).value.state).toBe("recovery_required");
    service.recover(); expect(resume).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid binding and expired checkpoints", async () => {
    const { service, db, host } = setup();
    expect(() => validateLoginBinding({ ...binding, origin: "https://bank.example/other" })).toThrow();
    expect(() => validateLoginBinding({ ...binding, pid: -1 })).toThrow();
    const opened = await service.open(input), held = service.bind(opened.id, opened.revision, binding);
    const later = new HumanHandoffs(db, host, () => held.value.expiresAt + 1);
    expect((await later.continue(held.id, held.revision)).value.state).toBe("recovery_required");
    expect(host.verify).not.toHaveBeenCalled();
  });
  it("binds and corrects an exact browser tab while rejecting numeric credentials and mixed bindings", async () => {
    const { service } = setup();
    const browser = { version: 1 as const, browser: { browserId: "work-profile", tabId: 4 }, origin: "https://bank.example", accountMarker: "  Office account  ", readyMarker: "Transaction history" };
    const opened = await service.open(input);
    const bound = service.bind(opened.id, opened.revision, browser);
    expect(bound.value.binding).toEqual({ ...browser, accountMarker: "Office account" });
    const corrected = service.bind(bound.id, bound.revision, { ...browser, browser: { ...browser.browser, tabId: 5 } });
    expect(corrected.value.binding?.browser?.tabId).toBe(5);
    expect(() => service.bind(bound.id, bound.revision, browser)).toThrow(/changed/);
    expect(() => validateLoginBinding({ ...browser, pid: 1, windowId: 2 })).toThrow();
    expect(() => validateLoginBinding({ ...browser, accountMarker: "123-456 789" })).toThrow(/account number/);
  });
  it("does not reset a missing key under existing saved work", async () => {
    const { dir, service } = setup(); await service.open(input);
    expect(() => new WorkflowDatabase({ dir })).toThrow(/recovery/);
    expect(readFileSync(join(dir, "workflow-state.sqlite")).includes(Buffer.from("thread-1"))).toBe(false);
    writeFileSync(join(dir, "desk.key"), "corrupt");
    expect(() => new WorkflowDatabase({ dir })).toThrow(/recovery/);
    expect(readFileSync(join(dir, "desk.key"), "utf8")).toBe("corrupt");
  });
});

// Slice 7: a sign-in pause keeps the task (its context, grant usage and
// completed steps) and Continue carries on with that same task.
const context = { runId: "run-1", botId: "bud", allowedOrigins: ["bank.example"], capabilities: ["portal-read" as const] };
function task(expiresAt: number | null = null) {
  return { version: 1 as const, context: { ...context }, grant: { grantId: "legacy-fictional", runId: "run-1", expiresAt, budget: 40, used: 3 },
    completed: ["Bud read the page on bank.example", "Downloaded 'Fictional statement.pdf' (12 bytes) from bank.example."] };
}
function taskSetup(now = () => Date.now()) {
  const base = setup();
  const continueTask = vi.fn(async (_handoff: unknown) => "run-1");
  const endTask = vi.fn((_handoff: unknown, _detail: string) => {});
  const host = { ...base.host, continueTask, endTask, resume: vi.fn(async () => "one-step") };
  return { ...base, host, continueTask, endTask, service: new HumanHandoffs(base.db, host, now) };
}
describe("sign-in pause keeps and continues the same task", () => {
  it("signed in: one fresh check, then the same task continues with its grant, budget and completed steps", async () => {
    const { service, host, continueTask, endTask } = taskSetup();
    const opened = await service.open({ ...input, steps: ["Read payments"], task: task() });
    expect(opened.value).toMatchObject({ state: "awaiting_login", task: { grant: { used: 3, budget: 40 } } });
    expect(opened.value.detail).toMatch(/task is paused/);
    const held = service.bind(opened.id, opened.revision, binding);
    const done = await service.continue(held.id, held.revision);
    expect(done.value).toMatchObject({ state: "closed", resumedRunId: "run-1" });
    expect(done.value.detail).toMatch(/continued the same task/);
    expect(host.verify).toHaveBeenCalledTimes(1); expect(host.restore).toHaveBeenCalledTimes(1);
    const handed = continueTask.mock.calls[0][0] as { value: { state: string; task: ReturnType<typeof task> } };
    expect(handed.value.state).toBe("resuming");
    expect(handed.value.task).toEqual(task());
    expect(host.resume).not.toHaveBeenCalled(); expect(endTask).not.toHaveBeenCalled();
    await expect(service.continue(held.id, held.revision)).rejects.toThrow(/changed/);
    expect(continueTask).toHaveBeenCalledTimes(1);
    // A later sign-in in the same kept run is its own pause.
    const again = await service.open({ ...input, task: task() });
    expect(again.id).toBe(`${held.id}-2`);
  });
  it("a wrong page is not a sign-in: Bud stays stopped and the task is not continued", async () => {
    const { service, host, continueTask } = taskSetup(); host.verify.mockResolvedValue(false);
    const opened = await service.open({ ...input, task: task() }), held = service.bind(opened.id, opened.revision, binding);
    expect((await service.continue(held.id, held.revision)).value.state).toBe("awaiting_login");
    expect(continueTask).not.toHaveBeenCalled();
  });
  it("expired: the task's permission ended, so it asks to start again without checking or continuing", async () => {
    let clock = 1_000_000;
    const { service, host, continueTask, endTask } = taskSetup(() => clock);
    const opened = await service.open({ ...input, task: task(clock + 60_000) }), held = service.bind(opened.id, opened.revision, binding);
    clock += 61_000;
    const ended = await service.continue(held.id, held.revision);
    expect(ended.value.state).toBe("stopped");
    expect(ended.value.detail).toBe("This task's permission ended while you were signing in, so Bud cannot continue it. Start the task again from your request.");
    expect(host.verify).not.toHaveBeenCalled(); expect(continueTask).not.toHaveBeenCalled();
    expect(endTask).toHaveBeenCalledWith(expect.objectContaining({ id: held.id }), ended.value.detail);
    expect((await service.close(ended.id, ended.revision)).value.state).toBe("closed");
  });
  it("expired during the check: it still asks to start again", async () => {
    let clock = 1_000_000;
    const { service, host, continueTask } = taskSetup(() => clock);
    host.verify.mockImplementation(async () => { clock += 120_000; return true; });
    const opened = await service.open({ ...input, task: task(clock + 60_000) }), held = service.bind(opened.id, opened.revision, binding);
    const ended = await service.continue(held.id, held.revision);
    expect(ended.value.state).toBe("stopped"); expect(ended.value.detail).toMatch(/Start the task again/);
    expect(continueTask).not.toHaveBeenCalled();
  });
  it("restart while paused: the card pause stays paused with its task, and Continue still carries on", async () => {
    const { service, db, host, continueTask } = taskSetup();
    const opened = await service.open({ ...input, task: task() }), held = service.bind(opened.id, opened.revision, binding);
    const restarted = new HumanHandoffs(db, { ...host, continueTask }); restarted.recover();
    const kept = restarted.get(held.id);
    expect(kept.value).toMatchObject({ state: "awaiting_login", task: task() }); expect(kept.revision).toBe(held.revision);
    expect((await restarted.continue(kept.id, kept.revision)).value.state).toBe("closed");
    expect(continueTask).toHaveBeenCalledTimes(1);
  });
  it("restart during an in-page sign-in: the old browser session is released and the task stays paused for the card", async () => {
    const { service, db, host } = taskSetup();
    const waiting = service.hold({ ...input, task: task() })!;
    expect(waiting.value).toMatchObject({ state: "awaiting_login", inPage: true });
    expect(host.release).not.toHaveBeenCalled();
    await expect(service.continue(waiting.id, waiting.revision)).rejects.toThrow(/Finish signing in there and press Done/);
    const restarted = new HumanHandoffs(db, host); restarted.recover();
    await vi.waitFor(() => expect(restarted.get(waiting.id).value.state).toBe("awaiting_login"));
    expect(restarted.get(waiting.id).value).toMatchObject({ inPage: false, task: task() });
    expect(host.release).toHaveBeenCalledTimes(1);
  });
  it("in-page: a confirmed sign-in closes the pause; an unconfirmed one hands over to the card with the task kept", async () => {
    const { service, host } = taskSetup();
    const first = service.hold({ ...input, task: task() })!;
    expect(service.hold({ ...input, runId: "run-2", task: { ...task(), context: { ...context, runId: "run-2" }, grant: null } })).toBeNull();
    expect(service.waitingOnPage("run-1")?.id).toBe(first.id);
    expect(service.signedInOnPage(first.id, first.revision).value).toMatchObject({ state: "closed", inPage: false });
    expect(host.release).not.toHaveBeenCalled();
    const second = service.hold({ ...input, task: task() })!;
    expect(second.id).toBe(`${first.id}-2`);
    const later = { ...task(), grant: { ...task().grant, used: 5 } };
    const card = await service.toCard(second.id, second.revision, later);
    expect(card.value).toMatchObject({ state: "awaiting_login", inPage: false, task: later });
    expect(host.release).toHaveBeenCalledTimes(1);
    expect(() => service.signedInOnPage(card.id, card.revision)).toThrow(/changed/);
  });
  it("a card pause over an in-page wait stops Bud on the page first", async () => {
    const { service, host } = taskSetup();
    const waiting = service.hold({ ...input, task: task() })!;
    const card = await service.open({ ...input, task: task() });
    expect(card.id).toBe(waiting.id); expect(card.value).toMatchObject({ state: "awaiting_login", inPage: false });
    expect(host.release).toHaveBeenCalledTimes(1);
  });
  it("Stop ends the kept task plainly and Continue can no longer carry it on", async () => {
    const { service, continueTask, endTask } = taskSetup();
    const opened = await service.open({ ...input, task: task() });
    const stopped = await service.stop(opened.id, opened.revision);
    expect(stopped.value.state).toBe("stopped");
    expect(endTask).toHaveBeenCalledWith(expect.anything(), "Stopped by you while waiting for sign-in. Nothing further was done.");
    await expect(service.continue(stopped.id, stopped.revision)).rejects.toThrow(/changed/);
    expect(continueTask).not.toHaveBeenCalled();
  });
  it("an uncertain continuation is held for review and never retried", async () => {
    const { service, host, continueTask } = taskSetup();
    continueTask.mockRejectedValueOnce(new Error("lost reply"));
    const opened = await service.open({ ...input, task: task() }), held = service.bind(opened.id, opened.revision, binding);
    const result = await service.continue(held.id, held.revision);
    expect(result.value.state).toBe("recovery_required"); expect(JSON.stringify(result)).not.toContain("lost reply");
    service.recover(); expect(continueTask).toHaveBeenCalledTimes(1);
    expect(host.release).toHaveBeenCalledTimes(3);
  });
  it("rejects a saved task for another run or with page-sized records", async () => {
    const { service } = taskSetup();
    await expect(service.open({ ...input, task: { ...task(), context: { ...context, runId: "run-other" } } })).rejects.toThrow(/saved task needs review/);
    await expect(service.open({ ...input, task: { ...task(), completed: ["x".repeat(501)] } })).rejects.toThrow(/saved task needs review/);
    await expect(service.open({ ...input, task: { ...task(), grant: { ...task().grant, used: -1 } } })).rejects.toThrow(/saved task needs review/);
  });
});

// An Ask task pauses exactly like an attended job: the same grant (in its
// context), its remaining steps and time, and Continue only while it holds.
const ASK_RUN = "ask-00000000-0000-4000-8000-0000000000c7";
function askTask(expiresAt: number, used = 2) {
  const text = "Download this month's invoices from portal.fictional-strata.example";
  const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: "00000000-0000-4000-8000-0000000000c7", runId: ASK_RUN, route: "ask",
    request: { text, sha256: createHash("sha256").update(text).digest("hex") }, sites: ["portal.fictional-strata.example"], browser: { id: "fictional-browser", accountMarker: null },
    actions: ["read", "navigate", "click", "download"], consequential: "ask-each", uploads: [], expiresAt, budget: 40 });
  return { version: 1 as const, context: { runId: ASK_RUN, botId: "bud", allowedOrigins: ["portal.fictional-strata.example"], capabilities: ["portal-read" as const], grant },
    grant: { grantId: grant.id, runId: ASK_RUN, expiresAt, budget: 40, used }, completed: ["Downloaded 'Fictional invoice.pdf' (12 bytes) from portal.fictional-strata.example."] };
}
const askInput = { ...input, runId: ASK_RUN, reason: "login" as const };
describe("an Ask task's sign-in pause", () => {
  it("continues the same grant, with its remaining steps, after a confirmed sign-in, also after a restart", async () => {
    let clock = 1_000_000;
    const { service, db, host, continueTask } = taskSetup(() => clock);
    const opened = await service.open({ ...askInput, task: askTask(clock + 30 * 60_000) });
    expect(opened.value).toMatchObject({ state: "awaiting_login", task: { context: { grant: { id: "00000000-0000-4000-8000-0000000000c7", route: "ask" } }, grant: { used: 2, budget: 40 } } });
    expect(service.activeFor(ASK_RUN)?.id).toBe(opened.id);
    const held = service.bind(opened.id, opened.revision, binding);
    clock += 10 * 60_000;
    const restarted = new HumanHandoffs(db, { ...host, continueTask }, () => clock); restarted.recover();
    expect(restarted.get(held.id).value).toMatchObject({ state: "awaiting_login", task: askTask(1_000_000 + 30 * 60_000) });
    const done = await restarted.continue(held.id, held.revision);
    expect(done.value.state).toBe("closed");
    expect((continueTask.mock.calls[0][0] as { value: { task: unknown } }).value.task).toEqual(askTask(1_000_000 + 30 * 60_000));
  });
  it("asks to start again once the grant's time ran out, or its steps are spent, without checking or continuing", async () => {
    let clock = 1_000_000;
    const { service, host, continueTask, endTask } = taskSetup(() => clock);
    const opened = await service.open({ ...askInput, task: askTask(clock + 30 * 60_000) }), held = service.bind(opened.id, opened.revision, binding);
    clock += 31 * 60_000;
    const ended = await service.continue(held.id, held.revision);
    expect(ended.value).toMatchObject({ state: "stopped", detail: "This task's permission ended while you were signing in, so Bud cannot continue it. Start the task again from your request." });
    expect(endTask).toHaveBeenCalledWith(expect.objectContaining({ id: held.id }), ended.value.detail);
    await service.close(ended.id, ended.revision);
    const spent = await service.open({ ...askInput, task: askTask(clock + 30 * 60_000, 40) }), bound = service.bind(spent.id, spent.revision, binding);
    expect((await service.continue(bound.id, bound.revision)).value.detail).toBe("This task used all its browser steps before you signed in, so Bud cannot continue it. Start the task again from your request.");
    // With no step record, the grant's own expiry still decides.
    await service.close(bound.id, (service.get(bound.id)).revision);
    const unrecorded = await service.open({ ...askInput, task: { ...askTask(clock - 1), grant: null } }), check = service.bind(unrecorded.id, unrecorded.revision, binding);
    expect((await service.continue(check.id, check.revision)).value.state).toBe("stopped");
    expect(host.verify).not.toHaveBeenCalled(); expect(continueTask).not.toHaveBeenCalled();
  });
  it("rejects a saved grant for another run or whose step record belongs to another grant", async () => {
    const { service } = taskSetup();
    const task = askTask(Date.now() + 60_000);
    await expect(service.open({ ...askInput, task: { ...task, context: { ...task.context, grant: { ...task.context.grant, runId: "ask-other" } } } })).rejects.toThrow(/saved task needs review/);
    await expect(service.open({ ...askInput, task: { ...task, grant: { ...task.grant, grantId: "grant-other" } } })).rejects.toThrow(/saved task needs review/);
    await expect(service.open({ ...askInput, task: { ...task, context: { ...task.context, grant: { ...task.context.grant, actions: ["pay"] } } } as never })).rejects.toThrow(/saved task needs review/);
  });
});

// The broker's in-page hand-off with the pause store the host wires to it
// (server/index.ts onBrowserSignIn): the person signs in on the page itself.
async function pageFixture(grantId: string, outcome: string, budget: number | null = null) {
  const root = privateTempRoot(join(tmpdir(), "rb-signin-page-"));
  const { service, host } = taskSetup();
  const LOGIN = '@e1 textbox "Password"\n@e2 button "Sign in"', SIGNED_IN = 'Fictional office 41\nTransaction history\n@e1 button "Show details"';
  let page = LOGIN, session = false, scope = "user";
  const calls: string[][] = [];
  const command = async (args: string[]): Promise<BrowserJson> => {
    calls.push(args);
    const interaction = { borrow_confirmation: "always", request_help: "enabled" };
    if (args[0] === "status") return { daemon_version: "0.3.1", protocol_version: "1.3", browsers: [{ instance_id: "work", browser_name: "Chrome", extension_version: "0.3.1", extension_protocol_version: "1.3" }], sessions: session ? [{ session_id: "owned", browser_instance_id: "work", interaction }] : [] };
    if (args[0] === "session" && args[1] === "start") { session = true; return { session_id: "owned", browser_instance_id: "work", interaction }; }
    if (args[0] === "session" && args[1] === "stop") { session = false; return { stopped: ["owned"], failed: [], return_failures: [] }; }
    if (args[0] === "tab" && args[1] === "list") return { tabs: [{ tab_id: 1, url: "https://bank.example/login", title: "Fictional bank", scope }] };
    if (args[0] === "tab" && args[1] === "borrow") { scope = "agent"; return { ok: true }; }
    if (args[0] === "observe") return { text: page, tab_id: 1, truncated: false };
    if (args[0] === "request-help") { if (outcome === "completed") page = SIGNED_IN; return { ok: true, outcome }; }
    return { ok: true };
  };
  const runtime = new BrowserRuntime({ root, command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  const text = "Fictional statement task";
  const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: grantId, runId: "run-1", route: "job", request: { text, sha256: createHash("sha256").update(text).digest("hex") },
    sites: ["bank.example"], browser: { id: null, accountMarker: null }, actions: ["read", "navigate", "click"], consequential: "ask-each", uploads: [], expiresAt: null, budget });
  // The host side, as server/index.ts wires it: save the pause first, then close it or hand over to the card.
  const stopHost = onBrowserSignIn({
    waiting: event => service.hold({ ...input, reason: event.reason, task: { version: 1, context: { ...context }, grant: event.task, completed: [] } }) !== null,
    finished: event => {
      const held = service.waitingOnPage(event.runId); if (!held) return;
      if (event.signedIn) service.signedInOnPage(held.id, held.revision);
      else void service.toCard(held.id, held.revision, { version: 1, context: { ...context }, grant: event.task, completed: [] });
    },
  });
  const notes: string[] = [];
  const stopNotes = onBrowserDecision(event => { notes.push(event.entry.note); });
  const broker = await startBrowserBroker({ runtime, grant, threadId: "thread-1", runId: "run-1", context: { allowedOrigins: ["bank.example"], capabilities: ["portal-read"] },
    operations: new ConnectedAppOperationStore({ file: join(root, "operations.json") }), approvals: new BrowserApprovalStore({ file: join(root, "approvals.json") }),
    isActive: () => true, approve: async () => true, assertCapability: () => {} });
  let id = 0;
  const call = async (name: string, args: BrowserJson = {}) => (await (await fetch(broker.descriptor.url, { method: "POST", headers: { "content-type": "application/json", authorization: broker.descriptor.headers[0].value },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) })).json() as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  const close = async () => { stopHost(); stopNotes(); broker.close(); await broker.released(); await removeFixture(root); };
  return { service, host, calls, notes, call, close };
}
describe("in-page sign-in through the browser broker", () => {
  it("the person signs in on the page and the same browser step carries on with the task's budget", async () => {
    const f = await pageFixture("grant-page-signed-in", "completed", 5);
    try {
      expect((await f.call("browser_borrow", { tab_id: 1 })).isError).toBeUndefined();
      const read = await f.call("browser_read", { tab_id: 1 });
      expect(read.isError).toBeUndefined();
      expect(read.content[0].text).toContain("Transaction history");
      const help = f.calls.find(args => args[0] === "request-help")!;
      expect(help.slice(0, 5)).toEqual(["request-help", "--session", "owned", "--tab-id", "1"]);
      expect(help.join(" ")).toMatch(/does not see or keep what you type/);
      const record = f.service.list()[0];
      expect(record.value).toMatchObject({ state: "closed", inPage: false, task: { grant: { grantId: "grant-page-signed-in", budget: 5, used: 1 } } });
      expect(f.host.release).not.toHaveBeenCalled();
      expect(f.notes.join("\n")).toMatch(/Asked you to finish the sign-in page on bank.example[\s\S]*You finished the sign-in page on bank.example/);
      // The same broker keeps working after the sign-in: nothing was replayed or re-borrowed.
      expect((await f.call("browser_read", { tab_id: 1 })).isError).toBeUndefined();
      expect(f.calls.filter(args => args[0] === "tab" && args[1] === "borrow")).toHaveLength(1);
    } finally { await f.close(); }
  });
  it("a declined or unconfirmed sign-in hands over to the card with the task kept", async () => {
    const f = await pageFixture("grant-page-cancelled", "cancelled");
    try {
      await f.call("browser_borrow", { tab_id: 1 });
      const read = await f.call("browser_read", { tab_id: 1 });
      expect(read.isError).toBe(true); expect(read.content[0].text).toMatch(/sign-in or security fields/);
      await vi.waitFor(() => expect(f.service.list()[0].value.state).toBe("awaiting_login"));
      expect(f.service.list()[0].value).toMatchObject({ inPage: false, task: { grant: { grantId: "grant-page-cancelled", used: 1 } } });
      expect(f.host.release).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
  it("a continued task keeps its spent budget: a new broker for the same grant does not refill it", async () => {
    restoreBrowserTaskUsage({ grantId: "grant-page-spent", runId: "run-1", expiresAt: null, budget: 1, used: 1 });
    const f = await pageFixture("grant-page-spent", "completed", 1);
    try {
      const borrow = await f.call("browser_borrow", { tab_id: 1 });
      expect(borrow.isError).toBe(true); expect(borrow.content[0].text).toMatch(/step limit/);
      expect(browserTaskUsage("run-1")).toMatchObject({ grantId: "grant-page-spent", used: 1 });
    } finally { await f.close(); }
  });
});
