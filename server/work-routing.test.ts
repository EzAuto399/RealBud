import { describe, expect, it } from "vitest";

import type { WorkRoutingCapabilities, WorkRoutingInput } from "./work-routing.ts";
import { currentBookWorkRoutingPlan, planWorkRouting } from "./work-routing.ts";

const none: WorkRoutingCapabilities = {
  localAnalysis: false,
  scriptedBrowser: false,
  isolatedBrowserPool: false,
  desktopCua: false,
  cloudAnalysis: false,
  cloudBrowser: false,
  cloudMaxConcurrency: 0,
};

function plan(overrides: Partial<WorkRoutingInput> = {}) {
  return planWorkRouting({
    propertyCount: 100,
    capabilities: none,
    resources: { cpuCores: 8, freeMemoryMb: 8_192 },
    ...overrides,
  });
}

describe("local-first work routing", () => {
  it("processes a complete structured portfolio as one local batch without cloud", () => {
    const result = plan();
    expect(result).toMatchObject({
      kind: "realbud.work-routing.v1",
      schemaVersion: 1,
      selectedMode: "local-standard",
      propertyCount: 100,
      boundaries: {
        cloudRequired: false,
        workerOwnership: "external-pinned-runtime",
        browserOwnership: "realbud-only",
        personalBrowserAccess: false,
        personalHermesAccess: false,
      },
    });
    expect(result.lanes).toEqual([
      expect.objectContaining({ kind: "structured-batch", itemCount: 100, batchCount: 1, concurrency: 1, state: "ready" }),
    ]);
  });

  it("keeps every job for one PMS account on one browser lane", () => {
    const result = plan({
      requestedMode: "local-accelerated",
      browserWork: Array.from({ length: 14 }, () => ({ accountConcurrencyKey: "account-a" })),
      capabilities: { ...none, isolatedBrowserPool: true },
    });
    const browser = result.lanes.find((item) => item.kind === "isolated-browser");
    expect(result.selectedMode).toBe("local-standard");
    expect(browser).toMatchObject({ state: "ready", itemCount: 14, batchCount: 1, concurrency: 1 });
    expect(browser?.detail).toMatch(/share one account.*one isolated lane/i);
  });

  it("uses at most two isolated local browsers for independent accounts", () => {
    const result = plan({
      requestedMode: "auto",
      browserWork: [
        { accountConcurrencyKey: "account-a" },
        { accountConcurrencyKey: "account-b" },
        { accountConcurrencyKey: "account-c" },
      ],
      capabilities: { ...none, isolatedBrowserPool: true },
    });
    expect(result.selectedMode).toBe("local-accelerated");
    expect(result.lanes.find((item) => item.kind === "isolated-browser")).toMatchObject({
      state: "ready",
      itemCount: 3,
      batchCount: 3,
      concurrency: 2,
      isolation: "realbud-browser-profile",
    });
  });

  it("falls back before launch when local resources are insufficient", () => {
    const result = plan({
      requestedMode: "local-accelerated",
      browserWork: [
        { accountConcurrencyKey: "account-a" },
        { accountConcurrencyKey: "account-b" },
      ],
      capabilities: { ...none, isolatedBrowserPool: true },
      resources: { cpuCores: 2, freeMemoryMb: 2_048 },
    });
    expect(result.selectedMode).toBe("local-standard");
    expect(result.fallbackReasons.join(" ")).toMatch(/4 CPU cores.*4096 MB/i);
    expect(result.lanes.find((item) => item.kind === "isolated-browser")?.concurrency).toBe(1);
  });

  it("makes cloud optional and falls back locally without dropping work", () => {
    const result = plan({
      requestedMode: "cloud-accelerated",
      analysisItemCount: 12,
    });
    expect(result.selectedMode).toBe("local-standard");
    expect(result.requestedMode).toBe("cloud-accelerated");
    expect(result.preferenceConfigured).toBe(true);
    expect(result.preferenceRevision).toBe(0);
    expect(result.boundaries.cloudRequired).toBe(false);
    expect(result.fallbackReasons).toEqual(["Cloud acceleration is not connected and ready; all work remains local."]);
    expect(result.lanes.find((item) => item.kind === "local-analysis")).toMatchObject({
      state: "gated",
      itemCount: 12,
      concurrency: 0,
    });
  });

  it("uses stateless remote analysis only when the explicit cloud capability is ready", () => {
    const result = plan({
      requestedMode: "cloud-accelerated",
      analysisItemCount: 9,
      capabilities: { ...none, cloudAnalysis: true, cloudMaxConcurrency: 3 },
    });
    expect(result.selectedMode).toBe("cloud-accelerated");
    expect(result.lanes.find((item) => item.kind === "remote-analysis")).toMatchObject({
      state: "ready",
      itemCount: 9,
      concurrency: 3,
      isolation: "remote-isolated",
    });
  });

  it("never runs visible desktop jobs concurrently", () => {
    const result = plan({
      requestedMode: "cloud-accelerated",
      desktopCuaJobs: 8,
      capabilities: { ...none, desktopCua: true, cloudAnalysis: true, cloudMaxConcurrency: 8 },
    });
    expect(result.lanes.find((item) => item.kind === "desktop-cua")).toMatchObject({
      state: "ready",
      itemCount: 8,
      concurrency: 1,
      isolation: "visible-desktop",
    });
  });

  it("shows a duration only when every selected route has measured bounds", () => {
    const unmeasured = plan();
    expect(unmeasured.estimate).toMatchObject({ basis: "unavailable", minimumSeconds: null, maximumSeconds: null });

    const measured = plan({
      benchmarks: {
        structuredBatch: { fixedSeconds: 2, minimumSecondsPerItem: 0.02, maximumSecondsPerItem: 0.04 },
      },
    });
    expect(measured.estimate).toMatchObject({ basis: "measured", minimumSeconds: 4, maximumSeconds: 6 });
  });

  it("rejects malformed workload shapes and opaque keys", () => {
    expect(() => plan({ propertyCount: -1 })).toThrow(/propertyCount/);
    expect(() => plan({ propertyCount: 10_001 })).toThrow(/propertyCount/);
    expect(() => plan({ browserWork: [{ accountConcurrencyKey: "cookie\nsecret" }] })).toThrow(/accountConcurrencyKey/);
    expect(() => plan({ capabilities: { ...none, cloudMaxConcurrency: 33 } })).toThrow(/cloudMaxConcurrency/);
  });

  it("projects only current admitted capability and leaks no personal path or account key", () => {
    const result = currentBookWorkRoutingPlan(
      { properties: Array.from({ length: 6 }, (_, index) => ({ id: `p${index}` })) as never[] },
      { cpuCores: 16, freeMemoryMb: 32_768 },
    );
    expect(result.selectedMode).toBe("local-standard");
    expect(result.preferenceConfigured).toBe(false);
    expect(result.preferenceRevision).toBe(0);
    expect(result.lanes[0]).toMatchObject({ kind: "structured-batch", itemCount: 6, batchCount: 1 });
    expect(JSON.stringify(result)).not.toMatch(/\.hermes|cookie|credential|\/Users\/|account-a/i);
  });
});
