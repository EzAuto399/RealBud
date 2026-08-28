import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PortalCapability } from "../shared/contracts.ts";
import {
  admitBrokeredFakePortalPrefill,
  executeAdmittedFakePortalPrefill,
  reconcileBrokeredFakePortalPrefill,
  runBrokeredFakePortalPrefill,
  type BrokeredFakePortalPrefillInput,
} from "./portal-work-broker.ts";
import { computerLease } from "./computer-lease.ts";
import { WorkBroker, workDigest } from "./work-broker.ts";
import { startFakePortal, type FakePortal } from "./testing/fake-portal.ts";

describe("brokered fake portal recipe", () => {
  let dir: string;
  let file: string;
  let now: number;
  let nextReceipt: number;
  const portals: FakePortal[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "realbud-portal-broker-"));
    file = join(dir, "work-broker.json");
    now = 1_800_000_000_000;
    nextReceipt = 0;
  });

  afterEach(async () => {
    computerLease.release("ask");
    computerLease.release("setup");
    computerLease.release("portal");
    vi.restoreAllMocks();
    await Promise.all(portals.splice(0).map((portal) => portal.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  function broker(): WorkBroker {
    return new WorkBroker({
      file,
      now: () => now,
      idFactory: () => `portal-receipt-${++nextReceipt}`,
    });
  }

  function capability(id: string, overrides: Partial<PortalCapability> = {}): PortalCapability {
    return {
      id: `cap-${id}`,
      workItemId: `work-${id}`,
      revision: 7,
      proposalHash: `ph-${id}`,
      propertyId: "prop-oak",
      recipeId: "fake-building-portal",
      recipeVersion: 1,
      operation: "prefill-courtesy",
      approver: "pm",
      expiresAt: now + 30 * 60_000,
      ...overrides,
    };
  }

  function input(activeBroker: WorkBroker, portal: FakePortal, id: string): BrokeredFakePortalPrefillInput {
    return {
      broker: activeBroker,
      baseUrl: portal.url,
      body: `Hi Sam, this is the approved courtesy wording for ${id}.`,
      capability: capability(id),
      now: () => now,
    };
  }

  async function portal(): Promise<FakePortal> {
    const active = await startFakePortal();
    portals.push(active);
    return active;
  }

  it("admits and executes one exact typed fixture recipe without exposing Submit or private inputs", async () => {
    const fixture = await portal();
    const activeBroker = broker();
    const work = input(activeBroker, fixture, "success");
    const result = await runBrokeredFakePortalPrefill(work);

    expect(result).toMatchObject({
      executed: true,
      receipt: {
        route: "scripted-browser",
        effectClass: "possible-external",
        state: "evidence-ready",
        allowedOrigins: [fixture.url],
        recipe: { id: "fake-building-portal", version: 1 },
        attempts: 1,
        plan: {
          authorityKind: "allow-decision",
          dataClasses: ["portal-form-fields"],
          routes: [{ route: "scripted-browser", adapter: { adapterId: "fixture-portal-browser", effect: "prepare-only" } }],
        },
      },
    });
    expect(result.receipt.effectBoundaryAt).toBeTypeOf("number");
    expect(result.receipt.outputDigest).toBe(result.outputDigest);
    expect(fixture.prefillCount()).toBe(1);
    expect(fixture.submitCount()).toBe(0);
    expect(fixture.state.revoked).toBe(true);
    expect(fixture.log.map(({ path }) => path)).toEqual(["/ledger", "/prefill", "/revoke"]);

    const disk = readFileSync(file, "utf8");
    expect(disk).toContain(fixture.url);
    expect(disk).not.toContain(work.body);
    expect(disk).not.toContain(work.capability.id);
    expect(disk).not.toContain(work.capability.workItemId);
    expect(disk).not.toContain(work.capability.proposalHash);
    expect(disk).not.toContain(work.capability.propertyId);
    expect(disk).not.toContain("submit-reminder");

    const reconciled = reconcileBrokeredFakePortalPrefill({ broker: activeBroker, receiptId: result.receipt.id });
    expect(reconciled.state).toBe("reconciled");
    const retry = await runBrokeredFakePortalPrefill(work);
    expect(retry).toMatchObject({ executed: false, receipt: { id: result.receipt.id, state: "reconciled" } });
    expect(activeBroker.list()).toHaveLength(1);
    expect(fixture.prefillCount()).toBe(1);
    expect(fixture.submitCount()).toBe(0);
  });

  it("rejects off-origin, credential-bearing and mismatched recipe authority before admission", async () => {
    const activeBroker = broker();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const base = {
      broker: activeBroker,
      body: "Approved courtesy wording.",
      capability: capability("invalid"),
      now: () => now,
    };

    expect(() => admitBrokeredFakePortalPrefill({ ...base, baseUrl: "http://localhost:41234" })).toThrow(/loopback origin/i);
    expect(() => admitBrokeredFakePortalPrefill({ ...base, baseUrl: "http://user:secret@127.0.0.1:41234" })).toThrow(/credential-free/i);
    expect(() => admitBrokeredFakePortalPrefill({
      ...base,
      baseUrl: "http://127.0.0.1:41234",
      capability: capability("wrong-recipe", { recipeVersion: 2 }),
    })).toThrow(/fixture recipe/i);
    expect(() => admitBrokeredFakePortalPrefill({
      ...base,
      baseUrl: "http://127.0.0.1:41234/path",
    })).toThrow(/loopback origin/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(activeBroker.list()).toEqual([]);
  });

  it("binds one capability id to its exact admitted wording", async () => {
    const fixture = await portal();
    const activeBroker = broker();
    const work = input(activeBroker, fixture, "idempotent");
    const admission = admitBrokeredFakePortalPrefill(work);

    expect(() => admitBrokeredFakePortalPrefill({
      ...work,
      body: "Different wording must not reuse the same capability.",
    })).toThrow(/different work/i);
    expect(activeBroker.list()).toEqual([admission.receipt]);
    expect(fixture.log).toEqual([]);
  });

  it("releases a blocked computer lane as a retryable preflight without portal I/O", async () => {
    const fixture = await portal();
    const activeBroker = broker();
    const work = input(activeBroker, fixture, "busy-lane");
    computerLease.hold("ask", now, 60_000, "ask-turn");

    await expect(runBrokeredFakePortalPrefill(work)).rejects.toMatchObject({
      code: "portal-work-retryable",
    });
    expect(activeBroker.list()[0]).toMatchObject({ state: "queued", attempts: 1 });
    expect(activeBroker.list()[0]?.effectBoundaryAt).toBeUndefined();
    expect(fixture.log).toEqual([]);
    expect(fixture.prefillCount()).toBe(0);
    expect(fixture.submitCount()).toBe(0);
  });

  it("persists an ambiguous prefill as effect unknown and never replays it after restart", async () => {
    const fixture = await portal();
    const activeBroker = broker();
    const work = input(activeBroker, fixture, "ambiguous");
    const actualFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = typeof request === "string" || request instanceof URL ? String(request) : request.url;
      if (new URL(url).pathname !== "/prefill") return actualFetch(request, init);
      const applied = await actualFetch(request, init);
      expect(applied.status).toBe(200);
      return new Response(JSON.stringify({ error: "fixture acknowledgement lost" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(runBrokeredFakePortalPrefill(work)).rejects.toMatchObject({ code: "portal-effect-unknown" });
    const receipt = activeBroker.list()[0]!;
    expect(receipt).toMatchObject({
      state: "effect-unknown",
      attempts: 1,
      errorCode: "external-effect-ambiguous",
    });
    expect(receipt.effectBoundaryAt).toBeTypeOf("number");
    expect(fixture.prefillCount()).toBe(1);
    expect(fixture.submitCount()).toBe(0);

    vi.restoreAllMocks();
    const reopened = broker();
    const requestsBefore = fixture.log.length;
    await expect(runBrokeredFakePortalPrefill({ ...work, broker: reopened })).rejects.toMatchObject({
      code: "portal-effect-unknown",
    });
    expect(fixture.log).toHaveLength(requestsBefore);
    expect(fixture.prefillCount()).toBe(1);
    expect(reopened.list()).toHaveLength(1);
  });

  it("honours cancellation, expiry and fencing before any fixture mutation", async () => {
    const fixture = await portal();
    const activeBroker = broker();

    const cancelledWork = input(activeBroker, fixture, "cancelled");
    const cancelledAdmission = admitBrokeredFakePortalPrefill(cancelledWork);
    activeBroker.cancel(cancelledAdmission.receipt.id, cancelledAdmission.receipt.cancellationGeneration);
    await expect(executeAdmittedFakePortalPrefill({
      ...cancelledWork,
      receiptId: cancelledAdmission.receipt.id,
    })).rejects.toMatchObject({ code: "work-cancelled" });

    const expiringWork = {
      ...input(activeBroker, fixture, "expired"),
      capability: capability("expired", { expiresAt: now + 100 }),
    };
    const expiringAdmission = admitBrokeredFakePortalPrefill(expiringWork);
    now += 101;
    await expect(executeAdmittedFakePortalPrefill({
      ...expiringWork,
      receiptId: expiringAdmission.receipt.id,
    })).rejects.toMatchObject({ code: "work-expired" });

    now += 1;
    const fencedWork = input(activeBroker, fixture, "fenced");
    const fencedAdmission = admitBrokeredFakePortalPrefill(fencedWork);
    const staleClaim = activeBroker.leaseNext({
      runnerId: "stale-fixture-runner",
      routes: ["scripted-browser"],
      requestIds: [fencedAdmission.receipt.requestId],
    })!;
    activeBroker.start(staleClaim);
    activeBroker.cancel(fencedAdmission.receipt.id, staleClaim.cancellationGeneration);
    expect(() => activeBroker.complete(staleClaim, workDigest("late-output"))).toThrow(/stale/i);
    await expect(executeAdmittedFakePortalPrefill({
      ...fencedWork,
      receiptId: fencedAdmission.receipt.id,
    })).rejects.toMatchObject({ code: "work-cancelled" });

    expect(fixture.log).toEqual([]);
    expect(fixture.prefillCount()).toBe(0);
    expect(fixture.submitCount()).toBe(0);
  });

  it("bounds read-only preflight retries without crossing the effect boundary", async () => {
    const fixture = await portal();
    const activeBroker = broker();
    const work = input(activeBroker, fixture, "retry-limit");
    const actualFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = typeof request === "string" || request instanceof URL ? String(request) : request.url;
      if (new URL(url).pathname === "/ledger") {
        return new Response(JSON.stringify({ error: "temporary fixture read failure" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return actualFetch(request, init);
    });

    await expect(runBrokeredFakePortalPrefill(work)).rejects.toMatchObject({ code: "portal-work-retryable" });
    await expect(runBrokeredFakePortalPrefill(work)).rejects.toMatchObject({ code: "portal-work-retryable" });
    await expect(runBrokeredFakePortalPrefill(work)).rejects.toMatchObject({ code: "work-failed" });
    const receipt = activeBroker.list()[0]!;
    expect(receipt).toMatchObject({ state: "failed", attempts: 3, errorCode: "portal-step-failed" });
    expect(receipt.effectBoundaryAt).toBeUndefined();
    const requests = fixture.log.length;
    await expect(runBrokeredFakePortalPrefill(work)).rejects.toMatchObject({ code: "work-failed" });
    expect(fixture.log).toHaveLength(requests);
    expect(fixture.prefillCount()).toBe(0);
    expect(fixture.submitCount()).toBe(0);
  });
});
