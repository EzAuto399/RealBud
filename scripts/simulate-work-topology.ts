import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkBroker, workDigest } from "../server/work-broker.ts";
import { planWorkRouting } from "../server/work-routing.ts";
import { runWorkSimulation, type SimulatedWorkItem, type SimulatedWorkJob } from "../server/work-simulator.ts";

const simulationDir = mkdtempSync(join(tmpdir(), "realbud-topology-simulation-"));
const brokerFile = join(simulationDir, "work-broker.json");
const now = 1_800_000_000_000;

function items(count: number, prefix: string, disposition: SimulatedWorkItem["disposition"]): SimulatedWorkItem[] {
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

try {
  const plan = planWorkRouting({
    requestedMode: "cloud-accelerated",
    propertyCount: 100,
    analysisItemCount: 12,
    browserWork: [
      ...Array.from({ length: 14 }, () => ({ accountConcurrencyKey: "account-a" })),
      { accountConcurrencyKey: "account-b" },
      { accountConcurrencyKey: "account-c" },
    ],
    desktopCuaJobs: 3,
    capabilities: {
      localAnalysis: true,
      scriptedBrowser: true,
      isolatedBrowserPool: true,
      desktopCua: true,
      cloudAnalysis: false,
      cloudBrowser: false,
      cloudMaxConcurrency: 0,
    },
    resources: { cpuCores: 8, freeMemoryMb: 8_192 },
  });

  const jobs: SimulatedWorkJob[] = [
    job("portfolio-batch", "structured-batch", items(100, "property", "evidence"), {
      concurrencyKey: "book-revision-1",
    }),
    ...items(12, "document", "draft").map((item, index) => job(
      `analysis-${index + 1}`,
      "local-analysis",
      [item],
      { behavior: index === 0 ? "retry-once" : "success" },
    )),
    ...items(14, "portal-a", "evidence").map((item, index) => job(
      `portal-a-${index + 1}`,
      "isolated-browser",
      [item],
      {
        concurrencyKey: "account-a",
        allowedOrigins: ["https://portal.example.test"],
        effectClass: "possible-external",
      },
    )),
    job("portal-b", "isolated-browser", items(1, "portal-b", "evidence"), {
      concurrencyKey: "account-b",
      allowedOrigins: ["https://portal.example.test"],
      effectClass: "possible-external",
    }),
    job("portal-c", "isolated-browser", items(1, "portal-c", "evidence"), {
      concurrencyKey: "account-c",
      allowedOrigins: ["https://portal.example.test"],
      effectClass: "possible-external",
    }),
    job("cua-success", "desktop-cua", items(1, "cua-success", "evidence"), {
      concurrencyKey: "visible-desktop",
      effectClass: "possible-external",
      allowedOrigins: ["https://desktop.example.test"],
    }),
    job("cua-unknown", "desktop-cua", items(1, "cua-unknown", "evidence"), {
      concurrencyKey: "visible-desktop",
      effectClass: "possible-external",
      behavior: "effect-unknown",
      allowedOrigins: ["https://desktop.example.test"],
    }),
    job("cua-cancel", "desktop-cua", items(1, "cua-cancel", "evidence"), {
      concurrencyKey: "visible-desktop",
      effectClass: "possible-external",
      behavior: "cancel-before-run",
      allowedOrigins: ["https://desktop.example.test"],
    }),
  ];

  const broker = new WorkBroker({ file: brokerFile, now: () => now });
  const result = await runWorkSimulation(broker, jobs);
  const reopened = new WorkBroker({ file: brokerFile, now: () => now });
  const { outcomes: _outcomes, ...summary } = result;
  const restartStates = reopened.list().reduce<Partial<Record<string, number>>>((counts, receipt) => {
    counts[receipt.state] = (counts[receipt.state] ?? 0) + 1;
    return counts;
  }, {});
  process.stdout.write(`${JSON.stringify({
    kind: "realbud.offline-topology-simulation.v1",
    plan: {
      requestedMode: plan.requestedMode,
      selectedMode: plan.selectedMode,
      cloudRequired: plan.boundaries.cloudRequired,
      lanes: plan.lanes.map((lane) => ({
        kind: lane.kind,
        itemCount: lane.itemCount,
        concurrency: lane.concurrency,
        isolation: lane.isolation,
      })),
      fallbackReasons: plan.fallbackReasons,
    },
    execution: summary,
    restartStates,
    safety: {
      networkUsed: false,
      modelUsed: false,
      personalBrowserUsed: false,
      personalHermesUsed: false,
      terminalGrantedToBud: false,
    },
  }, null, 2)}\n`);
} finally {
  rmSync(simulationDir, { recursive: true, force: true });
}
