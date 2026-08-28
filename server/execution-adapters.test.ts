import { describe, expect, it } from "vitest";

import {
  BUILT_IN_EXECUTION_ADAPTERS,
  ExecutionAdapterRegistry,
  readExecutionAdapterBinding,
  defineExecutionAdapterManifest,
  type ExecutionAdapterAttestation,
  type ExecutionAdapterManifest,
} from "./execution-adapters.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function adapter(overrides: Partial<ExecutionAdapterManifest> = {}): ExecutionAdapterManifest {
  return defineExecutionAdapterManifest({
    kind: "realbud.execution-adapter.v1",
    schemaVersion: 1,
    id: "test-analysis",
    version: 1,
    label: "Test analysis",
    method: "Isolated task workspace",
    transport: "isolated-task",
    route: "local-analysis",
    operations: ["analyse-selected-files"],
    effect: "read-only",
    requiresNamedAccount: false,
    requiresExplicitOptIn: false,
    runtimeAvailable: true,
    maxConcurrency: 2,
    ...overrides,
  });
}

function attestation(overrides: Partial<ExecutionAdapterAttestation> = {}): ExecutionAdapterAttestation {
  return {
    kind: "realbud.execution-adapter-attestation.v1",
    schemaVersion: 1,
    adapterId: "test-analysis",
    adapterVersion: 1,
    configurationGeneration: 1,
    state: "ready",
    observedAt: 10_000,
    expiresAt: 20_000,
    policyDigest: DIGEST_A,
    ...overrides,
  };
}

describe("execution adapter policy", () => {
  it("keeps the built-in catalog code-owned, bounded and non-executable at boot", () => {
    const registry = new ExecutionAdapterRegistry(BUILT_IN_EXECUTION_ADAPTERS, { now: () => 12_000 });
    const snapshot = registry.snapshot();
    expect(snapshot).toHaveLength(9);
    expect(snapshot.filter((item) => item.state === "foundation")).toHaveLength(8);
    expect(snapshot.find((item) => item.id === "computer-history-recovery")).toMatchObject({
      state: "runtime-unavailable",
      route: null,
      maxConcurrency: 0,
    });
    expect(snapshot.every((item) => (
      item.boundaries.manualAllow
      && item.boundaries.humanSubmit
      && item.boundaries.rawToolsExposed === false
      && item.boundaries.ambientCredentials === false
      && item.boundaries.personalBrowserAccess === false
      && item.boundaries.personalHermesAccess === false
      && item.boundaries.localFallback
    ))).toBe(true);
    expect(registry.workRoutingCapabilities()).toEqual({
      localAnalysis: false,
      scriptedBrowser: false,
      isolatedBrowserPool: false,
      desktopCua: false,
      cloudAnalysis: false,
      cloudBrowser: false,
      cloudMaxConcurrency: 0,
    });
  });

  it("rejects unknown, send-like and transport-mismatched operations", () => {
    expect(() => adapter({ operations: ["send-email" as never] })).toThrow(/operation is not supported/i);
    expect(() => adapter({ operations: ["read-bank-credits"] })).toThrow(/does not match its transport/i);
    expect(() => adapter({
      transport: "direct-api",
      route: "structured-batch",
      operations: ["read-structured-records"],
      effect: "prepare-only",
      maxConcurrency: 1,
    })).toThrow(/must expose only the approved preparation operation|cannot prepare/i);
  });

  it("rejects raw extra manifest fields and concurrency above the route ceiling", () => {
    expect(() => defineExecutionAdapterManifest({ ...adapter(), credential: "secret" })).toThrow(/unknown or missing fields/i);
    expect(() => adapter({ maxConcurrency: 3 })).toThrow(/concurrency is invalid/i);
    expect(() => adapter({ route: "remote-analysis" })).toThrow(/route does not match/i);
  });

  it("admits a fresh exact runtime receipt idempotently and expires it closed", () => {
    let now = 12_000;
    const registry = new ExecutionAdapterRegistry([adapter()], { now: () => now });
    expect(registry.attest(attestation())).toMatchObject({ duplicate: false, projection: { state: "ready" } });
    expect(registry.attest(attestation())).toMatchObject({ duplicate: true, projection: { state: "ready" } });
    expect(registry.workRoutingCapabilities().localAnalysis).toBe(true);

    now = 20_001;
    expect(registry.snapshot()[0]).toMatchObject({ state: "stale", status: "Check expired" });
    expect(registry.workRoutingCapabilities().localAnalysis).toBe(false);
  });

  it("issues an integrity-checked operation binding only from a fresh ready attestation", () => {
    const registry = new ExecutionAdapterRegistry([adapter()], { now: () => 12_000 });
    expect(() => registry.readyBinding("test-analysis", "analyse-selected-files")).toThrow(/no fresh ready runtime receipt/i);
    registry.attest(attestation());
    const binding = registry.readyBinding("test-analysis", "analyse-selected-files");
    expect(readExecutionAdapterBinding(structuredClone(binding))).toEqual(binding);
    expect(binding).toMatchObject({
      kind: "realbud.execution-adapter-binding.v1",
      adapterId: "test-analysis",
      configurationGeneration: 1,
      operation: "analyse-selected-files",
      effect: "read-only",
    });
    expect(() => registry.readyBinding("test-analysis", "read-bank-credits")).toThrow(/not admitted/i);
    expect(() => readExecutionAdapterBinding({ ...binding, policyDigest: DIGEST_C })).toThrow(/integrity/i);
  });

  it("binds one configuration generation and rejects stale or conflicting attestations", () => {
    const registry = new ExecutionAdapterRegistry([adapter()], { now: () => 12_000 });
    registry.attest(attestation());
    expect(() => registry.attest(attestation({ configurationGeneration: 0 }))).toThrow(/generation is stale/i);
    expect(() => registry.attest(attestation({ policyDigest: DIGEST_B }))).toThrow(/already bound/i);
    expect(registry.attest(attestation({
      configurationGeneration: 2,
      policyDigest: DIGEST_B,
    }))).toMatchObject({ duplicate: false, projection: { state: "ready" } });
  });

  it("requires named-account and explicit opt-in evidence before readiness", () => {
    const manifest = adapter({
      id: "named-analysis",
      requiresNamedAccount: true,
      requiresExplicitOptIn: true,
    });
    const registry = new ExecutionAdapterRegistry([manifest], { now: () => 12_000 });
    const base = attestation({ adapterId: "named-analysis" });
    expect(() => registry.attest(base)).toThrow(/account identity digest/i);
    expect(() => registry.attest({ ...base, accountIdentityDigest: DIGEST_B })).toThrow(/explicit opt-in/i);
    expect(registry.attest({
      ...base,
      accountIdentityDigest: DIGEST_B,
      explicitOptIn: true,
    })).toMatchObject({ projection: { state: "ready" } });
    expect(JSON.stringify(registry.snapshot())).not.toContain(DIGEST_B);
  });

  it("requires a complete cloud privacy, deletion, spend and local-fallback policy", () => {
    const manifest = adapter({
      id: "test-cloud",
      method: "Remote isolated analysis",
      transport: "remote-lane",
      route: "remote-analysis",
      requiresNamedAccount: true,
      requiresExplicitOptIn: true,
      maxConcurrency: 8,
    });
    const registry = new ExecutionAdapterRegistry([manifest], { now: () => 12_000 });
    const base = attestation({
      adapterId: "test-cloud",
      accountIdentityDigest: DIGEST_B,
      explicitOptIn: true,
    });
    expect(() => registry.attest(base)).toThrow(/cloud data policy/i);
    expect(() => registry.attest({
      ...base,
      remotePolicy: {
        region: "au-southeast-1",
        retentionHours: 24,
        deletionSupported: false as never,
        encryptionAtRest: true,
        encryptionInTransit: true,
        spendCeilingCents: 5_000,
        localFallback: true,
      },
    })).toThrow(/deletion, encryption and local fallback/i);
    expect(registry.attest({
      ...base,
      remotePolicy: {
        region: "au-southeast-1",
        retentionHours: 24,
        deletionSupported: true,
        encryptionAtRest: true,
        encryptionInTransit: true,
        spendCeilingCents: 5_000,
        localFallback: true,
      },
    })).toMatchObject({ projection: { state: "ready" } });
    expect(registry.workRoutingCapabilities()).toMatchObject({ cloudAnalysis: true, cloudMaxConcurrency: 8 });
  });

  it("revokes with a generation fence and immediately removes route readiness", () => {
    const registry = new ExecutionAdapterRegistry([adapter()], { now: () => 12_000 });
    registry.attest(attestation());
    expect(() => registry.revoke("test-analysis", 1, "user-disabled")).toThrow(/generation is stale/i);
    expect(registry.revoke("test-analysis", 2, "user-disabled")).toMatchObject({ state: "revoked" });
    expect(registry.workRoutingCapabilities().localAnalysis).toBe(false);
    expect(() => registry.attest(attestation({ configurationGeneration: 2, policyDigest: DIGEST_C }))).toThrow(/already bound/i);
    expect(registry.attest(attestation({ configurationGeneration: 3, policyDigest: DIGEST_C }))).toMatchObject({
      projection: { state: "ready" },
    });
  });

  it("keeps unavailable Computer History off even when code attempts to attest it", () => {
    const history = BUILT_IN_EXECUTION_ADAPTERS.find((item) => item.id === "computer-history-recovery")!;
    const registry = new ExecutionAdapterRegistry([history], { now: () => 12_000 });
    expect(() => registry.attest(attestation({
      adapterId: history.id,
      adapterVersion: history.version,
      explicitOptIn: true,
    }))).toThrow(/runtime is not available/i);
    expect(registry.snapshot()[0]).toMatchObject({ state: "runtime-unavailable" });
  });

  it("reports attention without turning a route on", () => {
    const registry = new ExecutionAdapterRegistry([adapter()], { now: () => 12_000 });
    expect(registry.attest(attestation({ state: "attention", reasonCode: "provider-revoked" }))).toMatchObject({
      projection: { state: "attention" },
    });
    expect(registry.workRoutingCapabilities().localAnalysis).toBe(false);
  });
});
