import type { WorkRouteKind } from "../shared/contracts.ts";
import type { ExecutionAdapterTransport } from "../shared/contracts.ts";
import {
  createExecutionAdapterBinding,
  defineExecutionAdapterManifest,
  type ExecutionAdapterAttestation,
  type ExecutionAdapterEffect,
  type ExecutionAdapterOperation,
} from "./execution-adapters.ts";
import {
  type WorkAdmissionRequest,
  type WorkClaim,
  type WorkEffectClass,
  type WorkReceiptState,
  WorkBroker,
  workDigest,
} from "./work-broker.ts";
import { buildWorkPlan } from "./work-plan.ts";

const ROUTE_ORDER: WorkRouteKind[] = [
  "structured-batch",
  "local-analysis",
  "scripted-browser",
  "isolated-browser",
  "desktop-cua",
  "remote-analysis",
  "remote-browser",
];

export type SimulatedDisposition = "evidence" | "draft" | "hold";
export type SimulatedBehavior = "success" | "retry-once" | "fail" | "effect-unknown" | "cancel-before-run";

export interface SimulatedWorkItem {
  /** In-memory fixture identity. It is never passed to or persisted by the broker. */
  id: string;
  digest: string;
  disposition: SimulatedDisposition;
}

export interface SimulatedWorkJob {
  requestId: string;
  route: WorkRouteKind;
  concurrencyKey: string;
  items: SimulatedWorkItem[];
  expiresAt: number;
  bookRevision?: number;
  caseRevision?: number | null;
  allowedOrigins?: string[];
  effectClass?: WorkEffectClass;
  behavior?: SimulatedBehavior;
  recipe?: { id: string; version: number };
}

export interface SimulatedItemOutcome {
  id: string;
  disposition: SimulatedDisposition;
  receiptState: WorkReceiptState;
}

export interface WorkSimulationSummary {
  offline: true;
  totalItems: number;
  evidenceItems: number;
  draftItems: number;
  heldItems: number;
  missingItems: number;
  duplicateItems: number;
  aggregationBatches: 1;
  admittedReceipts: number;
  duplicateAdmissions: number;
  maxConcurrentTotal: number;
  maxConcurrentAnalysis: number;
  maxConcurrentBrowsers: number;
  maxConcurrentDesktopCua: number;
  maxConcurrentPerSerializationKey: number;
  browserProfiles: string[];
  receiptStates: Partial<Record<WorkReceiptState, number>>;
  outcomes: SimulatedItemOutcome[];
}

function invalid(message: string): Error {
  return Object.assign(new Error(message), { status: 400, code: "invalid-work-simulation" });
}

function validateItem(item: SimulatedWorkItem): void {
  if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 200) throw invalid("simulation item id is invalid");
  if (!/^[a-f0-9]{64}$/.test(item.digest)) throw invalid("simulation item digest is invalid");
  if (!(["evidence", "draft", "hold"] as const).includes(item.disposition)) {
    throw invalid("simulation item disposition is invalid");
  }
}

export function partitionSimulationItems(
  items: readonly SimulatedWorkItem[],
  maximumItemsPerPartition: number,
): SimulatedWorkItem[][] {
  if (!Number.isInteger(maximumItemsPerPartition) || maximumItemsPerPartition < 1 || maximumItemsPerPartition > 10_000) {
    throw invalid("simulation partition size is invalid");
  }
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const item of items) {
    validateItem(item);
    if (ids.has(item.id) || digests.has(item.digest)) throw invalid("simulation items must be unique");
    ids.add(item.id);
    digests.add(item.digest);
  }
  const partitions: SimulatedWorkItem[][] = [];
  for (let index = 0; index < items.length; index += maximumItemsPerPartition) {
    partitions.push(items.slice(index, index + maximumItemsPerPartition).map((item) => ({ ...item })));
  }
  return partitions;
}

function browserProfile(route: WorkRouteKind, slot: number): string | null {
  if (route === "isolated-browser" || route === "scripted-browser") {
    return `realbud-simulated-browser-lane-${slot + 1}`;
  }
  if (route === "remote-browser") return `remote-simulated-browser-lane-${slot + 1}`;
  return null;
}

export function simulatedWorkPlan(job: SimulatedWorkJob): WorkAdmissionRequest {
  const effectClass = job.effectClass ?? "read-only";
  const createdAt = Math.max(0, job.expiresAt - 10 * 60_000);
  const operation: ExecutionAdapterOperation = effectClass === "possible-external"
    ? "prepare-approved-fields"
    : job.route === "local-analysis" || job.route === "remote-analysis"
      ? "analyse-selected-files"
      : "browse-approved-origin";
  const effect: ExecutionAdapterEffect = effectClass === "possible-external" ? "prepare-only" : "read-only";
  const transport: ExecutionAdapterTransport = job.route === "local-analysis"
    ? "isolated-task"
    : job.route === "remote-analysis" || job.route === "remote-browser"
      ? "remote-lane"
      : job.route === "desktop-cua"
        ? "bounded-cua"
        : "private-browser";
  const route = job.route;
  const adapter = route === "structured-batch"
    ? undefined
    : (() => {
        const manifest = defineExecutionAdapterManifest({
          kind: "realbud.execution-adapter.v1",
          schemaVersion: 1,
          id: `sim-${route}-${effect}`,
          version: 1,
          label: `Simulated ${route}`,
          method: "Offline simulation",
          transport,
          route,
          operations: [operation],
          effect,
          requiresNamedAccount: transport === "private-browser" || transport === "bounded-cua" || transport === "remote-lane",
          requiresExplicitOptIn: transport === "private-browser" || transport === "bounded-cua" || transport === "remote-lane",
          runtimeAvailable: true,
          maxConcurrency: Math.min(1, brokerRouteMaximum(route)),
        });
        const attestation: ExecutionAdapterAttestation = {
          kind: "realbud.execution-adapter-attestation.v1",
          schemaVersion: 1,
          adapterId: manifest.id,
          adapterVersion: manifest.version,
          configurationGeneration: 1,
          state: "ready",
          observedAt: createdAt,
          expiresAt: job.expiresAt,
          policyDigest: workDigest(`simulation-policy:${route}:${effect}`),
          ...(manifest.requiresNamedAccount ? { accountIdentityDigest: workDigest(`simulation-account:${job.concurrencyKey}`) } : {}),
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
        return createExecutionAdapterBinding({ manifest, attestation, operation, now: createdAt });
      })();
  const inputDigest = workDigest(JSON.stringify(job.items.map((item) => item.digest)));
  return buildWorkPlan({
    requestId: job.requestId,
    createdAt,
    expiresAt: job.expiresAt,
    bookRevision: job.bookRevision ?? 1,
    caseRevision: job.caseRevision ?? null,
    inputDigests: job.items.map((item) => item.digest),
    dataClasses: route === "structured-batch"
      ? ["portfolio-records"]
      : route === "local-analysis" || route === "remote-analysis"
        ? ["selected-files"]
        : effectClass === "possible-external"
          ? ["portal-form-fields"]
          : ["bank-credit-metadata"],
    routes: [{ route, ...(adapter ? { adapter } : {}) }],
    concurrencyKey: job.concurrencyKey,
    allowedOrigins: job.allowedOrigins,
    recipe: job.recipe ?? { id: `simulate-${job.route}`, version: 1 },
    effectClass,
    authority: effectClass === "possible-external" || route === "remote-analysis" || route === "remote-browser"
      ? { kind: "allow-decision", actionId: job.requestId, actionRevision: job.bookRevision ?? 1, actionDigest: inputDigest }
      : { kind: "user-request", requestId: job.requestId, requestDigest: inputDigest },
  });
}

function brokerRouteMaximum(route: WorkRouteKind): number {
  if (route === "remote-analysis" || route === "remote-browser") return 8;
  if (route === "local-analysis" || route === "isolated-browser") return 2;
  return 1;
}

function outputDigest(job: SimulatedWorkJob): string {
  return workDigest(JSON.stringify(job.items.map((item) => [item.digest, item.disposition])));
}

async function executeClaim(
  broker: WorkBroker,
  claim: WorkClaim,
  job: SimulatedWorkJob,
): Promise<void> {
  broker.start(claim);
  await Promise.resolve();
  const behavior = job.behavior ?? "success";
  if (behavior === "retry-once" && claim.receipt.attempts === 1) {
    broker.fail(claim, { code: "simulated-transient", retryable: true });
    return;
  }
  if (behavior === "fail") {
    broker.fail(claim, { code: "simulated-failure", retryable: false });
    return;
  }
  if (behavior === "effect-unknown") {
    broker.markEffectBoundary(claim);
    broker.fail(claim, { code: "simulated-ambiguous-ack", retryable: false });
    return;
  }
  if (job.effectClass === "possible-external") broker.markEffectBoundary(claim);
  const digest = outputDigest(job);
  const ready = broker.complete(claim, digest);
  broker.reconcile(ready.id, digest);
}

/**
 * Runs the route topology without network, browser, desktop or model access.
 * The broker sees digests and bounded metadata only; fixture contents and item
 * identities remain in this in-memory harness.
 */
export async function runWorkSimulation(
  broker: WorkBroker,
  jobs: readonly SimulatedWorkJob[],
): Promise<WorkSimulationSummary> {
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 2_000) throw invalid("simulation job count is invalid");
  const requestIds = new Set<string>();
  const itemIds = new Set<string>();
  const itemDigests = new Set<string>();
  for (const job of jobs) {
    if (requestIds.has(job.requestId)) throw invalid("simulation request ids must be unique");
    requestIds.add(job.requestId);
    if (!Array.isArray(job.items) || job.items.length < 1) throw invalid("simulation job has no items");
    if (broker.routeCapacity(job.route) < 1) throw invalid("simulation route is gated");
    if (job.behavior === "effect-unknown" && job.effectClass !== "possible-external") {
      throw invalid("unknown-effect simulation requires a possible external effect boundary");
    }
    for (const item of job.items) {
      validateItem(item);
      if (itemIds.has(item.id) || itemDigests.has(item.digest)) throw invalid("simulation items must be unique across jobs");
      itemIds.add(item.id);
      itemDigests.add(item.digest);
    }
  }

  const admissions = broker.admitBatch(jobs.map(simulatedWorkPlan));
  const jobByRequest = new Map(jobs.map((job) => [job.requestId, job]));
  for (const admission of admissions) {
    const job = jobByRequest.get(admission.receipt.requestId)!;
    if ((job.behavior ?? "success") === "cancel-before-run") {
      broker.cancel(admission.receipt.id, admission.receipt.cancellationGeneration);
    }
  }

  let maxConcurrentTotal = 0;
  let maxConcurrentAnalysis = 0;
  let maxConcurrentBrowsers = 0;
  let maxConcurrentDesktopCua = 0;
  let maxConcurrentPerSerializationKey = 0;
  const profiles = new Set<string>();
  const maximumWaves = jobs.length * 5 + 10;

  for (let wave = 0; wave < maximumWaves; wave += 1) {
    const claims: Array<{ claim: WorkClaim; job: SimulatedWorkJob; route: WorkRouteKind; slot: number }> = [];
    for (const route of ROUTE_ORDER) {
      const capacity = broker.routeCapacity(route);
      for (let slot = 0; slot < capacity; slot += 1) {
        const claim = broker.leaseNext({
          runnerId: `sim-${route}-${slot + 1}`,
          routes: [route],
          requestIds: [...requestIds],
          leaseMs: 60_000,
        });
        if (!claim) break;
        const job = jobByRequest.get(claim.receipt.requestId);
        if (!job) throw new Error("simulation receipt lost its in-memory fixture");
        claims.push({ claim, job, route, slot });
        const profile = browserProfile(route, slot);
        if (profile) profiles.add(profile);
      }
    }

    if (claims.length === 0) {
      const pending = broker.list().filter((receipt) =>
        requestIds.has(receipt.requestId) && ["queued", "leased", "running"].includes(receipt.state)
      );
      if (pending.length > 0) throw new Error("simulation stalled with pending work");
      break;
    }

    maxConcurrentTotal = Math.max(maxConcurrentTotal, claims.length);
    maxConcurrentAnalysis = Math.max(
      maxConcurrentAnalysis,
      claims.filter(({ route }) => route === "local-analysis" || route === "remote-analysis").length,
    );
    maxConcurrentBrowsers = Math.max(
      maxConcurrentBrowsers,
      claims.filter(({ route }) => route === "scripted-browser" || route === "isolated-browser" || route === "remote-browser").length,
    );
    maxConcurrentDesktopCua = Math.max(
      maxConcurrentDesktopCua,
      claims.filter(({ route }) => route === "desktop-cua").length,
    );
    const activeByKey = new Map<string, number>();
    for (const { job } of claims) activeByKey.set(job.concurrencyKey, (activeByKey.get(job.concurrencyKey) ?? 0) + 1);
    maxConcurrentPerSerializationKey = Math.max(maxConcurrentPerSerializationKey, ...activeByKey.values());

    await Promise.all(claims.map(({ claim, job }) => executeClaim(broker, claim, job)));
  }

  const receipts = broker.list().filter((receipt) => requestIds.has(receipt.requestId));
  const byRequest = new Map(receipts.map((receipt) => [receipt.requestId, receipt]));
  const outcomes: SimulatedItemOutcome[] = [];
  const seenOutcomes = new Set<string>();
  let duplicateItems = 0;
  for (const job of jobs) {
    const receipt = byRequest.get(job.requestId);
    if (!receipt) continue;
    for (const item of job.items) {
      if (seenOutcomes.has(item.id)) duplicateItems += 1;
      seenOutcomes.add(item.id);
      outcomes.push({
        id: item.id,
        disposition: receipt.state === "reconciled" ? item.disposition : "hold",
        receiptState: receipt.state,
      });
    }
  }

  const receiptStates: Partial<Record<WorkReceiptState, number>> = {};
  for (const receipt of receipts) receiptStates[receipt.state] = (receiptStates[receipt.state] ?? 0) + 1;
  return {
    offline: true,
    totalItems: itemIds.size,
    evidenceItems: outcomes.filter((item) => item.disposition === "evidence").length,
    draftItems: outcomes.filter((item) => item.disposition === "draft").length,
    heldItems: outcomes.filter((item) => item.disposition === "hold").length,
    missingItems: itemIds.size - seenOutcomes.size,
    duplicateItems,
    aggregationBatches: 1,
    admittedReceipts: admissions.filter((item) => !item.duplicate).length,
    duplicateAdmissions: admissions.filter((item) => item.duplicate).length,
    maxConcurrentTotal,
    maxConcurrentAnalysis,
    maxConcurrentBrowsers,
    maxConcurrentDesktopCua,
    maxConcurrentPerSerializationKey,
    browserProfiles: [...profiles].sort(),
    receiptStates,
    outcomes,
  };
}
