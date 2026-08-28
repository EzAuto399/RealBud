import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecutionAdapterTransport } from "../shared/contracts.ts";
import { AtomicWriteError } from "./atomic.ts";
import {
  createExecutionAdapterBinding,
  defineExecutionAdapterManifest,
  type ExecutionAdapterAttestation,
  type ExecutionAdapterEffect,
  type ExecutionAdapterOperation,
} from "./execution-adapters.ts";
import {
  WorkBroker,
  workDigest,
} from "./work-broker.ts";
import { buildWorkPlan, type WorkEffectClass, type WorkPlan } from "./work-plan.ts";

describe("durable fake work broker", () => {
  let dir: string;
  let file: string;
  let now: number;
  let nextId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "realbud-work-broker-"));
    file = join(dir, "broker.json");
    now = 1_800_000_000_000;
    nextId = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeBroker(overrides: ConstructorParameters<typeof WorkBroker>[0] = {}): WorkBroker {
    return new WorkBroker({
      file,
      now: () => now,
      idFactory: () => `receipt-${++nextId}`,
      ...overrides,
    });
  }

  function request(requestId: string, overrides: {
    route?: WorkPlan["routes"][number]["route"];
    concurrencyKey?: string;
    allowedOrigins?: string[];
    effectClass?: WorkEffectClass;
    expiresAt?: number;
  } = {}): WorkPlan {
    const route = overrides.route ?? "local-analysis";
    const effectClass = overrides.effectClass ?? "read-only";
    const expiresAt = overrides.expiresAt ?? now + 60_000;
    const operation: ExecutionAdapterOperation = effectClass === "possible-external"
      ? "prepare-approved-fields"
      : route === "local-analysis" || route === "remote-analysis"
        ? "analyse-selected-files"
        : "browse-approved-origin";
    const effect: ExecutionAdapterEffect = effectClass === "possible-external" ? "prepare-only" : "read-only";
    const transport: ExecutionAdapterTransport = route === "local-analysis"
      ? "isolated-task"
      : route === "remote-analysis" || route === "remote-browser"
        ? "remote-lane"
        : route === "desktop-cua"
          ? "bounded-cua"
          : "private-browser";
    const manifest = defineExecutionAdapterManifest({
      kind: "realbud.execution-adapter.v1",
      schemaVersion: 1,
      id: `test-${route}-${effect}`,
      version: 1,
      label: `Test ${route}`,
      method: "Test adapter",
      transport,
      route,
      operations: [operation],
      effect,
      requiresNamedAccount: transport !== "isolated-task",
      requiresExplicitOptIn: transport !== "isolated-task",
      runtimeAvailable: true,
      maxConcurrency: 1,
    });
    const attestation: ExecutionAdapterAttestation = {
      kind: "realbud.execution-adapter-attestation.v1",
      schemaVersion: 1,
      adapterId: manifest.id,
      adapterVersion: manifest.version,
      configurationGeneration: 1,
      state: "ready",
      observedAt: now,
      expiresAt,
      policyDigest: workDigest(`policy:${route}:${effect}`),
      ...(manifest.requiresNamedAccount ? { accountIdentityDigest: workDigest(`account:${overrides.concurrencyKey ?? requestId}`) } : {}),
      ...(manifest.requiresExplicitOptIn ? { explicitOptIn: true } : {}),
      ...(transport === "remote-lane" ? {
        remotePolicy: {
          region: "au-southeast-1",
          retentionHours: 1,
          deletionSupported: true as const,
          encryptionAtRest: true as const,
          encryptionInTransit: true as const,
          spendCeilingCents: 100,
          localFallback: true as const,
        },
      } : {}),
    };
    const adapter = createExecutionAdapterBinding({ manifest, attestation, operation, now });
    const inputDigest = workDigest(`input:${requestId}`);
    const browser = route === "scripted-browser" || route === "isolated-browser" || route === "remote-browser" || route === "desktop-cua";
    return buildWorkPlan({
      requestId,
      createdAt: now,
      expiresAt,
      bookRevision: 7,
      caseRevision: 3,
      inputDigests: [inputDigest],
      dataClasses: route === "local-analysis" || route === "remote-analysis"
        ? ["selected-files"]
        : effectClass === "possible-external"
          ? ["portal-form-fields"]
          : route === "scripted-browser" || route === "isolated-browser" || route === "remote-browser"
            ? ["bank-credit-metadata"]
            : ["calendar-metadata"],
      routes: [{ route, adapter }],
      concurrencyKey: overrides.concurrencyKey ?? `case:${requestId}`,
      ...(browser ? { allowedOrigins: overrides.allowedOrigins ?? ["https://portal.example.test"] } : {}),
      recipe: { id: "fixture-analysis", version: 1 },
      effectClass,
      authority: effectClass === "possible-external" || route === "remote-analysis" || route === "remote-browser"
        ? { kind: "allow-decision", actionId: requestId, actionRevision: 7, actionDigest: inputDigest }
        : { kind: "user-request", requestId, requestDigest: inputDigest },
    });
  }

  it("admits an idempotent request once and persists metadata without raw serialization or runner secrets", () => {
    const broker = makeBroker();
    const rawKey = "pms-session-cookie-secret";
    const first = broker.admit(request("request-one", {
      concurrencyKey: rawKey,
    }));
    const duplicate = broker.admit(request("request-one", {
      concurrencyKey: rawKey,
    }));

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.receipt.id).toBe(first.receipt.id);
    expect(broker.list()).toHaveLength(1);

    const claim = broker.leaseNext({ runnerId: "runner-private-identity", routes: ["local-analysis"] });
    expect(claim).not.toBeNull();
    const body = readFileSync(file, "utf8");
    expect(body).not.toContain(rawKey);
    expect(body).not.toContain("runner-private-identity");
    expect(body).not.toContain("cookie-secret");
    expect(body).toContain(workDigest(rawKey));
  });

  it("rejects idempotency conflicts and rolls back an invalid batch atomically", () => {
    const broker = makeBroker({ maxQueued: 3 });
    expect(() => broker.admitBatch([
      request("same-request"),
      request("same-request", { route: "desktop-cua" }),
    ])).toThrow(/different work/i);
    expect(broker.list()).toEqual([]);

    expect(() => broker.admitBatch([
      request("one"),
      request("two"),
      request("three"),
      request("four"),
    ])).toThrow(/batch is invalid|queue is full/i);
    expect(broker.list()).toEqual([]);
  });

  it("enforces two isolated browsers, one desktop and one active lane for the same account", () => {
    const broker = makeBroker();
    broker.admitBatch([
      request("browser-a-1", { route: "isolated-browser", concurrencyKey: "account-a" }),
      request("browser-a-2", { route: "isolated-browser", concurrencyKey: "account-a" }),
      request("browser-b", { route: "isolated-browser", concurrencyKey: "account-b" }),
      request("browser-c", { route: "isolated-browser", concurrencyKey: "account-c" }),
      request("cua-1", { route: "desktop-cua", concurrencyKey: "desktop" }),
      request("cua-2", { route: "desktop-cua", concurrencyKey: "desktop-2" }),
    ]);

    const browserOne = broker.leaseNext({ runnerId: "browser-1", routes: ["isolated-browser"] });
    const browserTwo = broker.leaseNext({ runnerId: "browser-2", routes: ["isolated-browser"] });
    const browserThree = broker.leaseNext({ runnerId: "browser-3", routes: ["isolated-browser"] });
    expect(browserOne?.receipt.requestId).toBe("browser-a-1");
    expect(browserTwo?.receipt.requestId).toBe("browser-b");
    expect(browserThree).toBeNull();

    const cuaOne = broker.leaseNext({ runnerId: "desktop-1", routes: ["desktop-cua"] });
    const cuaTwo = broker.leaseNext({ runnerId: "desktop-2", routes: ["desktop-cua"] });
    expect(cuaOne?.receipt.requestId).toBe("cua-1");
    expect(cuaTwo).toBeNull();
  });

  it("bounds retries and never leases a failed receipt again", () => {
    const broker = makeBroker({ maxAttempts: 2 });
    broker.admit(request("retry"));

    const first = broker.leaseNext({ runnerId: "analysis-1", routes: ["local-analysis"] })!;
    broker.start(first);
    expect(broker.fail(first, { code: "temporary", retryable: true }).state).toBe("queued");

    const second = broker.leaseNext({ runnerId: "analysis-1", routes: ["local-analysis"] })!;
    broker.start(second);
    expect(broker.fail(second, { code: "temporary", retryable: true })).toMatchObject({
      state: "failed",
      attempts: 2,
    });
    expect(broker.leaseNext({ runnerId: "analysis-1", routes: ["local-analysis"] })).toBeNull();
  });

  it("uses only a forward disclosed cloud-to-local fallback and invalidates the old fence", () => {
    const broker = makeBroker();
    const remote = request("cloud-fallback", { route: "remote-analysis" });
    const local = request("local-binding", { route: "local-analysis" });
    const plan = buildWorkPlan({
      requestId: remote.requestId,
      createdAt: now,
      expiresAt: remote.expiresAt,
      bookRevision: remote.bookRevision,
      caseRevision: remote.caseRevision,
      inputDigests: remote.inputDigests,
      dataClasses: remote.dataClasses,
      routes: [remote.routes[0]!, local.routes[0]!],
      concurrencyKey: "case:cloud-fallback",
      allowedOrigins: remote.allowedOrigins,
      recipe: remote.recipe,
      effectClass: remote.effectClass,
      authority: remote.authority,
    });
    const admitted = broker.admit(plan);
    const cloudClaim = broker.leaseNext({ runnerId: "cloud-1", routes: ["remote-analysis"] })!;
    broker.start(cloudClaim);
    expect(broker.fail(cloudClaim, { code: "provider-unavailable", retryable: true }).state).toBe("queued");

    const queued = broker.get(admitted.receipt.id)!;
    const fallback = broker.fallback(admitted.receipt.id, "local-analysis", queued.fencingToken);
    expect(fallback).toMatchObject({ route: "local-analysis", state: "queued", errorCode: "route-fallback" });
    expect(fallback.fencingToken).toBeGreaterThan(cloudClaim.fencingToken);
    expect(() => broker.start(cloudClaim)).toThrow(/stale/i);
    expect(() => broker.fallback(fallback.id, "local-analysis", queued.fencingToken)).toThrow(/stale/i);
    expect(() => broker.fallback(fallback.id, "remote-analysis", fallback.fencingToken)).toThrow(/later disclosed fallback/i);
    expect(() => broker.fallback(fallback.id, "desktop-cua", fallback.fencingToken)).toThrow(/not a later disclosed fallback/i);
    expect(broker.leaseNext({ runnerId: "local-1", routes: ["local-analysis"] })?.receipt.route).toBe("local-analysis");
  });

  it("refuses to reroute an expired queued receipt", () => {
    const broker = makeBroker();
    const admitted = broker.admit(request("expired-fallback", { expiresAt: now + 1_000 }));
    now += 1_001;

    expect(() => broker.fallback(
      admitted.receipt.id,
      "local-analysis",
      admitted.receipt.fencingToken,
    )).toThrow(/expired/i);
    expect(broker.get(admitted.receipt.id)).toMatchObject({ state: "expired" });
  });

  it("invalidates a leased claim on cancellation and refuses stale completion", () => {
    const broker = makeBroker();
    const admitted = broker.admit(request("cancel"));
    const claim = broker.leaseNext({ runnerId: "analysis-1", routes: ["local-analysis"] })!;
    broker.start(claim);
    const cancelled = broker.cancel(admitted.receipt.id, claim.cancellationGeneration);
    expect(cancelled).toMatchObject({ state: "cancelled", cancellationGeneration: 1 });
    expect(() => broker.complete(claim, workDigest("late-output"))).toThrow(/stale/i);
  });

  it("preserves admitted queued work across restart without creating another receipt", () => {
    const broker = makeBroker();
    const admitted = broker.admit(request("crash-after-admission"));

    const reopened = makeBroker();
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.get(admitted.receipt.id)).toMatchObject({ state: "queued", attempts: 0, fencingToken: 0 });
    expect(reopened.admit(request("crash-after-admission"))).toMatchObject({
      duplicate: true,
      receipt: { id: admitted.receipt.id },
    });
  });

  it("loads a legacy v1 receipt without a plan binding while all new receipts carry one", () => {
    const broker = makeBroker();
    const admitted = broker.admit(request("legacy-readable"));
    expect(admitted.receipt.plan).toMatchObject({ kind: "realbud.work-plan-binding.v1" });

    const parsed = JSON.parse(readFileSync(file, "utf8")) as { receipts: Array<Record<string, unknown>> };
    const receipt = parsed.receipts[0]!;
    delete receipt.plan;
    receipt.requestDigest = workDigest(JSON.stringify({
      bookRevision: receipt.bookRevision,
      caseRevision: receipt.caseRevision,
      inputDigests: receipt.inputDigests,
      route: receipt.route,
      concurrencyKeyDigest: receipt.concurrencyKeyDigest,
      allowedOrigins: receipt.allowedOrigins,
      recipe: receipt.recipe,
      effectClass: receipt.effectClass,
      expiresAt: receipt.expiresAt,
    }));
    writeFileSync(file, JSON.stringify(parsed));

    const reopened = makeBroker();
    expect(reopened.get(admitted.receipt.id)).toMatchObject({ state: "queued" });
    expect(reopened.get(admitted.receipt.id)?.plan).toBeUndefined();
  });

  it("requeues a crash after lease but before start and invalidates the abandoned fence", () => {
    const broker = makeBroker();
    broker.admit(request("crash-after-lease"));
    const claim = broker.leaseNext({ runnerId: "analysis-1", routes: ["local-analysis"] })!;

    const reopened = makeBroker();
    expect(reopened.get(claim.receipt.id)).toMatchObject({
      state: "queued",
      attempts: 1,
      fencingToken: claim.fencingToken + 1,
    });
    expect(() => reopened.start(claim)).toThrow(/stale/i);
  });

  it("requeues interrupted read-only work with a new fence after restart", () => {
    const broker = makeBroker();
    broker.admit(request("crash-read"));
    const claim = broker.leaseNext({ runnerId: "analysis-1", routes: ["local-analysis"] })!;
    broker.start(claim);

    const reopened = makeBroker();
    expect(reopened.get(claim.receipt.id)).toMatchObject({
      state: "queued",
      attempts: 1,
      fencingToken: claim.fencingToken + 1,
    });
    expect(reopened.get(claim.receipt.id)?.leaseOwnerDigest).toBeUndefined();
  });

  it("preserves evidence-ready work across restart and reconciles it without replay", () => {
    const broker = makeBroker();
    broker.admit(request("ready"));
    const claim = broker.leaseNext({ runnerId: "analysis-1", routes: ["local-analysis"] })!;
    broker.start(claim);
    const output = workDigest("bounded-output");
    const ready = broker.complete(claim, output);

    const reopened = makeBroker();
    expect(reopened.get(ready.id)).toMatchObject({ state: "evidence-ready", attempts: 1, outputDigest: output });
    expect(reopened.leaseNext({ runnerId: "analysis-2", routes: ["local-analysis"] })).toBeNull();
    expect(reopened.reconcile(ready.id, output).state).toBe("reconciled");
  });

  it("turns an interrupted possible effect into effect-unknown and never replays it", () => {
    const broker = makeBroker();
    broker.admit(request("ambiguous", {
      route: "desktop-cua",
      concurrencyKey: "desktop",
      effectClass: "possible-external",
    }));
    const claim = broker.leaseNext({ runnerId: "desktop-1", routes: ["desktop-cua"] })!;
    broker.start(claim);
    broker.markEffectBoundary(claim);

    const reopened = makeBroker();
    expect(reopened.get(claim.receipt.id)).toMatchObject({
      state: "effect-unknown",
      errorCode: "external-effect-ambiguous",
    });
    expect(reopened.leaseNext({ runnerId: "desktop-1", routes: ["desktop-cua"] })).toBeNull();
  });

  it("expires queued and leased work without execution", () => {
    const broker = makeBroker();
    const queued = broker.admit(request("queued-expiry", { expiresAt: now + 1_000 }));
    const leased = broker.admit(request("lease-expiry", { expiresAt: now + 1_000 }));
    broker.leaseNext({ runnerId: "analysis-1", routes: ["local-analysis"], leaseMs: 500 });
    now += 1_001;
    broker.sweepExpired();
    expect(broker.get(queued.receipt.id)?.state).toBe("expired");
    expect(broker.get(leased.receipt.id)?.state).toBe("expired");
  });

  it("rolls back a proven not-landed write and blocks after an uncertain write", () => {
    const notLanded = makeBroker({
      writer: () => { throw new AtomicWriteError("not-landed"); },
    });
    expect(() => notLanded.admit(request("not-landed"))).toThrow(/did not land/i);
    expect(notLanded.list()).toEqual([]);
    expect(notLanded.storageStatus()).toBe("ok");

    const uncertain = makeBroker({
      file: join(dir, "uncertain.json"),
      writer: () => { throw new AtomicWriteError("landed-uncertain"); },
    });
    expect(() => uncertain.admit(request("uncertain"))).toThrow(/uncertain/i);
    expect(uncertain.storageStatus()).toBe("uncertain");
    expect(() => uncertain.admit(request("blocked"))).toThrow(/restart and reconcile/i);
  });

  it("fails closed on corrupt or duplicate durable authority", () => {
    writeFileSync(file, "{not json");
    expect(() => makeBroker()).toThrow(/needs recovery/i);

    writeFileSync(file, JSON.stringify({
      kind: "realbud.work-broker.v1",
      schemaVersion: 1,
      receipts: [{ kind: "realbud.work-receipt.v1", schemaVersion: 1 }],
    }));
    expect(() => makeBroker()).toThrow();
  });

  it("fails closed when durable routing metadata no longer matches its authority digest", () => {
    const broker = makeBroker();
    broker.admit(request("tamper-check"));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { receipts: Array<{ route: string }> };
    parsed.receipts[0]!.route = "desktop-cua";
    writeFileSync(file, JSON.stringify(parsed));

    expect(() => makeBroker()).toThrow(/route does not match its plan|authority digest does not match/i);
  });
});
