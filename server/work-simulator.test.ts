import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planWorkRouting } from "./work-routing.ts";
import { WorkBroker, workDigest } from "./work-broker.ts";
import {
  partitionSimulationItems,
  runWorkSimulation,
  simulatedWorkPlan,
  type SimulatedWorkItem,
  type SimulatedWorkJob,
} from "./work-simulator.ts";

describe("offline execution topology simulation", () => {
  let dir: string;
  let now: number;
  let nextId: number;
  let durableBodies: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "realbud-work-simulation-"));
    now = 1_800_000_000_000;
    nextId = 0;
    durableBodies = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function broker(): WorkBroker {
    return new WorkBroker({
      file: join(dir, "broker.json"),
      now: () => now,
      idFactory: () => `sim-receipt-${++nextId}`,
      writer: (_path, body) => durableBodies.push(body),
    });
  }

  function items(count: number, prefix: string, disposition: SimulatedWorkItem["disposition"] = "evidence"): SimulatedWorkItem[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-${index + 1}`,
      digest: workDigest(`${prefix}:selected-input:${index + 1}`),
      disposition,
    }));
  }

  function job(
    requestId: string,
    route: SimulatedWorkJob["route"],
    selected: SimulatedWorkItem[],
    overrides: Partial<SimulatedWorkJob> = {},
  ): SimulatedWorkJob {
    return {
      requestId,
      route,
      concurrencyKey: requestId,
      items: selected,
      expiresAt: now + 10 * 60_000,
      ...overrides,
    };
  }

  it("processes a 200-property structured export as one receipt and one aggregate without loss or duplication", async () => {
    const selected = items(200, "property");
    const result = await runWorkSimulation(broker(), [job("portfolio-batch", "structured-batch", selected)]);

    expect(result).toMatchObject({
      offline: true,
      totalItems: 200,
      evidenceItems: 200,
      heldItems: 0,
      missingItems: 0,
      duplicateItems: 0,
      admittedReceipts: 1,
      aggregationBatches: 1,
      maxConcurrentTotal: 1,
      receiptStates: { reconciled: 1 },
    });
    expect(result.outcomes.map((item) => item.id)).toEqual(selected.map((item) => item.id));
    expect(durableBodies.join("\n")).not.toContain("property-1");
    expect(durableBodies.at(-1)).toContain(workDigest("property:selected-input:1"));
  });

  it("partitions selected document analysis across two local lanes and retries one safe read without dropping a result", async () => {
    const selected = items(12, "document", "draft");
    const partitions = partitionSimulationItems(selected, 1);
    const jobs = partitions.map((partition, index) => job(
      `analysis-${index + 1}`,
      "local-analysis",
      partition,
      { behavior: index === 0 ? "retry-once" : "success" },
    ));
    const activeBroker = broker();
    const result = await runWorkSimulation(activeBroker, jobs);

    expect(result).toMatchObject({
      totalItems: 12,
      draftItems: 12,
      heldItems: 0,
      missingItems: 0,
      duplicateItems: 0,
      maxConcurrentAnalysis: 2,
      maxConcurrentPerSerializationKey: 1,
      aggregationBatches: 1,
    });
    expect(activeBroker.getByRequestId("analysis-1")).toMatchObject({ state: "reconciled", attempts: 2 });
  });

  it("keeps fourteen same-account portal records serial while using a second private lane for independent accounts", async () => {
    const jobs: SimulatedWorkJob[] = [
      ...items(14, "same-account").map((item, index) => job(
        `portal-a-${index + 1}`,
        "isolated-browser",
        [item],
        { concurrencyKey: "account-a", effectClass: "possible-external", allowedOrigins: ["https://portal.example.test"] },
      )),
      job("portal-b", "isolated-browser", items(1, "account-b"), {
        concurrencyKey: "account-b",
        effectClass: "possible-external",
        allowedOrigins: ["https://portal.example.test"],
      }),
      job("portal-c", "isolated-browser", items(1, "account-c"), {
        concurrencyKey: "account-c",
        effectClass: "possible-external",
        allowedOrigins: ["https://portal.example.test"],
      }),
    ];

    const result = await runWorkSimulation(broker(), jobs);
    expect(result).toMatchObject({
      totalItems: 16,
      evidenceItems: 16,
      maxConcurrentBrowsers: 2,
      maxConcurrentPerSerializationKey: 1,
      missingItems: 0,
      duplicateItems: 0,
    });
    expect(result.browserProfiles).toEqual([
      "realbud-simulated-browser-lane-1",
      "realbud-simulated-browser-lane-2",
    ]);
  });

  it("runs visible desktop work serially and holds cancellation or ambiguous effect instead of replaying it", async () => {
    const activeBroker = broker();
    const result = await runWorkSimulation(activeBroker, [
      job("cua-success", "desktop-cua", items(1, "cua-success"), {
        effectClass: "possible-external",
        concurrencyKey: "visible-desktop",
        allowedOrigins: ["https://desktop.example.test"],
      }),
      job("cua-unknown", "desktop-cua", items(1, "cua-unknown"), {
        effectClass: "possible-external",
        behavior: "effect-unknown",
        concurrencyKey: "visible-desktop",
        allowedOrigins: ["https://desktop.example.test"],
      }),
      job("cua-cancel", "desktop-cua", items(1, "cua-cancel"), {
        effectClass: "possible-external",
        behavior: "cancel-before-run",
        concurrencyKey: "visible-desktop",
        allowedOrigins: ["https://desktop.example.test"],
      }),
    ]);

    expect(result).toMatchObject({
      totalItems: 3,
      evidenceItems: 1,
      heldItems: 2,
      maxConcurrentDesktopCua: 1,
      maxConcurrentPerSerializationKey: 1,
      receiptStates: { reconciled: 1, "effect-unknown": 1, cancelled: 1 },
    });
    expect(activeBroker.getByRequestId("cua-unknown")).toMatchObject({ state: "effect-unknown", attempts: 1 });
    expect(activeBroker.getByRequestId("cua-cancel")).toMatchObject({ state: "cancelled", attempts: 0 });
  });

  it("plans an unavailable cloud request back onto complete local analysis before simulation", async () => {
    const plan = planWorkRouting({
      requestedMode: "cloud-accelerated",
      propertyCount: 100,
      analysisItemCount: 4,
      capabilities: {
        localAnalysis: true,
        scriptedBrowser: false,
        isolatedBrowserPool: false,
        desktopCua: false,
        cloudAnalysis: false,
        cloudBrowser: false,
        cloudMaxConcurrency: 0,
      },
      resources: { cpuCores: 8, freeMemoryMb: 8_192 },
    });
    const analysis = plan.lanes.find((lane) => lane.kind === "local-analysis");
    expect(plan).toMatchObject({
      selectedMode: "local-accelerated",
      boundaries: { cloudRequired: false },
    });
    expect(analysis).toMatchObject({ state: "ready", concurrency: 2, itemCount: 4 });

    const result = await runWorkSimulation(broker(), items(4, "cloud-fallback").map((item, index) => job(
      `fallback-${index + 1}`,
      "local-analysis",
      [item],
    )));
    expect(result).toMatchObject({ totalItems: 4, evidenceItems: 4, heldItems: 0, maxConcurrentAnalysis: 2 });
  });

  it("converts a failed lane to explicit holds so the aggregate still accounts for every item", async () => {
    const result = await runWorkSimulation(broker(), [
      job("analysis-ok", "local-analysis", items(2, "ok", "draft")),
      job("analysis-failed", "local-analysis", items(3, "failed", "draft"), { behavior: "fail" }),
    ]);
    expect(result).toMatchObject({
      totalItems: 5,
      draftItems: 2,
      heldItems: 3,
      missingItems: 0,
      duplicateItems: 0,
      receiptStates: { reconciled: 1, failed: 1 },
    });
  });

  it("leases only the simulation request set and leaves unrelated broker work untouched", async () => {
    const activeBroker = broker();
    activeBroker.admit(simulatedWorkPlan(job(
      "unrelated",
      "local-analysis",
      [{ id: "unrelated", digest: workDigest("unrelated-input"), disposition: "hold" }],
      { recipe: { id: "unrelated-recipe", version: 1 }, expiresAt: now + 60_000 },
    )));

    const result = await runWorkSimulation(activeBroker, [
      job("scoped-simulation", "local-analysis", items(1, "scoped")),
    ]);
    expect(result).toMatchObject({ totalItems: 1, evidenceItems: 1, receiptStates: { reconciled: 1 } });
    expect(activeBroker.getByRequestId("unrelated")?.state).toBe("queued");
  });

  it("rejects duplicate fixture identity before any receipt is admitted", async () => {
    const duplicate = items(1, "duplicate")[0]!;
    const activeBroker = broker();
    await expect(runWorkSimulation(activeBroker, [
      job("duplicate-one", "local-analysis", [duplicate]),
      job("duplicate-two", "local-analysis", [duplicate]),
    ])).rejects.toThrow(/unique across jobs/i);
    expect(activeBroker.list()).toEqual([]);
  });
});
