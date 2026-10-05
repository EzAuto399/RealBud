import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateTempRoot } from "./testing/private-fixture.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserApprovalStore, type BrowserApprovalDraft } from "./browser-authority.ts";
import { HELD_STEP_RECONCILE_PATH, HELD_STEPS_PATH, WORKER_CUSTODY_CHECK_PATH, WORKER_CUSTODY_PATH, recoveryRoute } from "./recovery-holds.ts";

const hex = (c: string) => c.repeat(64);
const draft = (effect = "a"): BrowserApprovalDraft => ({
  kind: "pay", origin: "https://portal.fictional-strata.example", url: "https://portal.fictional-strata.example/levies/pay",
  control: { ref: "e12", label: "button \"Pay now\"" },
  facts: [
    { name: "recipient", value: "Fictional Strata Pty Ltd", confirmed: true },
    { name: "amount", value: "1240.00", confirmed: true },
    { name: "currency", value: "AUD", confirmed: true },
  ],
  unconfirmed: [], observationHash: hex("b"), fingerprint: hex(effect), effect: hex(effect), expiresAt: Date.now() + 120_000,
  summary: "Pay AUD 1240.00 to Fictional Strata Pty Ltd",
});
const owner = { grantId: "grant-fictional", runId: "run-fictional", threadId: "thread-fictional" };
async function storeWith(outcome: "unverified" | "not-dispatched" | "dispatching") {
  const store = new BrowserApprovalStore({ file: join(privateTempRoot(join(tmpdir(), "realbud-held-")), "browser-approvals.json") });
  const row = await store.create(draft(), owner, "pending");
  await store.update(row.id, { decision: "approved", outcome, decidedAt: Date.now() });
  return { store, id: row.id };
}
const post = (store: BrowserApprovalStore, body: unknown, contentType = "application/json") =>
  recoveryRoute(HELD_STEP_RECONCILE_PATH, "POST", contentType, async () => body, () => store);

describe("held browser steps", () => {
  it("lists a held step with the facts its approval showed", async () => {
    const { store, id } = await storeWith("unverified");
    const reply = await recoveryRoute(HELD_STEPS_PATH, "GET", undefined, async () => ({}), () => store);
    const steps = (reply!.body as { steps: Array<Record<string, any>> }).steps;
    expect(reply!.status).toBe(200);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id, host: "portal.fictional-strata.example", summary: "Pay AUD 1240.00 to Fictional Strata Pty Ltd" });
    expect(steps[0].approval).toMatchObject({ kind: "pay", site: "portal.fictional-strata.example", control: "Pay now" });
    expect(steps[0].approval.facts).toContainEqual({ name: "recipient", value: "Fictional Strata Pty Ltd", confirmed: true });
  });

  it("'It didn't happen' releases the repeat; 'It happened' records it done", async () => {
    for (const result of ["not-done", "confirmed"] as const) {
      const { store, id } = await storeWith("unverified");
      expect(await store.unresolved(hex("a"), hex("a"))).toBeDefined();
      const reply = await post(store, { id, result });
      expect(reply).toEqual({ status: 200, body: { result, steps: [] } });
      expect(await store.unresolved(hex("a"), hex("a"))).toBeUndefined();
      expect((await store.list())[0]).toMatchObject({ outcome: result, reconciledAt: expect.any(Number) });
      // A second answer is refused: the record is no longer held.
      expect((await post(store, { id, result }))!.status).toBe(409);
    }
  });

  it("refuses a step that was never pressed, an unknown id and anything but the two answers", async () => {
    const { store, id } = await storeWith("not-dispatched");
    expect((await recoveryRoute(HELD_STEPS_PATH, "GET", undefined, async () => ({}), () => store))!.body).toEqual({ steps: [] });
    expect(await post(store, { id, result: "confirmed" })).toMatchObject({ status: 409 });
    expect((await store.list())[0].outcome).toBe("not-dispatched");
    expect((await post(store, { id: "00000000-0000-4000-8000-000000000000", result: "confirmed" }))!.status).toBe(404);
    for (const body of [{ id, result: "succeeded" }, { id, result: "unknown" }, { id }, { result: "confirmed" }, { id: "../x", result: "confirmed" }, null, "confirmed"]) {
      expect((await post(store, body))!.status).toBe(400);
    }
    expect((await post(store, { id, result: "confirmed" }, "text/plain"))!.status).toBe(415);
  });

  it("leaves other paths to the rest of the server", async () => {
    expect(await recoveryRoute("/api/browser/connect", "POST", "application/json", async () => ({}))).toBeNull();
    expect(await recoveryRoute(HELD_STEPS_PATH, "DELETE", "application/json", async () => ({}))).toBeNull();
  });
});

describe("worker custody check", () => {
  const owned: ChildProcess[] = [];
  afterEach(() => {
    for (const child of owned.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
    vi.unstubAllEnvs();
  });

  it.skipIf(process.platform === "win32")("refuses to clear while the earlier group is alive and clears once it is gone", async () => {
    vi.stubEnv("REALBUD_DATA_DIR", mkdtempSync(join(tmpdir(), "realbud-custody-route-")));
    const worker = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore", detached: true });
    owned.push(worker);
    vi.resetModules();
    expect((await import("./worker-custody.ts")).recordWorkerCustody(worker.pid!)).toBe(true);
    // A fresh module instance stands in for RealBud after a restart.
    vi.resetModules();
    const { recoveryRoute: route } = await import("./recovery-holds.ts");
    const check = () => route(WORKER_CUSTODY_CHECK_PATH, "POST", "application/json", async () => ({}));
    expect(await route(WORKER_CUSTODY_PATH, "GET", undefined, async () => ({}))).toEqual({ status: 200, body: { state: "held" } });
    expect(await check()).toMatchObject({ status: 409, body: { state: "held" } });
    expect((await route(WORKER_CUSTODY_PATH, "GET", undefined, async () => ({})))!.body).toEqual({ state: "held" });

    process.kill(-worker.pid!, "SIGKILL");
    for (let i = 0; i < 100; i++) { try { process.kill(-worker.pid!, 0); } catch { break; } await new Promise(r => setTimeout(r, 20)); }
    expect(await check()).toEqual({ status: 200, body: { state: "clear" } });
    expect(await route(WORKER_CUSTODY_CHECK_PATH, "POST", "text/plain", async () => ({}))).toMatchObject({ status: 415 });
  });
});
