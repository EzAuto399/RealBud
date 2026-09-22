import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowDatabase } from "./workflow-database.ts";
import { HumanHandoffs, validateLoginBinding } from "./human-handoffs.ts";
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
