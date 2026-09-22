import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchService } from "./batches.ts";
import { Desk } from "./desk.ts";
import { batchCounts } from "../shared/batches.ts";

const dirs: string[] = [];
const services: BatchService[] = [];
const receipt = (gaps: string[] = []) => ({ ok: true as const, stdout: JSON.stringify({ summary: "Prepared", evidence: ["Saved sample"], outputs: ["Draft for this property."], needsApproval: gaps }), detail: "" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(canRecover?: () => boolean) {
  const dir = mkdtempSync(join(tmpdir(), "realbud-batches-")); dirs.push(dir);
  const desk = new Desk({ file: join(dir, "desk.json") });
  const snapshot = desk.snapshot();
  const ask = vi.fn(async () => receipt());
  const available = vi.fn(async () => true);
  const notes = vi.fn((id: string) => `Private reference for ${id}`);
  const file = join(dir, "batches.json");
  const deps = { retryDelayMs: 0, file, snapshot: () => snapshot, notes, ask, available, canRecover };
  const service = new BatchService(deps); services.push(service);
  const input = { task: "owner-update", propertyIds: ["prop-oak", "prop-pine"], instruction: "Concise please", requestKey: "request-0001", expectedRevision: snapshot.revision };
  return { service, snapshot, ask, available, notes, input, file, deps };
}
afterEach(() => { services.splice(0).forEach(s => s.stop()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.restoreAllMocks(); });

describe("durable property batches", () => {
  it("isolates each property, saves complete results, and uses only bounded preparation tools", async () => {
    const { service, input, ask, file } = setup();
    const created = service.create(input); await service.wait(created.id);
    const result = service.get(created.id);
    expect(result.status).toBe("finished");
    expect(result.items.map(i => i.status)).toEqual(["ready", "ready"]);
    expect(ask).toHaveBeenCalledTimes(2);
    const calls = ask.mock.calls as unknown as [string, unknown][];
    expect(calls[0][0]).toContain("12 Oak");
    expect(calls[0][0]).toContain("Sam Nguyen");
    expect(calls[0][0]).not.toContain("Jordan Blake");
    expect(calls[1][0]).toContain("Jordan Blake");
    expect(calls[0][0]).not.toContain("8 Pine");
    expect(calls[1][0]).toContain("8 Pine");
    expect(calls[1][0]).not.toContain("12 Oak");
    expect(calls[0][1]).toEqual({ toolsets: ["todo"], maxTurns: 3, timeoutMs: 120000, signal: expect.any(AbortSignal) });
    expect(JSON.parse(readFileSync(file, "utf8"))[0]).toEqual(result);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([
    { task: "send-all" }, { autoContinue: "yes" }, { propertyIds: [] }, { propertyIds: ["prop-oak", "prop-oak"] },
    { propertyIds: Array.from({ length: 501 }, (_, n) => `prop-${n}`) },
    { propertyIds: [123] }, { instruction: "x".repeat(1001) }, { requestKey: "short" },
    { expectedRevision: -1 }, { propertyIds: ["missing"] },
  ])("rejects invalid or stale scope without dispatch: %j", patch => {
    const { service, input, ask } = setup();
    expect(() => service.create({ ...input, ...patch })).toThrow();
    expect(ask).not.toHaveBeenCalled(); expect(service.list()).toEqual([]);
  });

  it("deduplicates uncertain submissions even after book changes and rejects key reuse for different work", async () => {
    const { service, input, ask, snapshot } = setup();
    const first = service.create(input);
    expect(service.create({ ...input, propertyIds: [...input.propertyIds].reverse() }).id).toBe(first.id);
    snapshot.revision++;
    expect(service.create(input).id).toBe(first.id);
    expect(() => service.create({ ...input, instruction: "Different" })).toThrow(/different work/);
    await service.wait(first.id); expect(ask).toHaveBeenCalledTimes(2);
  });

  it("serializes batches while a readiness check is in flight", async () => {
    const { service, input, available } = setup();
    const check = deferred<boolean>(); available.mockReturnValueOnce(check.promise);
    const first = service.create(input);
    await Promise.resolve();
    expect(() => service.create({ ...input, requestKey: "request-0002" })).toThrow(/already preparing/);
    check.resolve(true); await service.wait(first.id);
  });

  it("keeps partial success and retries only failures without repeating prepared results", async () => {
    const { service, input, ask } = setup();
    ask.mockResolvedValueOnce(receipt(["Confirm access"])).mockRejectedValueOnce(new Error("private worker payload"));
    const created = service.create(input); await service.wait(created.id);
    let batch = service.get(created.id);
    expect(batch.items.map(i => i.status)).toEqual(["needs-review", "failed"]);
    expect(JSON.stringify(batch)).not.toContain("private worker payload");
    service.control(batch.id, "retry-failed", batch.revision); await service.wait(batch.id);
    batch = service.get(batch.id);
    expect(batch.items.map(i => i.attempt)).toEqual([1, 2]);
    expect(ask).toHaveBeenCalledTimes(3);
    const reviewed = service.control(batch.id, "review", batch.revision, "prop-oak");
    expect(batchCounts(reviewed)).toMatchObject({ ready: 2, reviewed: 1, attention: 0 });
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("pauses after the current property, retries failures alone, then resumes never-started properties", async () => {
    const { service, input, ask } = setup();
    const started = deferred<void>(); const worker = deferred<ReturnType<typeof receipt>>();
    ask.mockImplementationOnce(() => { started.resolve(); return worker.promise; });
    const created = service.create(input); await started.promise;
    let batch = service.get(created.id);
    service.control(batch.id, "pause", batch.revision);
    batch = service.get(batch.id);
    expect(() => service.control(batch.id, "resume", batch.revision)).toThrow(/current property/);
    worker.resolve({ ...receipt(), stdout: "Not valid JSON" }); await service.wait(batch.id);
    batch = service.get(batch.id);
    expect(batch.items.map(i => i.status)).toEqual(["failed", "queued"]);
    service.control(batch.id, "retry-failed", batch.revision); await service.wait(batch.id);
    batch = service.get(batch.id);
    expect(batch.status).toBe("paused");
    expect(batch.items.map(i => i.attempt)).toEqual([2, 0]);
    service.control(batch.id, "resume", batch.revision); await service.wait(batch.id);
    expect(service.get(batch.id).items.map(i => i.attempt)).toEqual([2, 1]);
  });

  it("recovers after a restart without auto-running or losing completed properties", async () => {
    const { service, input, ask, deps } = setup();
    const started = deferred<void>(); const worker = deferred<ReturnType<typeof receipt>>();
    ask.mockResolvedValueOnce(receipt()).mockImplementationOnce(() => { started.resolve(); return worker.promise; });
    const created = service.create(input); await started.promise;
    service.stop(); worker.resolve(receipt()); await service.wait(created.id);
    const recovered = new BatchService(deps); services.push(recovered);
    let batch = recovered.get(created.id);
    expect(batch.status).toBe("paused");
    expect(batch.items.map(i => i.status)).toEqual(["ready", "interrupted"]);
    expect(ask).toHaveBeenCalledTimes(2);
    recovered.control(batch.id, "retry-failed", batch.revision); await recovered.wait(batch.id);
    batch = recovered.get(batch.id);
    expect(batch.items.map(i => i.attempt)).toEqual([1, 2]);
  });

  it("holds unavailable Bud without using an attempt, then resumes after connection recovery", async () => {
    const { service, input, available, ask } = setup(); available.mockRejectedValueOnce(new Error("offline"));
    const created = service.create(input); await service.wait(created.id);
    const paused = service.get(created.id);
    expect(paused.status).toBe("paused"); expect(paused.items[0].attempt).toBe(0); expect(ask).not.toHaveBeenCalled();
    service.control(paused.id, "resume", paused.revision); await service.wait(paused.id);
    expect(service.get(paused.id).status).toBe("finished");
  });

  it("rejects stale controls, unprepared review, and effectful actions", async () => {
    const { service, input, available } = setup(); available.mockResolvedValue(false);
    const created = service.create(input); await service.wait(created.id);
    const paused = service.get(created.id);
    expect(() => service.control(paused.id, "resume", created.revision)).toThrow(/progress changed/);
    expect(() => service.control(paused.id, "review", paused.revision, "prop-oak")).toThrow(/prepared result/);
    expect(() => service.control(paused.id, "send", paused.revision)).toThrow(/Unknown/);
  });

  it("holds book recovery at creation and after asynchronous readiness without corrupting batch history", async () => {
    const { service, input, snapshot, available, ask } = setup();
    snapshot.recovery.active = true;
    expect(() => service.create(input)).toThrow(/Unlock/);
    snapshot.recovery.active = false;
    const check = deferred<boolean>(); available.mockReturnValueOnce(check.promise);
    const created = service.create(input); await Promise.resolve();
    snapshot.recovery.active = true; check.resolve(true); await service.wait(created.id);
    expect(ask).not.toHaveBeenCalled(); expect(() => service.list()).toThrow(/Unlock/);
    snapshot.recovery.active = false;
    expect(service.get(created.id)).toMatchObject({ status: "paused", detail: expect.stringContaining("locked") });
  });

  it("preserves corrupt history and blocks new work", () => {
    const { file, deps, input } = setup(); writeFileSync(file, "broken-original");
    const broken = new BatchService(deps); services.push(broken);
    expect(() => broken.create(input)).toThrow(/not been replaced/);
    expect(readFileSync(file, "utf8")).toBe("broken-original");
  });

  it("stops dispatch if persisting progress fails", async () => {
    const { service, input, file, available, ask } = setup();
    const check = deferred<boolean>(); available.mockReturnValueOnce(check.promise);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const created = service.create(input); await Promise.resolve();
    rmSync(file); mkdirSync(file); check.resolve(true); await service.wait(created.id);
    expect(ask).not.toHaveBeenCalled(); expect(() => service.list()).toThrow(/could not be saved/);
    expect(log).toHaveBeenCalledWith("RealBud batch preparation stopped: progress persistence failed");
  });

  it("marks oversized source excerpts explicitly and bounds saved input", async () => {
    const { service, input, notes } = setup(); notes.mockReturnValue("n".repeat(10000));
    const created = service.create(input); await service.wait(created.id);
    expect(created.items[0].source).toContain("Excerpt only");
    expect(created.items[0].source.length).toBeLessThanOrEqual(16000);
  });

  it("accepts the 500-property boundary on a 1,000-property book without expanding worker scope", async () => {
    const { service, input, snapshot, available } = setup();
    snapshot.properties = Array.from({ length: 1000 }, (_, n) => ({ ...snapshot.properties[0], id: `scale-${n}`, address: `${n} Fictional Scale Street` }));
    available.mockResolvedValue(false);
    const batch = service.create({ ...input, propertyIds: snapshot.properties.slice(0, 500).map(p => p.id) });
    await service.wait(batch.id);
    expect(batch.items).toHaveLength(500);
    expect(batch.items[0].source).not.toContain("999 Fictional");
    expect(batch.items[0].source).not.toContain("49 Fictional");
    expect(service.summaries()[0].counts.total).toBe(500);
    expect(JSON.stringify(service.summaries()).length).toBeLessThan(1000);
  });

  it.each(["not json", JSON.stringify({ summary: "empty", evidence: [], outputs: [], needsApproval: [] }), JSON.stringify({ summary: "too long", evidence: [], outputs: ["x".repeat(25000)], needsApproval: [] })])("keeps incomplete or oversized output retryable", async stdout => {
    const { service, input, ask } = setup(); ask.mockResolvedValue({ ...receipt(), stdout });
    const batch = service.create(input); await service.wait(batch.id);
    expect(service.get(batch.id).items.every(i => i.status === "failed" && !i.output)).toBe(true);
  });
});


describe("persistent portfolio preparation", () => {
  it.each(['before probe', 'during probe'] as const)('preserves automatic recovery while the host pauses %s', async when => {
    let held = false;
    const { service, input, available, ask, file } = setup(() => !held);
    available.mockResolvedValue(false);
    const created = service.create({ ...input, autoContinue: true }); await service.wait(created.id);
    const before = readFileSync(file), calls = available.mock.calls.length;
    expect(service.get(created.id)).toMatchObject({ status: 'paused', waitingForWorker: true });
    if (when === 'before probe') {
      held = true; await service.recoverReadyWork(); expect(available).toHaveBeenCalledTimes(calls);
    } else {
      const probe = deferred<boolean>(); available.mockReturnValueOnce(probe.promise);
      const recovery = service.recoverReadyWork(); expect(available).toHaveBeenCalledTimes(calls + 1);
      held = true; probe.resolve(true); await recovery;
    }
    expect(readFileSync(file)).toEqual(before); expect(ask).not.toHaveBeenCalled();
    expect(service.get(created.id)).toMatchObject({ status: 'paused', waitingForWorker: true });
    held = false; available.mockResolvedValue(true);
    await service.recoverReadyWork(); await service.wait(created.id);
    expect(service.get(created.id).status).toBe('finished'); expect(ask).toHaveBeenCalledTimes(2);
    expect(service.get(created.id).items.map(item => item.attempt)).toEqual([1, 1]);
  });

  it.each([20, 50, 100, 150, 200, 500])("completes %i independent properties and preserves progress on reload", async count => {
    const { service, snapshot, input, ask, deps } = setup();
    snapshot.properties = Array.from({ length: count }, (_, n) => ({ ...snapshot.properties[0], id: `portfolio-${n}`, address: `${n} Portfolio Road` }));
    const created = service.create({ ...input, propertyIds: snapshot.properties.map(p => p.id), autoContinue: true });
    await service.wait(created.id);
    expect(service.get(created.id).items.every(i => i.status === "ready" && i.attempt === 1)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(count);
    service.stop();
    const restored = new BatchService(deps); services.push(restored);
    expect(restored.get(created.id).status).toBe("finished");
    await restored.recoverReadyWork();
    expect(ask).toHaveBeenCalledTimes(count);
    expect(restored.view(created.id)?.items.every(i => i.source === "" && i.output)).toBe(true);
    expect(restored.view(created.id, restored.get(created.id).revision)).toBeNull();
  }, 60000);

  it("resumes after restart only when opted in and never repeats completed items", async () => {
    const { service, input, ask, deps } = setup();
    const worker = deferred<ReturnType<typeof receipt>>();
    ask.mockResolvedValueOnce(receipt()).mockReturnValueOnce(worker.promise);
    const created = service.create({ ...input, autoContinue: true });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    service.stop(); worker.resolve(receipt()); await service.wait(created.id);
    const restored = new BatchService(deps); services.push(restored);
    await vi.waitFor(() => expect(restored.get(created.id).status).toBe("finished"));
    expect(restored.get(created.id).items.map(i => i.attempt)).toEqual([1, 2]);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("reconnects automatically without overlapping readiness checks, but respects manual pause", async () => {
    const { service, input, available, ask } = setup();
    available.mockResolvedValue(false);
    const created = service.create({ ...input, autoContinue: true }); await service.wait(created.id);
    expect(service.get(created.id).waitingForWorker).toBe(true);
    const gate = deferred<boolean>(); available.mockReturnValueOnce(gate.promise);
    const recovery = service.recoverReadyWork(); await service.recoverReadyWork();
    expect(available).toHaveBeenCalledTimes(2);
    service.control(created.id, "pause", service.get(created.id).revision);
    gate.resolve(true); await recovery;
    available.mockResolvedValue(true); await service.recoverReadyWork();
    expect(ask).not.toHaveBeenCalled();
    expect(service.get(created.id).waitingForWorker).toBe(false);
    service.control(created.id, "resume", service.get(created.id).revision); await service.wait(created.id);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("continues automatically after availability returns", async () => {
    const { service, input, available, ask } = setup();
    available.mockResolvedValue(false);
    const created = service.create({ ...input, autoContinue: true }); await service.wait(created.id);
    available.mockResolvedValue(true); await service.recoverReadyWork(); await service.wait(created.id);
    expect(service.get(created.id).status).toBe("finished"); expect(ask).toHaveBeenCalledTimes(2);
  });

  it("bounds automatic retries per property and continues to the rest of the book", async () => {
    const { service, input, ask } = setup();
    ask.mockRejectedValueOnce(new Error("private failure")).mockRejectedValueOnce(new Error("private failure")).mockRejectedValueOnce(new Error("private failure"));
    const created = service.create({ ...input, autoContinue: true }); await service.wait(created.id);
    const result = service.get(created.id);
    expect(result.items.map(i => [i.status, i.attempt])).toEqual([["failed", 3], ["ready", 1]]);
    expect(JSON.stringify(result)).not.toContain("private failure");
    expect(ask).toHaveBeenCalledTimes(4);
  });

  it("saves a retry deadline and a manual pause cancels the pending wait", async () => {
    const { service, input, ask, deps } = setup(); deps.retryDelayMs = 60000;
    ask.mockRejectedValueOnce(new Error("temporary"));
    const created = service.create({ ...input, autoContinue: true });
    await vi.waitFor(() => expect(service.get(created.id).items[0].retryAt).toBeGreaterThan(Date.now()));
    service.control(created.id, "pause", service.get(created.id).revision);
    await service.wait(created.id);
    expect(service.get(created.id).status).toBe("paused"); expect(ask).toHaveBeenCalledTimes(1);
  });

  it("does not resume through book recovery or enable persistence on an idempotent replay", async () => {
    const { service, input, available, snapshot, ask } = setup(); available.mockResolvedValue(false);
    const created = service.create(input); await service.wait(created.id);
    expect(() => service.create({ ...input, autoContinue: true })).toThrow(/different work/);
    snapshot.recovery.active = true; available.mockResolvedValue(true);
    await service.recoverReadyWork(); expect(ask).not.toHaveBeenCalled();
  });
});

describe("batch history capacity", () => {
  it("keeps unreviewed completed results when the property-result budget is full", async () => {
    const { service, input, deps, file } = setup();
    const created = service.create(input); await service.wait(created.id);
    const finished = service.get(created.id); service.stop();
    const history = Array.from({ length: 4 }, (_, n) => ({ ...finished, id: `batch-${n}`, requestKey: `request-${n}-history`, items: Array.from({ length: 500 }, (_, p) => ({ ...finished.items[0], propertyId: `property-${p}`, address: `${p} History Road` })) }));
    writeFileSync(file, JSON.stringify(history));
    const restored = new BatchService(deps); services.push(restored);
    expect(() => restored.create({ ...input, requestKey: "new-capacity-request" })).toThrow(/unreviewed results are kept/);
    expect(restored.list()).toHaveLength(4);
    expect(restored.list().reduce((sum, b) => sum + b.items.length, 0)).toBe(2000);
  });
});
