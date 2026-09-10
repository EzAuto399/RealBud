import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapInvocation, bootstrapPending, bootstrapPlan, downloadBootstrap, finishWorkerBootstrap, runBootstrapStage, runWorkerBootstrap } from "./worker-bootstrap.ts";
import { HERMES_PIN } from "./hermes-pin.ts";

const homes: string[] = [];
const home = () => { const path = mkdtempSync(join(tmpdir(), "bud-setup-test-")); homes.push(path); return path; };
const bytes = Buffer.from("reviewed fixture");
const plan = { url: "https://example.invalid/setup", sha256: createHash("sha256").update(bytes).digest("hex") };
const controller = () => new AbortController();
const fixture = (root = home()) => ({ home: root, platform: "darwin" as const, signal: controller().signal, progress: vi.fn(), download: async () => bytes, execute: vi.fn(async () => {}) });
afterEach(() => { for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("verified setup download", () => {
  it("accepts matching bytes and forbids redirects", async () => {
    const request = vi.fn(async () => new Response(bytes));
    expect(await downloadBootstrap(plan, controller().signal, request)).toEqual(bytes);
    expect(request).toHaveBeenCalledWith(plan.url, expect.objectContaining({ redirect: "error" }));
  });
  it("rejects modified, oversized and unavailable downloads", async () => {
    await expect(downloadBootstrap(plan, controller().signal, async () => new Response("changed"))).rejects.toThrow(/verified version/);
    await expect(downloadBootstrap(plan, controller().signal, async () => new Response(new Uint8Array(1_000_001)))).rejects.toThrow(/size/);
    await expect(downloadBootstrap(plan, controller().signal, async () => new Response("", { status: 503 }))).rejects.toThrow(/downloaded/);
  });
  it("stops a stalled body when cancelled", async () => {
    const abort = controller();
    const cancelled = vi.fn();
    const result = downloadBootstrap(plan, abort.signal, async () => new Response(new ReadableStream({ cancel: cancelled })));
    await Promise.resolve();
    abort.abort();
    await expect(result).rejects.toThrow();
    expect(cancelled).toHaveBeenCalled();
  });
});

describe("runtime stage contract", () => {
  it.each(["darwin", "linux", "win32"] as const)("pins %s and excludes separate apps, gateways and account wizards", platform => {
    const spec = bootstrapPlan(platform)!;
    expect(spec.url).toContain(HERMES_PIN.commit);
    expect(spec.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(spec.stages).not.toEqual(expect.arrayContaining(["desktop"]));
    for (const stage of spec.stages) expect(["desktop", "gateway", "setup", "configure"]).not.toContain(stage);
    const invocation = bootstrapInvocation(platform, "/some path/setup", spec.stages[0], "/a home/with spaces");
    expect(invocation.args).toContain("/some path/setup");
    expect(invocation.args).toContain("/a home/with spaces");
    expect(invocation.args).toContain(HERMES_PIN.commit);
    expect(invocation.args.join(" ")).not.toMatch(/ExecutionPolicy|Bypass/i);
  });
  it("rejects unknown platforms and stage injection", () => {
    expect(bootstrapPlan("aix")).toBeNull();
    expect(() => bootstrapInvocation("darwin", "file", "repository; echo bad", "home")).toThrow();
  });
  it("runs stages in order, cleans the download and stays pending until verification", async () => {
    const options = fixture(); const files: string[] = []; const stages: string[] = [];
    await runWorkerBootstrap({ ...options, execute: async invocation => {
      files.push(invocation.args[0]); stages.push(invocation.args[2]);
      expect(readFileSync(invocation.args[0])).toEqual(bytes);
    } });
    expect(stages).toEqual(bootstrapPlan("darwin")!.stages);
    expect(existsSync(dirname(files[0]))).toBe(false);
    expect(bootstrapPending(options.home)).toBe(true);
    finishWorkerBootstrap(options.home);
    expect(bootstrapPending(options.home)).toBe(false);
  });
  it("stops after a failed step and permits a bounded explicit retry", async () => {
    const options = fixture(); let count = 0;
    await expect(runWorkerBootstrap({ ...options, execute: async () => { if (++count === 2) throw new Error("fixture failure"); } })).rejects.toThrow("fixture failure");
    expect(count).toBe(2);
    expect(bootstrapPending(options.home)).toBe(true);
    await runWorkerBootstrap(options);
    expect(options.execute).toHaveBeenCalledTimes(8);
  });
  it("holds the installation lock through final verification", async () => {
    const options = fixture(); let finish!: () => void;
    let finalizingResolve!: () => void;
    const finalizing = new Promise<void>(resolve => { finalizingResolve = resolve; });
    const first = runWorkerBootstrap({ ...options, finalize: async () => { finalizingResolve(); await new Promise<void>(resolve => { finish = resolve; }); } });
    await finalizing;
    await expect(runWorkerBootstrap(fixture(options.home))).rejects.toThrow(/already running/);
    finish(); await first;
    await runWorkerBootstrap(fixture(options.home));
  });
  it("preserves unknown installs and refuses to overlap an orphaned process", async () => {
    const root = home(); mkdirSync(join(root, "hermes-agent"));
    await expect(runWorkerBootstrap(fixture(root))).rejects.toThrow(/existing installation/);
    writeFileSync(join(root, ".realbud-bootstrap.json"), JSON.stringify({ version: 1, pending: true, childPid: process.pid }));
    await expect(runWorkerBootstrap(fixture(root))).rejects.toThrow(/earlier setup/);
    writeFileSync(join(root, ".realbud-bootstrap.json"), "broken");
    await expect(runWorkerBootstrap(fixture(root))).rejects.toThrow(/record/);
  });
  it("never runs the real installer in the test environment", async () => {
    const options = fixture();
    await expect(runWorkerBootstrap({ ...options, execute: undefined })).rejects.toThrow(/disabled in automated tests/);
    expect(existsSync(join(options.home, ".realbud-bootstrap.json"))).toBe(false);
  });
});


describe("setup subprocess boundary", () => {
  it("kills a stalled owned process on cancellation", async () => {
    const root = home(); const abort = controller();
    const result = runBootstrapStage({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, root, abort.signal);
    const record = JSON.parse(readFileSync(join(root, ".realbud-bootstrap.json"), "utf8"));
    expect(record.childPid).toBeGreaterThan(0);
    abort.abort();
    await expect(result).rejects.toThrow(/Setup stopped/);
    expect(() => process.kill(record.childPid, 0)).toThrow();
  });
  it("reports a failed subprocess without exposing its output", async () => {
    await expect(runBootstrapStage({ command: process.execPath, args: ["-e", "console.error('secret-fixture-value');process.exit(1)"] }, home(), controller().signal)).rejects.toThrow(/couldn’t finish this step/);
  });
});
